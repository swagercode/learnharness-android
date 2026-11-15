/** Integration test using a temporary tailnet HTTPS forward on port 47825 and two
 * isolated production app runtimes. No real sessions or provider credentials. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

const hostname = process.env.LH_SYNC_TEST_HOST;
if (!hostname || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname)) throw Error("Set LH_SYNC_TEST_HOST to this Mac's Tailscale hostname; forward HTTPS 47825 to http://localhost:47825 first.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-production-"));
const connection = { url: `https://${hostname}:47825`, token: randomBytes(32).toString("hex"), hostId: randomUUID() };
const processes = new Map();
const pause = ms => new Promise(done => setTimeout(done, ms));
const folder = name => path.join(root, name, "data");
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function chat(id, title) { return { id, version: 1, title, createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [], settings: { model: { provider: "chatgpt", id: "gpt-6-astra" }, thinkingLevel: "low", fastMode: true } }; }
write(path.join(folder("mac"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Mac fixture"));
write(path.join(folder("phone"), "chats/chat_phone_fixture.json"), chat("chat_phone_fixture", "Phone fixture"));
write(path.join(folder("mac"), "sync-private/config.json"), { mode: "host", ...connection });
const ports = { mac: 3231, phone: 3232 };
async function rpc(name, body) {
	const response = await fetch(`http://127.0.0.1:${ports[name]}/api/sync`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45_000) });
	const value = await response.json(); assert(response.ok, value.error); return value;
}
async function start(name) {
	write(path.join(root, name, "auth.json"), {});
	const child = spawn(process.execPath, [path.resolve(".next/standalone/server.js")], { env: { ...process.env, NODE_ENV: "production", PORT: String(ports[name]), HOSTNAME: "127.0.0.1", LH_DATA_DIR: folder(name), LH_AUTH_FILE: path.join(root, name, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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
	await rpc("phone", { action: "connect", code }); await settled();
	for (const device of ["phone", "mac"]) for (const id of ["chat_mac_fixture", "chat_phone_fixture"]) assert(fs.existsSync(path.join(folder(device), `chats/${id}.json`)));
	console.log("PASS production apps synchronize both ways through private Tailscale HTTPS");
	write(path.join(folder("mac"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Mac offline change"));
	write(path.join(folder("phone"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "Phone offline change"));
	await rpc("phone", { action: "now" }); const status = await settled(); assert.equal(status.conflicts, 1);
	for (const device of ["phone", "mac"]) {
		const records = fs.readdirSync(path.join(folder(device), "chats")).map(f => JSON.parse(fs.readFileSync(path.join(folder(device), "chats", f))));
		assert.equal(records.length, 3); assert(records.some(r => r.title.includes("Phone offline change — Offline conflict copy"))); assert(records.some(r => r.title === "Mac offline change"));
	}
	console.log("PASS production conflict handling preserves both offline edits");
	await stop("phone");
	write(path.join(folder("mac"), "chats/chat_mac_fixture.json"), chat("chat_mac_fixture", "After restart"));
	await start("phone"); await settled();
	assert.equal(JSON.parse(fs.readFileSync(path.join(folder("phone"), "chats/chat_mac_fixture.json"))).title, "After restart");
	assert.equal((await rpc("phone", { action: "disconnect" })).mode, "off");
	console.log("PASS persisted pairing resumes after restart and disconnect preserves sessions");
} finally {
	for (const name of [...processes.keys()]) await stop(name);
	fs.rmSync(root, { recursive: true, force: true });
}
