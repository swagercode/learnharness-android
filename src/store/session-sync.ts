import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChatRecord } from "../core/contracts/chat.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts/chat.ts";
import type { JobRecord } from "../core/contracts/jobs.ts";

export const MAX_PACKAGE = 32 * 1024 * 1024;
export const CHAT_ID = /^chat_[A-Za-z0-9_-]{1,100}$/;
const JOB_ID = /^job_[A-Za-z0-9_-]{1,100}$/;
export interface SessionPackage { version: 1; chat: ChatRecord; jobs: JobRecord[] }
export interface Revision { id: string; hash: string | null; busy: boolean }
export class SyncError extends Error {
	constructor(public status: number, message: string) { super(message); }
}
export function atomicJSON(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		fs.renameSync(temp, file);
	} finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function validatePackage(value: unknown): SessionPackage {
	if (!plain(value) || value.version !== 1 || !plain(value.chat) || !Array.isArray(value.jobs)) throw new SyncError(400, "Invalid session package.");
	const chat = value.chat;
	if (typeof chat.id !== "string" || !CHAT_ID.test(chat.id) || !Array.isArray(chat.messages) || chat.messages.some(message => !plain(message)) || typeof chat.title !== "string" || typeof chat.createdAt !== "string" || typeof chat.updatedAt !== "string") throw new SyncError(400, "Invalid session record.");
	if (chat.version !== undefined && chat.version !== CURRENT_CHAT_VERSION) throw new SyncError(409, "Update both apps before syncing this session.");
	const ids = new Set<string>();
	if (value.jobs.length > 1000) throw new SyncError(413, "Too many session artifacts.");
	for (const job of value.jobs) {
		if (!plain(job) || typeof job.id !== "string" || !JOB_ID.test(job.id) || ids.has(job.id) || job.chatId !== chat.id || !["research", "demo", "visual", "pdf"].includes(String(job.kind)) || typeof job.toolCallId !== "string" || !["done", "error"].includes(String(job.status)) || job.delivery && (!plain(job.delivery) || job.delivery.status !== "delivered")) throw new SyncError(409, "Wait for this session's background work to finish before syncing.");
		ids.add(job.id);
	}
	if (Buffer.byteLength(JSON.stringify(value)) > MAX_PACKAGE) throw new SyncError(413, "This session is too large to sync (32 MB limit).");
	// Explicit top-level selection: settings, auth files, graph and source files
	// cannot hitch a ride as additional package fields.
	return { version: 1, chat: chat as unknown as ChatRecord, jobs: [...value.jobs as JobRecord[]].sort((a, b) => a.id.localeCompare(b.id)) };
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}
export function packageHash(value: SessionPackage) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

/** All snapshot/CAS/apply work is synchronous in the app's own Node process.
 * No active tutor, compactor or worker can interleave an import. */
export function sessionRecords(dataDir: string, busy: (id: string) => boolean = () => false, changed: (id: string) => void = () => {}) {
	function folder(name: string) {
		const p = path.join(dataDir, name);
		if (fs.existsSync(p) && (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink())) throw new SyncError(409, "Cannot sync linked session folders.");
		return p;
	}
	function read(file: string) {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PACKAGE + 8192) throw new SyncError(409, "Cannot sync a linked or oversized record.");
		return JSON.parse(fs.readFileSync(file, "utf8"));
	}
	function finishImport(value: SessionPackage, remove: string[]) {
		const jobDir = folder("jobs");
		for (const job of value.jobs) atomicJSON(path.join(jobDir, `${job.id}.json`), job);
		for (const id of remove) {
			if (!JOB_ID.test(id)) throw new SyncError(400, "Invalid recovery artifact ID.");
			const file = path.join(jobDir, `${id}.json`);
			if (fs.existsSync(file) && read(file).chatId === value.chat.id) fs.unlinkSync(file);
		}
		atomicJSON(path.join(folder("chats"), `${value.chat.id}.json`), value.chat);
	}
	// A journal completes an interrupted multi-file import before the runtime
	// serves a session again. Credentials and unrelated records are excluded.
	const pending = path.join(dataDir, "sync-private", "pending");
	for (const name of fs.existsSync(pending) ? fs.readdirSync(pending) : []) {
		if (!name.endsWith(".json") || !CHAT_ID.test(name.slice(0, -5))) continue;
		const file = path.join(pending, name);
		const transaction = read(file), value = validatePackage(transaction.package);
		if (value.chat.id !== name.slice(0, -5) || !Array.isArray(transaction.remove) || busy(value.chat.id)) throw new SyncError(423, "Session recovery is waiting for active work to finish.");
		finishImport(value, transaction.remove);
		fs.unlinkSync(file);
	}
	function snapshot(id: string): SessionPackage | null {
		if (!CHAT_ID.test(id)) throw new SyncError(400, "Invalid session ID.");
		if (busy(id)) throw new SyncError(423, "Session is still working; sync will retry.");
		const file = path.join(folder("chats"), `${id}.json`);
		if (!fs.existsSync(file)) return null;
		const chat = read(file);
		if (chat.id !== id) throw new SyncError(409, "Session identity mismatch.");
		const jobs: JobRecord[] = [];
		const dir = folder("jobs");
		for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			if (!JOB_ID.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
			const job = read(path.join(dir, name));
			if (job.chatId === id) {
				if (job.id !== name.slice(0, -5)) throw new SyncError(409, "Artifact identity mismatch.");
				if (job.status === "running" || job.delivery?.status === "pending") throw new SyncError(423, "Background work is still finishing; sync will retry.");
				jobs.push(job);
			}
		}
		return validatePackage({ version: 1, chat, jobs });
	}
	function manifest(): Revision[] {
		const dir = folder("chats");
		return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(n => n.endsWith(".json") && CHAT_ID.test(n.slice(0, -5))).map(n => {
			const id = n.slice(0, -5);
			try { const item = snapshot(id); return { id, hash: item ? packageHash(item) : null, busy: false }; }
			catch (e) { if (e instanceof SyncError && e.status === 423) return { id, hash: null, busy: true }; throw e; }
		});
	}
	function apply(raw: unknown, expected: string | null) {
		const value = validatePackage(raw);
		const id = value.chat.id;
		const previous = snapshot(id);
		if ((previous ? packageHash(previous) : null) !== expected) throw new SyncError(409, "Session changed during sync; retrying will preserve both versions.");
		const jobDir = folder("jobs");
		for (const job of value.jobs) {
			const file = path.join(jobDir, `${job.id}.json`);
			if (fs.existsSync(file) && read(file).chatId !== id) throw new SyncError(409, "Artifact belongs to another session.");
		}
		// Keep an immutable recovery copy before replacing any local records.
		if (previous) atomicJSON(path.join(dataDir, "sync-private", "history", id, `${packageHash(previous)}.json`), previous);
		const remove = (previous?.jobs ?? []).filter(job => !value.jobs.some(j => j.id === job.id)).map(job => job.id);
		const journal = path.join(pending, `${id}.json`);
		atomicJSON(journal, { package: value, remove });
		finishImport(value, remove);
		fs.unlinkSync(journal);
		const history = path.join(dataDir, "sync-private", "history", id);
		if (fs.existsSync(history)) {
			const revisions = fs.readdirSync(history).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort((a, b) => fs.statSync(path.join(history, b)).mtimeMs - fs.statSync(path.join(history, a)).mtimeMs);
			for (const name of revisions.slice(3)) fs.unlinkSync(path.join(history, name));
		}
		changed(id);
		return packageHash(value);
	}
	return { snapshot, manifest, apply };
}
export type SessionRecords = ReturnType<typeof sessionRecords>;
