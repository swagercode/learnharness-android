import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON, packageHash, sessionRecords, type SessionPackage } from "../src/store/session-sync.ts";
import { encodePairing } from "../src/server/sync/client.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-runtime-"));
const previousData = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = root;
const originalFetch = globalThis.fetch;
const { configureSync, syncStatus, runSessionSync } = await import("../src/server/session-sync.ts");
const { chatStore } = await import("../src/store/chats.ts");
const connection = { url: "https://mac.tailnet-test.ts.net:47823", token: "b".repeat(64), hostId: randomUUID() };
const item: SessionPackage = { version: 1, chat: { id: "chat_remote", title: "Remote", createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [] }, jobs: [] };
after(async () => {
	await configureSync({ action: "disconnect" });
	globalThis.fetch = originalFetch;
	if (previousData === undefined) delete process.env.LH_DATA_DIR; else process.env.LH_DATA_DIR = previousData;
	fs.rmSync(root, { recursive: true, force: true });
});
test("client configuration persists privately and status never exposes the pairing token", async () => {
	assert.equal((await syncStatus()).mode, "off");
	globalThis.fetch = async () => Response.json({ version: 1, hostId: connection.hostId, sessions: [] });
	await configureSync({ action: "connect", code: encodePairing(connection) });
	await runSessionSync();
	const status = await syncStatus();
	assert.equal(status.mode, "client"); assert(status.lastSync);
	assert(!JSON.stringify(status).includes(connection.token));
	const file = path.join(root, "sync-private/config.json");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hostId, connection.hostId);
	await configureSync({ action: "disconnect" });
	assert.equal((await syncStatus()).mode, "off");
});
test("disconnect aborts an in-flight download before any import", async () => {
	let requested!: () => void;
	const downloading = new Promise<void>(resolve => { requested = resolve; });
	globalThis.fetch = async (url, options) => {
		if (String(url).endsWith("/v1/sessions")) return Response.json({ version: 1, hostId: connection.hostId, sessions: [{ id: item.chat.id, hash: packageHash(item), busy: false }] });
		requested();
		return new Promise<Response>((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
	};
	await configureSync({ action: "connect", code: encodePairing(connection) });
	await downloading;
	await configureSync({ action: "disconnect" });
	assert.equal((await syncStatus()).mode, "off");
	assert(!fs.existsSync(path.join(root, `chats/${item.chat.id}.json`)));
});
test("configuration changes serialize instead of leaving a hidden connected runtime", async () => {
	globalThis.fetch = async () => Response.json({ version: 1, hostId: connection.hostId, sessions: [] });
	await Promise.all([configureSync({ action: "connect", code: encodePairing(connection) }), configureSync({ action: "disconnect" })]);
	assert.equal((await syncStatus()).mode, "off");
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "sync-private/config.json"), "utf8")).mode, "off");
});
test("the store finishes an interrupted sync before SSR or a resumed lesson reads the chat", () => {
	atomicJSON(path.join(root, `chats/${item.chat.id}.json`), item.chat);
	const recovered = { ...item, chat: { ...item.chat, title: "Recovered before read" } };
	atomicJSON(path.join(root, `sync-private/pending/${item.chat.id}.json`), { package: recovered, remove: [] });
	assert.equal(chatStore.getChat(item.chat.id)!.title, recovered.chat.title);
	assert(!fs.existsSync(path.join(root, `sync-private/pending/${item.chat.id}.json`)));
});

test("conflicts are exposed without secrets and a chosen source is durable before upload", async () => {
	const peer = { ...connection, hostId: randomUUID() };
	const local = sessionRecords(root), remote = sessionRecords(path.join(root, "mac-fixture"));
	const phone: SessionPackage = { ...item, chat: { ...item.chat, id: "chat_choice", title: "Phone choice" } };
	const mac: SessionPackage = { ...phone, chat: { ...phone.chat, title: "Mac choice" } };
	local.apply(phone, null); remote.apply(mac, null);
	let conflictWrites = 0;
	globalThis.fetch = async (url, options) => {
		if (String(url).endsWith("/v1/sessions")) return Response.json({ version: 1, hostId: peer.hostId, sessions: remote.manifest() });
		const id = String(url).split("/").at(-1)!;
		if (options?.method === "PUT") {
			const body = JSON.parse(options.body as string);
			if (id === "chat_choice") {
				conflictWrites++;
				const saved = JSON.parse(fs.readFileSync(path.join(root, `sync-private/state-${peer.hostId}.json`), "utf8"));
				assert.equal(saved.decisions.chat_choice.source, "phone");
			}
			return Response.json({ hash: remote.apply(body.package, body.expected) });
		}
		const value = remote.snapshot(id)!;
		return Response.json({ package: value, hash: packageHash(value) });
	};
	await configureSync({ action: "connect", code: encodePairing(peer) }); await runSessionSync();
	let status = await syncStatus(); assert.equal(status.pending.length, 1); assert.equal(conflictWrites, 0);
	assert(!JSON.stringify(status).includes(peer.token));
	await configureSync({ action: "disconnect" });
	await configureSync({ action: "connect", code: encodePairing(peer) }); await runSessionSync();
	status = await syncStatus(); assert.equal(status.pending.length, 1);
	await configureSync({ action: "resolve", resolution: { ...status.pending[0], source: "phone" } });
	assert.equal(conflictWrites, 1); assert.equal((await syncStatus()).conflicts, 0);
	assert.deepEqual(remote.snapshot("chat_choice"), phone);
	await configureSync({ action: "disconnect" });
});
