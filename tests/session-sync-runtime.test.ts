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
const { configureSync, syncStatus, runSessionSync, prepareSessionEdit } = await import("../src/server/session-sync.ts");
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
	globalThis.fetch = async url => Response.json({ version: 1, hostId: connection.hostId, ...(String(url).endsWith("/v1/cleanup") ? { requests: [] } : { sessions: [] }) });
	await configureSync({ action: "connect", code: encodePairing(connection), source: "phone" });
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
		if (String(url).endsWith("/v1/cleanup")) return Response.json({ version: 1, hostId: connection.hostId, requests: [] });
		if (String(url).endsWith("/v1/sessions")) return Response.json({ version: 1, hostId: connection.hostId, sessions: [{ id: item.chat.id, hash: packageHash(item), busy: false }] });
		if (String(url).endsWith("/v1/wake")) return Response.json({ requests: [] });
		requested();
		return new Promise<Response>((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
	};
	await configureSync({ action: "connect", code: encodePairing(connection), source: "phone" });
	await downloading;
	await configureSync({ action: "disconnect" });
	assert.equal((await syncStatus()).mode, "off");
	assert(!fs.existsSync(path.join(root, `chats/${item.chat.id}.json`)));
});
test("configuration changes serialize instead of leaving a hidden connected runtime", async () => {
	globalThis.fetch = async url => Response.json({ version: 1, hostId: connection.hostId, ...(String(url).endsWith("/v1/cleanup") ? { requests: [] } : { sessions: [] }) });
	await Promise.all([configureSync({ action: "connect", code: encodePairing(connection), source: "phone" }), configureSync({ action: "disconnect" })]);
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

test("first phone source is durable before upload and cannot be changed after sync starts", async () => {
	const peer = { ...connection, hostId: randomUUID() };
	const local = sessionRecords(root), remote = sessionRecords(path.join(root, "mac-fixture"));
	const phone: SessionPackage = { ...item, chat: { ...item.chat, id: "chat_choice", title: "Phone first" } };
	const mac: SessionPackage = { ...phone, chat: { ...phone.chat, title: "Mac first" } };
	local.apply(phone, null); remote.apply(mac, null);
	let sharedWrites = 0;
	globalThis.fetch = async (url, options) => {
		if (String(url).endsWith("/v1/wake")) return Response.json({ requests: [] });
		if (String(url).endsWith("/v1/cleanup")) return Response.json({ version: 1, hostId: peer.hostId, requests: [] });
		if (String(url).endsWith("/v1/sessions")) return Response.json({ version: 1, hostId: peer.hostId, sessions: remote.manifest() });
		const id = String(url).split("/").at(-1)!;
		if (options?.method === "PUT") {
			const body = JSON.parse(options.body as string);
			if (id === "chat_choice") {
				sharedWrites++;
				const saved = JSON.parse(fs.readFileSync(path.join(root, `sync-private/state-${peer.hostId}.json`), "utf8"));
				assert.equal(saved.initial.source, "phone");
			}
			return Response.json({ hash: remote.apply(body.package, body.expected) });
		}
		const value = remote.snapshot(id)!;
		return Response.json({ package: value, hash: packageHash(value) });
	};
	await configureSync({ action: "connect", code: encodePairing(peer) }); await runSessionSync();
	assert.equal((await syncStatus()).initialRequired, true); assert.equal(sharedWrites, 0);
	assert(!JSON.stringify(await syncStatus()).includes(peer.token));
	await configureSync({ action: "initial", source: "phone" }); await runSessionSync();
	assert.equal(sharedWrites, 1); assert.equal((await syncStatus()).initialComplete, true);
	assert.deepEqual(remote.snapshot("chat_choice"), phone);
	await assert.rejects(configureSync({ action: "initial", source: "mac" }), /already started/);
	await configureSync({ action: "disconnect" });
	await configureSync({ action: "connect", code: encodePairing(peer) }); await runSessionSync();
	assert.equal((await syncStatus()).initialRequired, false); assert.equal((await syncStatus()).initialSource, "phone");
	globalThis.fetch = async () => { throw Error("offline"); };
	assert.equal((await prepareSessionEdit("chat_choice")).offline, true);
	assert.deepEqual(local.snapshot("chat_choice"), phone);
	await configureSync({ action: "disconnect" });
});
test("renames receive a sync timestamp without changing sidebar activity order", () => {
	const before = chatStore.getChat("chat_choice")!;
	const renamed = chatStore.renameChat("chat_choice", "Renamed offline");
	assert.equal(renamed.updatedAt, before.updatedAt); assert(renamed.syncUpdatedAt);
	assert.equal(renamed.syncUpdatedAt, chatStore.getChat("chat_choice")!.syncUpdatedAt);
});

test("archived duplicates disappear from the app and old links resolve to the retained session", async () => {
	const local = sessionRecords(root);
	const old = { ...item, chat: { ...item.chat, id: "chat_duplicate" } };
	const kept = { ...item, chat: { ...item.chat, id: "chat_retained", title: "Retained" } };
	local.apply(old, null); local.apply(kept, null);
	local.archiveDuplicate({ version: 1, id: old.chat.id, revision: packageHash(old), replacementId: kept.chat.id, createdAt: new Date().toISOString() }, packageHash(kept));
	assert.equal(chatStore.getChat(old.chat.id), null);
	assert(!chatStore.listChats().some(chat => chat.id === old.chat.id));
	const { getChatReplacement } = await import("../src/store/chats.ts");
	assert.equal(getChatReplacement(old.chat.id), kept.chat.id);
	assert.equal(getChatReplacement("../../escape"), undefined);
	fs.unlinkSync(path.join(root, `chats/${old.chat.id}.json`));
	local.queueCleanup({ version: 1, id: old.chat.id, revision: packageHash(old), replacementId: kept.chat.id, createdAt: new Date().toISOString() });
	assert.equal(getChatReplacement(old.chat.id), kept.chat.id);
	assert.throws(() => chatStore.renameChat(old.chat.id, "Accidental resurrection"), /not found/);
});
