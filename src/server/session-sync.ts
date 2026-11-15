import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { PATHS } from "../../config.ts";
import { emit, subscribe } from "../core/events.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { runningTurn } from "./turn-runs.ts";
import { compactionInFlight } from "./compaction.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { atomicJSON, sessionRecords, SyncError } from "../store/session-sync.ts";
import { decodePairing, emptySyncState, encodePairing, remoteSessions, syncSessions, validateConnection, type SyncConnection, type SyncState } from "./sync/client.ts";
import { syncHost } from "./sync/host.ts";

type Config = { mode: "off" } | ({ mode: "host" | "client" } & SyncConnection);
const directory = () => path.join(PATHS.data, "sync-private");
const configFile = () => path.join(directory(), "config.json");
function readConfig(): Config {
	if (!fs.existsSync(configFile())) return { mode: "off" };
	const raw = JSON.parse(fs.readFileSync(configFile(), "utf8"));
	if (raw.mode === "off") return { mode: "off" };
	if (!["host", "client"].includes(raw.mode)) throw new Error("Invalid sync configuration.");
	return { ...validateConnection(raw), mode: raw.mode };
}
interface Runtime {
	config: Config; host?: Server; timer?: NodeJS.Timeout; kick?: NodeJS.Timeout; unsubscribe?: () => void;
	running?: Promise<unknown>; controller?: AbortController; generation: number;
	configuring?: Promise<unknown>;
	lastSync?: string; error?: string; conflicts: number; deferred: number; initialized: boolean;
}
const globalSync = globalThis as typeof globalThis & { __lhSessionSync?: Runtime };
function runtime() { return globalSync.__lhSessionSync ??= { config: { mode: "off" }, generation: 0, conflicts: 0, deferred: 0, initialized: false }; }
function records() {
	return sessionRecords(PATHS.data,
		id => isTurnRunning(id) || !!runningTurn(id) || compactionInFlight(id) || extractionStatuses().some(run => run.chatId === id),
		id => { emit("record-changed", { chatId: id }); emit("chats-changed", {}); emit("jobs-changed", { chatId: id }); });
}
function errorMessage(e: unknown) {
	return e instanceof SyncError ? e.message : "Mac unavailable. Keep Tailscale connected on both devices and LearnHarness open on the Mac. Sync will retry automatically.";
}
export function runSessionSync(): Promise<unknown> {
	const r = runtime();
	if (r.running) return r.running;
	if (r.config.mode !== "client") return Promise.resolve();
	const config = r.config, generation = r.generation;
	const controller = new AbortController(); r.controller = controller;
	const check = () => { if (controller.signal.aborted || r.generation !== generation) throw new Error("Sync disconnected."); };
	r.running = (async () => {
		try {
			const file = path.join(directory(), `state-${config.hostId}.json`);
			const state: SyncState = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : emptySyncState();
			const result = await syncSessions(records(), remoteSessions(config, controller.signal), state, () => { check(); atomicJSON(file, state); }, check);
			check(); r.lastSync = new Date().toISOString(); r.error = undefined; r.conflicts += result.conflicts; r.deferred = result.deferred;
		} catch (e) { if (r.generation === generation) r.error = errorMessage(e); }
		finally { if (r.controller === controller) { r.running = undefined; r.controller = undefined; } }
	})();
	return r.running;
}
async function start(config: Config) {
	const r = runtime();
	r.generation++; r.controller?.abort();
	await r.running;
	if (r.timer) clearInterval(r.timer);
	if (r.kick) clearTimeout(r.kick);
	r.unsubscribe?.();
	if (r.host) {
		r.host.closeAllConnections();
		await new Promise<void>(resolve => r.host!.close(() => resolve()));
	}
	r.host = undefined; r.timer = undefined; r.kick = undefined; r.unsubscribe = undefined;
	r.config = config; r.error = undefined; r.lastSync = undefined; r.conflicts = 0; r.deferred = 0;
	if (config.mode === "host") {
		if (process.env.LH_ANDROID === "1") throw new SyncError(400, "Set up the sync host on your Mac.");
		const server = syncHost(records(), config.token, config.hostId, () => { r.lastSync = new Date().toISOString(); });
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(Number(new URL(config.url).port), "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
		});
		server.on("error", () => { r.error = "The sync listener stopped. Reopen LearnHarness on the Mac."; });
		r.host = server;
	} else if (config.mode === "client") {
		// Runs inside the Android runtime, independently of WebView visibility.
		// A reconnect also retries automatically; no inference is triggered.
		r.timer = setInterval(() => void runSessionSync(), 30_000); r.timer.unref();
		r.unsubscribe = subscribe(event => {
			if (!["turn-settled", "jobs-changed", "chats-changed", "record-changed"].includes(event.type)) return;
			// Coalesce progress bursts; don't rescan every saved session for each
			// worker activity update while a lesson is running on the phone.
			if (r.kick) clearTimeout(r.kick);
			r.kick = setTimeout(() => { r.kick = undefined; void runSessionSync(); }, 1500); r.kick.unref();
		});
		void runSessionSync();
	}
}
export async function ensureSessionSync() {
	const r = runtime(); if (r.initialized) return;
	r.initialized = true;
	try { await start(readConfig()); } catch { r.error = "Sync could not start. Reconnect it in Settings → General → Session sync."; }
}
export async function syncStatus() {
	await ensureSessionSync(); const r = runtime();
	return { mode: r.config.mode, canHost: process.env.LH_ANDROID !== "1", url: r.config.mode === "off" ? undefined : r.config.url,
		busy: !!r.running, lastSync: r.lastSync, error: r.error, conflicts: r.conflicts, deferred: r.deferred };
}
export function configureSync(input: unknown): Promise<unknown> {
	const r = runtime();
	const pending = (r.configuring ?? Promise.resolve()).catch(() => {}).then(() => configure(input));
	r.configuring = pending;
	void pending.finally(() => { if (r.configuring === pending) r.configuring = undefined; }).catch(() => {});
	return pending;
}
async function configure(input: unknown) {
	await ensureSessionSync();
	const body = input as { action?: string; address?: string; code?: string };
	if (body?.action === "now") { await runSessionSync(); return syncStatus(); }
	if (body?.action === "pairing") {
		const config = runtime().config;
		if (config.mode !== "host" || !runtime().host) throw new SyncError(409, "Start the Mac sync host first.");
		return { ...await syncStatus(), code: encodePairing(config) };
	}
	let config: Config;
	if (body?.action === "disconnect") config = { mode: "off" };
	else if (body?.action === "host") {
		if (process.env.LH_ANDROID === "1") throw new SyncError(400, "Set up the sync host on your Mac.");
		config = { mode: "host", ...validateConnection({ url: `https://${body.address?.trim()}:47823`, token: randomBytes(32).toString("hex"), hostId: randomUUID() }) };
	} else if (body?.action === "connect" && typeof body.code === "string") {
		const connection = decodePairing(body.code.trim());
		await remoteSessions(connection, AbortSignal.timeout(15_000)).manifest();
		config = { mode: "client", ...connection };
	} else throw new SyncError(400, "Choose a sync action.");
	const previous = runtime().config;
	try { await start(config); atomicJSON(configFile(), config); }
	catch (e) { await start(previous).catch(() => {}); throw e; }
	return syncStatus();
}
