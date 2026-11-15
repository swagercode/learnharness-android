import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON, packageHash, sessionRecords, SyncError, validatePackage, type SessionPackage } from "../src/store/session-sync.ts";
import { decodePairing, emptySyncState, encodePairing, isTailnetIPv4, latestSource, remoteSessions, syncSessions, validateConnection } from "../src/server/sync/client.ts";
import { SyncWakeups } from "../src/server/sync/wakeups.ts";
import { syncHost } from "../src/server/sync/host.ts";

function fixture(id = "chat_fixture", text = "Original", jobs = true): SessionPackage {
	return { version: 1, chat: { id, version: 1, title: "Learning", createdAt: "2026-01-01", updatedAt: "2026-01-01", settings: { model: { provider: "chatgpt", id: "gpt-6-astra" }, fastMode: true }, messages: [{ id: "message_fixture", role: "user", content: text, timestamp: 1 }] }, jobs: jobs ? [{ id: "job_fixture", chatId: id, kind: "demo", toolCallId: "call_demo", status: "done", activity: "Ready", createdAt: "2026-01-01", updatedAt: "2026-01-01", result: { html: "<p>Demo</p>" } }] : [] };
}
function setup(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const left = sessionRecords(path.join(dir, "left")), right = sessionRecords(path.join(dir, "right"));
	const remote = { manifest: async () => right.manifest(), get: async (id: string) => right.snapshot(id)!, put: async (item: SessionPackage, expected: string | null) => right.apply(item, expected) };
	return { dir, left, right, remote, state: emptySyncState("phone"), save: () => {} };
}
test("two-way sync preserves lessons, Fast preference and finished demo artifacts", async t => {
	const { dir, left, right, remote, state, save } = setup(t);
	left.apply(fixture(), null);
	atomicJSON(path.join(dir, "left", "auth.json"), { secret: "must-not-sync" });
	atomicJSON(path.join(dir, "left", "settings.json"), { local: true });
	assert.equal((await syncSessions(left, remote, state, save)).uploaded, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), right.snapshot("chat_fixture"));
	assert(!fs.existsSync(path.join(dir, "right", "auth.json")));
	assert(!fs.existsSync(path.join(dir, "right", "settings.json")));
	const next = fixture("chat_fixture", "Mac continuation"); right.apply(next, state.base.chat_fixture!);
	assert.equal((await syncSessions(left, remote, state, save)).downloaded, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), next);
	const phone = fixture("chat_fixture", "Phone continuation"); left.apply(phone, packageHash(next));
	assert.equal((await syncSessions(left, remote, state, save)).uploaded, 1);
	assert.deepEqual(right.snapshot("chat_fixture"), phone);
	assert.equal((await syncSessions(left, remote, state, save)).uploaded, 0);
});
test("first sync favors the phone for shared IDs and copies unique sessions both ways", async t => {
	const { left, right, remote, state, save } = setup(t);
	const phone = fixture("chat_shared", "Phone first", false), mac = fixture("chat_shared", "Mac newer clock", false);
	mac.chat.updatedAt = "2026-11-15T12:00:00Z";
	left.apply(phone, null); right.apply(mac, null);
	left.apply(fixture("chat_phone_only", "Phone only", false), null);
	right.apply(fixture("chat_mac_only", "Mac only", false), null);
	const result = await syncSessions(left, remote, state, save);
	assert.equal(result.uploaded, 2); assert.equal(result.downloaded, 1); assert(state.initial?.complete);
	assert.deepEqual(right.snapshot("chat_shared"), phone);
	assert.equal(left.manifest().length, 3); assert.equal(right.manifest().length, 3);
});
for (const source of ["mac", "phone"] as const) test(`first sync can use ${source} and resumes the saved preference after failure`, async t => {
	const { left, right, remote, save } = setup(t), state = emptySyncState(source);
	const phone = fixture("chat_fixture", "Phone"), mac = fixture("chat_fixture", "Mac");
	left.apply(phone, null); right.apply(mac, null);
	await assert.rejects(syncSessions(left, { ...remote, get: async () => { throw Error("offline"); }, put: async () => { throw Error("offline"); } }, state, save), /offline/);
	const restored = JSON.parse(JSON.stringify(state));
	await syncSessions(left, remote, restored, save);
	assert.deepEqual(left.snapshot("chat_fixture"), source === "phone" ? phone : mac);
	assert.deepEqual(left.snapshot("chat_fixture"), right.snapshot("chat_fixture"));
	assert(restored.initial.complete);
});
test("offline divergence chooses the newer version separately for each session and backs up replaced work", async t => {
	const { dir, left, right, remote, state, save } = setup(t);
	for (const id of ["chat_a", "chat_b"]) left.apply(fixture(id, "Original", false), null);
	await syncSessions(left, remote, state, save);
	for (const id of ["chat_a", "chat_b"]) {
		const phone = fixture(id, "Phone", false), mac = fixture(id, "Mac", false);
		phone.chat.updatedAt = id === "chat_a" ? "2026-11-15T12:00:00Z" : "2026-11-15T11:00:00Z";
		mac.chat.updatedAt = id === "chat_b" ? "2026-11-15T12:00:00Z" : "2026-11-15T11:00:00Z";
		left.apply(phone, state.base[id]!); right.apply(mac, state.base[id]!);
	}
	const previous = left.snapshot("chat_b")!;
	const result = await syncSessions(left, remote, state, save);
	assert.equal(result.uploaded, 1); assert.equal(result.downloaded, 1);
	assert.equal(left.snapshot("chat_a")!.chat.messages[0]!.content, "Phone");
	assert.equal(left.snapshot("chat_b")!.chat.messages[0]!.content, "Mac");
	for (const id of ["chat_a", "chat_b"]) assert.deepEqual(left.snapshot(id), right.snapshot(id));
	assert.equal(left.manifest().length, 2); assert.equal(right.manifest().length, 2);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "left/sync-private/history/chat_b", `${packageHash(previous)}.json`), "utf8")), previous);
});
test("edit timestamps include renames/settings and finished artifacts; exact ties use the first source", () => {
	const phone = fixture(), mac = fixture();
	assert.equal(latestSource(phone, mac, "phone"), "phone"); assert.equal(latestSource(phone, mac, "mac"), "mac");
	phone.chat.syncUpdatedAt = "2026-11-15T10:00:00Z"; assert.equal(latestSource(phone, mac, "mac"), "phone");
	mac.jobs[0]!.updatedAt = "2026-11-15T11:00:00Z"; assert.equal(latestSource(phone, mac, "phone"), "mac");
});
test("a Mac edit during phone upload is deferred instead of overwritten", async t => {
	const { left, right, remote, state, save } = setup(t);
	left.apply(fixture(), null); await syncSessions(left, remote, state, save);
	const next = fixture("chat_fixture", "Phone next"), concurrent = fixture("chat_fixture", "Concurrent Mac edit");
	left.apply(next, state.base.chat_fixture!);
	const result = await syncSessions(left, { ...remote, put: async (item, expected) => {
		right.apply(concurrent, expected); return remote.put(item, expected);
	} }, state, save);
	assert.equal(result.deferred, 1); assert.deepEqual(right.snapshot("chat_fixture"), concurrent); assert.deepEqual(left.snapshot("chat_fixture"), next);
});
test("a lost upload acknowledgement recovers without duplicate sessions", async t => {
	const { left, right, remote, state, save } = setup(t);
	left.apply(fixture(), null);
	await assert.rejects(syncSessions(left, { ...remote, put: async (item, expected) => {
		await remote.put(item, expected); throw Error("lost acknowledgement");
	} }, state, save), /lost acknowledgement/);
	await syncSessions(left, remote, JSON.parse(JSON.stringify(state)), save);
	assert.equal(left.manifest().length, 1); assert.equal(right.manifest().length, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), right.snapshot("chat_fixture"));
});
test("v17 migration waits for the one-time source and preserves existing conflict copies", async t => {
	const { left, right, remote, save } = setup(t);
	const old = { ...emptySyncState(), conflicts: { "legacy:hash": "chat_oldcopy" } };
	left.apply(fixture("chat_oldcopy", "An existing v17 conflict copy", false), null);
	await syncSessions(left, remote, old, save); assert.equal(right.manifest().length, 0);
	old.initial = { source: "phone" }; await syncSessions(left, remote, old, save);
	assert.deepEqual(left.snapshot("chat_oldcopy"), right.snapshot("chat_oldcopy"));
	assert.deepEqual(old.conflicts, { "legacy:hash": "chat_oldcopy" });
});
test("stale network responses cannot overwrite local edits made during download", async t => {
	const { left, right, remote, state, save } = setup(t);
	left.apply(fixture(), null); await syncSessions(left, remote, state, save);
	right.apply(fixture("chat_fixture", "Mac"), state.base.chat_fixture!);
	const result = await syncSessions(left, { ...remote, get: async id => {
		left.apply(fixture("chat_fixture", "New phone edit"), state.base.chat_fixture!);
		return remote.get(id);
	} }, state, save);
	assert.equal(result.deferred, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), fixture("chat_fixture", "New phone edit"));
});
test("active turns and pending artifacts defer sync", t => {
	const { dir, left } = setup(t); left.apply(fixture(), null);
	const busy = sessionRecords(path.join(dir, "left"), () => true);
	assert.equal(busy.manifest()[0]!.busy, true);
	assert.throws(() => busy.apply(fixture(), packageHash(fixture())), (e: unknown) => e instanceof SyncError && e.status === 423);
	atomicJSON(path.join(dir, "left/jobs/job_fixture.json"), { ...fixture().jobs[0], delivery: { kind: "result", status: "pending" } });
	assert.equal(left.manifest()[0]!.busy, true);
});
test("deleting a local session does not delete the Mac copy or resurrect it locally", async t => {
	const { dir, left, right, remote, state, save } = setup(t);
	left.apply(fixture(), null); await syncSessions(left, remote, state, save);
	fs.unlinkSync(path.join(dir, "left/chats/chat_fixture.json"));
	await syncSessions(left, remote, state, save);
	assert.equal(left.snapshot("chat_fixture"), null); assert(right.snapshot("chat_fixture"));
	assert(state.ignored.includes("chat_fixture"));
});
test("schema, path, job ownership and symlink guards preserve local records", t => {
	const { dir, left } = setup(t); left.apply(fixture(), null);
	assert.throws(() => validatePackage({ ...fixture(), chat: { ...fixture().chat, id: "../escape" } }));
	assert.throws(() => validatePackage({ ...fixture(), chat: { ...fixture().chat, version: 99 } }));
	assert.throws(() => validatePackage({ ...fixture(), jobs: [{ ...fixture().jobs[0], chatId: "chat_other" }] }));
	assert.throws(() => left.apply(fixture("chat_other"), null), /another session/);
	fs.mkdirSync(path.join(dir, "linked"));
	fs.symlinkSync(path.join(dir, "left/chats"), path.join(dir, "linked/chats"));
	assert.throws(() => sessionRecords(path.join(dir, "linked")).manifest(), /linked/);
	assert.deepEqual(left.snapshot("chat_fixture"), fixture());
});
test("interrupted multi-file import rolls forward from its private journal", t => {
	const { dir, left } = setup(t); left.apply(fixture(), null);
	const incoming = fixture("chat_fixture", "Recovered");
	atomicJSON(path.join(dir, "left/sync-private/pending/chat_fixture.json"), { package: incoming, remove: [] });
	const restarted = sessionRecords(path.join(dir, "left"));
	assert.deepEqual(restarted.snapshot("chat_fixture"), incoming);
	assert(!fs.existsSync(path.join(dir, "left/sync-private/pending/chat_fixture.json")));
});
test("pairing only accepts private Tailscale addresses and round-trips the secret", () => {
	const connection = { url: "https://mac.tailnet-test.ts.net:47823", token: "a".repeat(64), hostId: randomUUID() };
	assert.deepEqual(decodePairing(encodePairing(connection)), connection);
	for (const url of ["http://mac.tailnet-test.ts.net:47823", "https://mac.tailnet-test.ts.net.evil.com:47823", "https://example.com:47823", "https://100.100.100.100:47823", "https://mac.tailnet-test.ts.net", "https://user@mac.tailnet-test.ts.net:47823", "http://127.0.0.1:47823", "http://192.168.1.1:47823", "http://example.com:47823", "http://100.63.1.1:47823", "http://100.128.1.1:47823", "https://mac.tailnet-test.ts.net:47823/path", "https://mac.tailnet-test.ts.net:47823/?secret=x"])
		assert.throws(() => validateConnection({ ...connection, url }));
});
test("real HTTP sync requires pairing, rejects browser requests, enforces CAS and round-trips artifacts", async t => {
	const { right } = setup(t);
	const token = "a".repeat(64), hostId = randomUUID();
	const server = syncHost(right, token, hostId);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	assert.equal((await fetch(`${url}/v1/sessions`)).status, 401);
	assert.equal((await fetch(`${url}/v1/sessions`, { headers: { Authorization: `Bearer ${token}`, Origin: "https://example.com" } })).status, 403);
	const remote = remoteSessions({ url, token, hostId }, new AbortController().signal);
	assert.deepEqual(await remote.manifest(), []);
	const hash = await remote.put(fixture(), null);
	assert.equal(hash, packageHash(fixture()));
	assert.deepEqual(await remote.get("chat_fixture"), fixture());
	await assert.rejects(remote.put(fixture("chat_fixture", "Stale"), null), (e: unknown) => e instanceof SyncError && e.status === 409);
	await assert.rejects(remoteSessions({ url, token, hostId: randomUUID() }, new AbortController().signal).manifest(), /identity/);
});

test("MagicDNS fallback rejects destinations outside the Tailscale address range", () => {
	for (const ip of ["100.64.0.1", "100.127.255.254"]) assert(isTailnetIPv4(ip));
	for (const ip of ["127.0.0.1", "192.168.1.1", "100.63.0.1", "100.128.0.1", "100.100.1.999", "example.com"]) assert(!isTailnetIPv4(ip));
});

test("Mac pre-edit request waits for the phone acknowledgement, with a bounded offline fallback", async t => {
	const { right } = setup(t), wakeups = new SyncWakeups(100, 100);
	const token = "b".repeat(64), hostId = randomUUID(), server = syncHost(right, token, hostId, () => {}, wakeups);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const remote = remoteSessions({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token, hostId }, new AbortController().signal);
	assert.equal(await wakeups.request("chat_fixture"), false);
	const poll = remote.wake(); await new Promise(resolve => setTimeout(resolve, 30));
	const ready = wakeups.request("chat_fixture");
	const requests = await poll; assert.equal(requests[0]?.chatId, "chat_fixture");
	await remote.ready(requests.map(r => r.id)); assert.equal(await ready, true);
	assert.equal(await wakeups.request("chat_offline"), false);
	wakeups.close();
});
