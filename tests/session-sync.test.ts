import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON, packageHash, sessionRecords, SyncError, validatePackage, type SessionPackage } from "../src/store/session-sync.ts";
import { decodePairing, emptySyncState, encodePairing, remoteSessions, syncSessions, validateConnection } from "../src/server/sync/client.ts";
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
test("divergent offline edits preserve both complete branches with distinct artifact identities", async t => {
	const { left, right, remote, state, save } = setup(t);
	left.apply(fixture(), null); await syncSessions(left, remote, state, save);
	const base = state.base.chat_fixture!;
	left.apply(fixture("chat_fixture", "Phone changed"), base);
	right.apply(fixture("chat_fixture", "Mac changed"), base);
	assert.equal((await syncSessions(left, remote, state, save)).conflicts, 1);
	assert.equal(left.manifest().length, 2); assert.equal(right.manifest().length, 2);
	const copyId = left.manifest().find(r => r.id !== "chat_fixture")!.id;
	const copy = left.snapshot(copyId)!;
	assert.match(copy.chat.title, /conflict copy/);
	assert.deepEqual(copy.chat.messages, fixture("chat_fixture", "Phone changed").chat.messages);
	assert.equal(copy.jobs[0]!.chatId, copyId); assert.notEqual(copy.jobs[0]!.id, "job_fixture");
	assert.deepEqual(right.snapshot(copyId), copy);
	assert.deepEqual(left.snapshot("chat_fixture"), fixture("chat_fixture", "Mac changed"));
	assert.equal((await syncSessions(left, remote, state, save)).conflicts, 0);
});
test("interrupted conflict upload is idempotent on reconnect", async t => {
	const { left, right, remote, state, save } = setup(t);
	left.apply(fixture(), null); await syncSessions(left, remote, state, save);
	left.apply(fixture("chat_fixture", "Phone"), state.base.chat_fixture!);
	right.apply(fixture("chat_fixture", "Mac"), state.base.chat_fixture!);
	let interrupted = false;
	await assert.rejects(syncSessions(left, { ...remote, put: async (item, expected) => {
		const result = await remote.put(item, expected);
		if (!interrupted) { interrupted = true; throw new Error("lost acknowledgment"); }
		return result;
	} }, state, save));
	await syncSessions(left, remote, state, save);
	assert.equal(left.manifest().length, 2); assert.equal(right.manifest().length, 2);
	assert.deepEqual(left.snapshot("chat_fixture"), right.snapshot("chat_fixture"));
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
test("first pairing with colliding IDs preserves both copies", async t => {
	const { left, right, remote, state, save } = setup(t);
	left.apply(fixture("chat_fixture", "Phone"), null); right.apply(fixture("chat_fixture", "Mac"), null);
	assert.equal((await syncSessions(left, remote, state, save)).conflicts, 1);
	assert.equal(left.manifest().length, 2);
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
	const connection = { url: "http://100.100.100.100:47823", token: "a".repeat(64), hostId: randomUUID() };
	assert.deepEqual(decodePairing(encodePairing(connection)), connection);
	for (const url of ["http://127.0.0.1:47823", "http://192.168.1.1:47823", "http://example.com:47823", "http://100.63.1.1:47823", "http://100.128.1.1:47823", "http://100.100.100.100:47823/path", "http://100.100.100.100:47823/?secret=x"])
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
