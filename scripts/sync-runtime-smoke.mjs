/** Integration test using a temporary tailnet HTTPS forward on port 47825 and two
 * isolated production app runtimes. No real sessions or provider credentials. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";

const hostname = process.env.LH_SYNC_TEST_HOST;
if (!hostname || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname)) throw Error("Set LH_SYNC_TEST_HOST to this Mac's Tailscale hostname; forward HTTPS 47825 to http://localhost:47825 first.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-production-"));
const connection = { url: `https://${hostname}:47825`, token: randomBytes(32).toString("hex"), hostId: randomUUID() };
const processes = new Map();
const pause = ms => new Promise(done => setTimeout(done, ms));
const folder = name => path.join(root, name, "data");
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function chat(id, title, updatedAt = "2026-01-01") { return { id, version: 1, title, createdAt: "2026-01-01", updatedAt, messages: [], settings: { model: { provider: "chatgpt", id: "gpt-6-astra" }, thinkingLevel: "low", fastMode: true } }; }
write(path.join(folder("mac"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Mac fixture"));
write(path.join(folder("phone"), "chats/chat_phone_fixture.json"), chat("chat_phone_fixture", "Phone fixture"));
write(path.join(folder("mac"), "chats/chat_shared.json"), chat("chat_shared", "Mac first"));
write(path.join(folder("phone"), "chats/chat_shared.json"), chat("chat_shared", "Phone first"));
write(path.join(folder("mac"), "sync-private/config.json"), { mode: "host", ...connection });
const ports = { mac: 3231, phone: 3232 };
async function rpc(name, body) {
	const response = await fetch(`http://127.0.0.1:${ports[name]}/api/sync`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45_000) });
	const value = await response.json(); assert(response.ok, value.error); return value;
}
async function start(name) {
	write(path.join(root, name, "auth.json"), {});
	const server = name === "mac" && process.env.LH_SYNC_TEST_MAC_SERVER ? process.env.LH_SYNC_TEST_MAC_SERVER : ".next/standalone/server.js";
	const child = spawn(process.execPath, [path.resolve(server)], { env: { ...process.env, NODE_ENV: "production", PORT: String(ports[name]), HOSTNAME: "127.0.0.1", LH_DATA_DIR: folder(name), LH_AUTH_FILE: path.join(root, name, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	processes.set(name, child); let log = "";
	child.stdout.on("data", b => { log += b; }); child.stderr.on("data", b => { log += b; });
	for (let i = 0; i < 60; i++) {
		if (child.exitCode !== null) throw Error(`${name} runtime failed: ${log.slice(-1500)}`);
		try { return await rpc(name); } catch { await pause(500); }
	}
	throw Error(`${name} runtime failed to start: ${log.slice(-1500)}`);
}
async function stop(name) {
	const child = processes.get(name); if (!child) return;
	const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; processes.delete(name);
}
async function settled() {
	for (let i = 0; i < 80; i++) { const s = await rpc("phone"); if (!s.busy && s.lastSync) { assert(!s.error, s.error); return s; } if (s.error) throw Error(s.error); await pause(250); }
	throw Error("Sync did not settle.");
}
try {
	assert.equal((await start("mac")).mode, "host"); await start("phone");
	const code = "lh-sync-1:" + Buffer.from(JSON.stringify(connection)).toString("base64url");
	await rpc("phone", { action: "connect", code, source: "phone" }); await settled();
	for (const device of ["phone", "mac"]) for (const id of ["chat_mac_fixture", "chat_phone_fixture"]) assert(fs.existsSync(path.join(folder(device), `chats/${id}.json`)));
	console.log("PASS production apps synchronize both ways through private Tailscale HTTPS");
	const read = (device, id = "chat_mac_fixture") => JSON.parse(fs.readFileSync(path.join(folder(device), `chats/${id}.json`)));
	assert.equal(read("mac", "chat_shared").title, "Phone first");
	assert.equal((await rpc("phone")).initialComplete, true);
	console.log("PASS first sync uses phone for shared IDs and retains unique sessions");
	write(path.join(folder("mac"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Mac newer", "2026-11-15T12:00:00Z"));
	write(path.join(folder("phone"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Phone older", "2026-11-15T11:00:00Z"));
	write(path.join(folder("mac"), "chats/chat_phone_fixture.json"), chat("chat_phone_fixture", "Mac older", "2026-11-15T11:00:00Z"));
	write(path.join(folder("phone"), "chats/chat_phone_fixture.json"), chat("chat_phone_fixture", "Phone newer", "2026-11-15T12:00:00Z"));
	await rpc("phone", { action: "now" }); await settled();
	for (const device of ["phone", "mac"]) {
		assert.equal(read(device).title, "Mac newer"); assert.equal(read(device, "chat_phone_fixture").title, "Phone newer");
		assert.equal(fs.readdirSync(path.join(folder(device), "chats")).length, 3);
	}
	console.log("PASS offline divergence chooses the latest version separately per session without duplicates");
	// Direct disk edits bypass the app's event-triggered upload. The Mac pre-edit
	// request must wake the phone and flush before it returns, not rely on 30s polling.
	await pause(1500);
	write(path.join(folder("phone"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Phone flush before Mac edit", "2026-11-15T13:00:00Z"));
	assert.equal((await rpc("mac", { action: "before-edit", chatId: "chat_mac_fixture" })).synced, true);
	assert.equal(read("mac").title, "Phone flush before Mac edit");
	write(path.join(folder("mac"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Mac flush before phone edit", "2026-11-15T14:00:00Z"));
	assert.equal((await rpc("phone", { action: "before-edit", chatId: "chat_mac_fixture" })).synced, true);
	assert.equal(read("phone").title, "Mac flush before phone edit");
	console.log("PASS both apps sync before editing, including Mac requesting a phone flush");
	const older = read("mac", "chat_shared");
	const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
	const revision = createHash("sha256").update(JSON.stringify(canonical({ version: 1, chat: older, jobs: [] }))).digest("hex");
	write(path.join(folder("mac"), "sync-private/cleanup-requests/chat_shared.json"), { version: 1, id: "chat_shared", revision, replacementId: "chat_phone_fixture", createdAt: new Date().toISOString() });
	fs.unlinkSync(path.join(folder("mac"), "chats/chat_shared.json"));
	await rpc("phone", { action: "now" }); assert.equal((await settled()).cleanupDeferred, 0);
	const gone = await fetch(`http://127.0.0.1:${ports.phone}/api/chats/chat_shared`);
	assert.equal(gone.status, 404); assert.equal((await gone.json()).replacementId, "chat_phone_fixture");
	const oldLink = await fetch(`http://127.0.0.1:${ports.phone}/chat/chat_shared`, { redirect: "manual" });
	assert.equal(oldLink.status, 307); assert.equal(oldLink.headers.get("location"), "/chat/chat_phone_fixture");
	assert.equal(read("phone", "chat_shared").syncCleanup.revision, revision);
	assert.equal(read("phone", "chat_phone_fixture").title, "Phone newer");
	assert(fs.existsSync(path.join(folder("phone"), "sync-private/removed/chat_shared", `${revision}.json`)));
	console.log("PASS Mac duplicate cleanup reaches phone, keeps latest work, archives recovery data and redirects old links");
	await stop("phone");
	write(path.join(folder("mac"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "After restart"));
	const offlineStart = Date.now();
	assert.equal((await rpc("mac", { action: "before-edit", chatId: "chat_mac_fixture" })).offline, true);
	assert(Date.now() - offlineStart < 6000);
	await start("phone"); await settled();
	assert.equal((await fetch(`http://127.0.0.1:${ports.phone}/api/chats/chat_shared`)).status, 404);
	assert.equal(JSON.parse(fs.readFileSync(path.join(folder("phone"), "chats/chat_mac_fixture.json"))).title, "After restart");
	await stop("mac");
	const phoneOfflineStart = Date.now();
	assert.equal((await rpc("phone", { action: "before-edit", chatId: "chat_mac_fixture" })).offline, true);
	assert(Date.now() - phoneOfflineStart < 6500);
	assert.equal((await rpc("phone", { action: "disconnect" })).mode, "off");
	console.log("PASS pairing resumes after restart, offline editing is bounded on both devices, and disconnect preserves sessions");
} finally {
	for (const name of [...processes.keys()]) await stop(name);
	fs.rmSync(root, { recursive: true, force: true });
}
