import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { PATHS } from "../../config.ts";
import { isTurnRunning } from "./turn-liveness.ts";

const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_FILES = 2000;

/** Synchronous snapshot: no writer in this Node process can interleave
 * between the idle check and the last read. Credentials are never selected.
 * Format v1 is shared with Android's checked, non-overwriting importer. */
export function sessionBackupSnapshot(dataDir = PATHS.data, running = isTurnRunning) {
	const files: Record<string, Uint8Array> = {};
	const sessions = new Set<string>();
	let total = 0;
	let jobs = 0;
	function read(name: string) {
		const file = path.join(dataDir, name);
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Cannot back up a linked or non-file session record.");
		if (stat.size > MAX_FILE || total + stat.size > MAX_TOTAL || Object.keys(files).length >= MAX_FILES)
			throw new Error("The session backup exceeds the supported size limit.");
		const bytes = fs.readFileSync(file);
		total += bytes.length;
		files[name] = bytes;
		return JSON.parse(bytes.toString("utf8"));
	}
	function names(dir: string, pattern: RegExp) {
		const folder = path.join(dataDir, dir);
		if (!fs.existsSync(folder)) return [];
		if (fs.lstatSync(folder).isSymbolicLink()) throw new Error("Cannot back up a linked session folder.");
		return fs.readdirSync(folder).filter((name) => pattern.test(name)).sort();
	}
	for (const name of names("chats", /^chat_[A-Za-z0-9_-]+\.json$/)) {
		const id = name.slice(0, -5);
		if (running(id)) throw new Error("Wait for your sessions to finish responding before exporting a backup.");
		const record = read(`chats/${name}`);
		if (record.id !== id || !Array.isArray(record.messages)) throw new Error("A session record is damaged; no backup was created.");
		sessions.add(id);
	}
	if (!sessions.size) throw new Error("There are no saved sessions to export yet.");
	for (const name of names("jobs", /^job_[A-Za-z0-9_-]+\.json$/)) {
		const record = read(`jobs/${name}`);
		if (!sessions.has(record.chatId)) { delete files[`jobs/${name}`]; continue; }
		if (record.id !== name.slice(0, -5)) throw new Error("A research record is damaged; no backup was created.");
		if (!["done", "error", "cancelled", "canceled", "aborted"].includes(record.status))
			throw new Error("Wait for background research and other jobs to finish before exporting a backup.");
		jobs++;
	}
	if (fs.existsSync(path.join(dataDir, "settings.json"))) read("settings.json");
	return { files, sessions: sessions.size, jobs };
}

export function sessionBackupArchive(snapshot: ReturnType<typeof sessionBackupSnapshot>) {
	const manifest = {
		format: "learnharness-backup", version: 1, createdAt: new Date().toISOString(),
		files: Object.entries(snapshot.files).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })),
	};
	return zipSync({
		"learnharness-backup.json": new TextEncoder().encode(JSON.stringify(manifest)),
		...Object.fromEntries(Object.entries(snapshot.files).map(([name, bytes]) => [`data/${name}`, bytes])),
	}, { level: 6 });
}

export function sessionBackupResponse(request: Request): Response {
	try {
		const snapshot = sessionBackupSnapshot();
		if (new URL(request.url).searchParams.get("check") === "1")
			return Response.json({ sessions: snapshot.sessions, jobs: snapshot.jobs }, { headers: { "Cache-Control": "no-store" } });
		const archive = sessionBackupArchive(snapshot);
		return new Response(archive as BodyInit, { headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="LearnHarness-${new Date().toISOString().slice(0, 10)}.lhbackup.zip"`,
			"Cache-Control": "no-store",
		} });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not create the session backup." }, { status: 409, headers: { "Cache-Control": "no-store" } });
	}
}
