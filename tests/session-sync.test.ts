import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON, packageHash, sessionRecords, SyncError, validatePackage, type SessionPackage } from "../src/store/session-sync.ts";
import { chooseSyncSource, decodePairing, emptySyncState, encodePairing, isTailnetIPv4, remoteSessions, syncSessions, validateConnection } from "../src/server/sync/client.ts";
import { syncHost } from "../src/server/sync/host.ts";

function fixture(id = "chat_fixture", text = "Original", jobs = true): SessionPackage {
	return { version: 1, chat: { id, version: 1, title: "Learning", createdAt: "2026-01-01", updatedAt: "2026-01-01", settings: { model: { provider: "chatgpt", id: "gpt-6-astra" }, fastMode: true }, messages: [{ id: "message_fixture", role: "user", content: text, timestamp: 1 }] }, jobs: jobs ? [{ id: "job_fixture", chatId: id, kind: "demo", toolCallId: "call_demo", status: "done", activity: "Ready", createdAt: "2026-01-01", updatedAt: "2026-01-01", result: { html: "<p>Demo</p>" } }] : [] };
}
function setup(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const left = sessionRecords(path.join(dir, "left")), right = sessionRecords(path.join(dir, "right"));
	const remote = { manifest: async () => right.manifest(), get: async (id: string) => right.snapshot(id)!, put: async (item: SessionPackage, expected: string | null) => right.apply(item, expected) };
	return { dir, left, right, remote, state: emptySyncState(), save: () => {} };
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
async function divergence(t: TestContext) {
	const data = setup(t);
	data.left.apply(fixture(), null); await syncSessions(data.left, data.remote, data.state, data.save);
	const phone = fixture("chat_fixture", "Phone changed"), mac = fixture("chat_fixture", "Mac changed");
	phone.jobs[0]!.result = { html: "<p>Phone demo</p>" }; mac.jobs[0]!.result = { html: "<p>Mac demo</p>" };
	data.left.apply(phone, data.state.base.chat_fixture!); data.right.apply(mac, data.state.base.chat_fixture!);
	await syncSessions(data.left, data.remote, data.state, data.save);
	return { ...data, phone, mac };
}
function choose(state: ReturnType<typeof emptySyncState>, source: "mac" | "phone") {
	chooseSyncSource(state, { ...state.pending!.chat_fixture, source });
}
test("divergent edits wait unchanged for a choice while unrelated sessions keep syncing", async t => {
	const { left, right, remote, state, save, phone, mac } = await divergence(t);
	left.apply(fixture("chat_unrelated", "Another lesson", false), null);
	const result = await syncSessions(left, remote, state, save);
	assert.equal(result.conflicts, 1); assert.equal(result.uploaded, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), phone); assert.deepEqual(right.snapshot("chat_fixture"), mac);
	assert.equal(left.manifest().length, 2); assert.equal(right.manifest().length, 2);
	const restored = JSON.parse(JSON.stringify(state));
	assert.equal((await syncSessions(left, remote, restored, save)).conflicts, 1);
	assert.equal(Object.keys(restored.pending).length, 1);
	assert.equal(restored.pending.chat_fixture.localHash, packageHash(phone));
});
for (const source of ["mac", "phone"] as const) test(`choosing ${source} replaces only the conflicting session and keeps a private recovery copy`, async t => {
	const { dir, left, right, remote, state, save, phone, mac } = await divergence(t);
	choose(state, source);
	assert.equal((await syncSessions(left, remote, state, save)).conflicts, 0);
	const winner = source === "mac" ? mac : phone, previous = source === "mac" ? phone : mac;
	assert.deepEqual(left.snapshot("chat_fixture"), winner); assert.deepEqual(right.snapshot("chat_fixture"), winner);
	assert.equal(left.manifest().length, 1); assert.equal(right.manifest().length, 1);
	assert.deepEqual(state.pending, {}); assert.deepEqual(state.decisions, {});
	assert.equal(state.base.chat_fixture, packageHash(winner));
	const history = path.join(dir, source === "mac" ? "left" : "right", "sync-private/history/chat_fixture", `${packageHash(previous)}.json`);
	assert.deepEqual(JSON.parse(fs.readFileSync(history, "utf8")), previous);
});
test("invalid or stale UI choices are rejected without recording a decision", async t => {
	const { state } = await divergence(t);
	assert.throws(() => chooseSyncSource(state, { ...state.pending!.chat_fixture, source: "automatic" }), /Choose/);
	assert.throws(() => chooseSyncSource(state, { ...state.pending!.chat_fixture, source: "mac", localHash: "a".repeat(64) }), /changed/);
	assert.throws(() => chooseSyncSource(state, { ...state.pending!.chat_fixture, source: "phone", id: "chat_other" }), /changed/);
	assert.deepEqual(state.decisions, {});
});
for (const source of ["mac", "phone"] as const) test(`a newer ${source === "mac" ? "phone" : "Mac"} edit invalidates the saved ${source} choice`, async t => {
	const { left, right, remote, state, save, phone, mac } = await divergence(t);
	choose(state, source);
	const edited = fixture("chat_fixture", "New work after the choice");
	if (source === "mac") left.apply(edited, packageHash(phone)); else right.apply(edited, packageHash(mac));
	assert.equal((await syncSessions(left, remote, state, save)).conflicts, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), source === "mac" ? edited : phone);
	assert.deepEqual(right.snapshot("chat_fixture"), source === "mac" ? mac : edited);
	assert.deepEqual(state.decisions, {});
});
test("selected Mac download cannot overwrite a phone edit made during the request", async t => {
	const { left, right, remote, state, save, phone, mac } = await divergence(t);
	choose(state, "mac");
	const edited = fixture("chat_fixture", "Typing during download");
	assert.equal((await syncSessions(left, { ...remote, get: async id => {
		left.apply(edited, packageHash(phone)); return remote.get(id);
	} }, state, save)).deferred, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), edited); assert.deepEqual(right.snapshot("chat_fixture"), mac);
});
test("selected phone upload cannot overwrite a Mac edit made during the request", async t => {
	const { left, right, remote, state, save, phone, mac } = await divergence(t);
	choose(state, "phone");
	const edited = fixture("chat_fixture", "Mac work during upload");
	assert.equal((await syncSessions(left, { ...remote, put: async (item, expected) => {
		right.apply(edited, packageHash(mac)); return remote.put(item, expected);
	} }, state, save)).deferred, 1);
	assert.deepEqual(left.snapshot("chat_fixture"), phone); assert.deepEqual(right.snapshot("chat_fixture"), edited);
	await syncSessions(left, remote, state, save);
	assert.deepEqual(state.decisions, {}); assert(state.pending!.chat_fixture);
});
test("approved upload retries after a lost acknowledgement without duplicates or losing later phone edits", async t => {
	const { left, right, remote, state, save, phone } = await divergence(t);
	choose(state, "phone");
	const durable = JSON.parse(JSON.stringify(state));
	await assert.rejects(syncSessions(left, { ...remote, put: async (item, expected) => {
		await remote.put(item, expected); throw new Error("lost acknowledgment");
	} }, state, save), /lost acknowledgment/);
	const edited = fixture("chat_fixture", "New phone work after upload");
	left.apply(edited, packageHash(phone));
	await syncSessions(left, remote, durable, save);
	assert.deepEqual(left.snapshot("chat_fixture"), edited); assert.deepEqual(right.snapshot("chat_fixture"), edited);
	assert.equal(left.manifest().length, 1); assert.equal(right.manifest().length, 1);
	assert.deepEqual(durable.pending, {});
});
test("an approved choice persists through failure before the transfer and retries safely", async t => {
	const { left, right, remote, state, save, mac } = await divergence(t);
	choose(state, "mac");
	await assert.rejects(syncSessions(left, { ...remote, get: async () => { throw new Error("offline"); } }, state, save), /offline/);
	const restarted = JSON.parse(JSON.stringify(state));
	await syncSessions(left, remote, restarted, save);
	assert.deepEqual(left.snapshot("chat_fixture"), mac); assert.deepEqual(right.snapshot("chat_fixture"), mac);
	assert.deepEqual(restarted.pending, {});
});
test("an imported Mac choice recovers its common revision after a process exit before state save", async t => {
	const { left, right, remote, state, mac } = await divergence(t);
	choose(state, "mac"); const durable = JSON.parse(JSON.stringify(state));
	await assert.rejects(syncSessions(left, remote, state, () => { throw new Error("disk interrupted"); }), /disk interrupted/);
	assert.deepEqual(left.snapshot("chat_fixture"), mac);
	const newer = fixture("chat_fixture", "Mac advanced after restart"); right.apply(newer, packageHash(mac));
	await syncSessions(left, remote, durable, () => {});
	assert.deepEqual(left.snapshot("chat_fixture"), newer); assert.deepEqual(durable.pending, {});
});
test("v17 state and existing conflict-copy sessions survive migration", async t => {
	const { left, right, remote, save } = setup(t);
	const old = { base: {}, ignored: [], conflicts: { "legacy:hash": "chat_oldcopy" } };
	left.apply(fixture("chat_oldcopy", "An existing v17 conflict copy", false), null);
	await syncSessions(left, remote, old, save);
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
test("first pairing with colliding IDs waits for a source choice", async t => {
	const { left, right, remote, state, save } = setup(t);
	left.apply(fixture("chat_fixture", "Phone"), null); right.apply(fixture("chat_fixture", "Mac"), null);
	assert.equal((await syncSessions(left, remote, state, save)).conflicts, 1);
	assert.equal(left.manifest().length, 1); assert.equal(right.manifest().length, 1);
	assert(state.pending!.chat_fixture);
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
