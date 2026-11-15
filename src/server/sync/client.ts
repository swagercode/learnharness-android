import { CHAT_ID, MAX_PACKAGE, SyncError, packageHash, validatePackage, type Revision, type SessionPackage, type SessionRecords } from "../../store/session-sync.ts";
import type { SyncConflict, SyncResolution } from "../../core/contracts/session-sync.ts";
import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export interface SyncConnection { url: string; token: string; hostId: string }
export interface SyncState {
	base: Record<string, string>;
	ignored: string[];
	conflicts: Record<string, string>;
	/** Optional for the v17 state-file migration. Old conflict copies stay intact. */
	pending?: Record<string, SyncConflict>;
	decisions?: Record<string, SyncResolution>;
}
export const emptySyncState = (): SyncState => ({ base: {}, ignored: [], conflicts: {}, pending: {}, decisions: {} });
export function validateConnection(value: unknown): SyncConnection {
	const v = value as SyncConnection;
	if (!v || typeof v.url !== "string" || !/^[a-f0-9]{64}$/.test(v.token) || !/^[a-f0-9-]{36}$/.test(v.hostId)) throw new SyncError(400, "Invalid pairing code.");
	let url: URL;
	try { url = new URL(v.url); } catch { throw new SyncError(400, "Invalid sync address."); }
	// Require a verified TLS identity even when the device's VPN is disconnected.
	const tailnetHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;
	if (url.protocol !== "https:" || !tailnetHost.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || Number(url.port) < 1024 || Number(url.port) > 65535) throw new SyncError(400, "Use the Mac's private HTTPS Tailscale pairing code.");
	return { url: url.origin, token: v.token, hostId: v.hostId };
}
export function decodePairing(code: string): SyncConnection {
	if (code.length > 4096 || !code.startsWith("lh-sync-1:")) throw new SyncError(400, "Paste the pairing code from your Mac.");
	try { return validateConnection(JSON.parse(Buffer.from(code.slice(10), "base64url").toString("utf8"))); }
	catch (e) { if (e instanceof SyncError) throw e; throw new SyncError(400, "Invalid pairing code."); }
}
export function encodePairing(connection: SyncConnection) { return `lh-sync-1:${Buffer.from(JSON.stringify(validateConnection(connection))).toString("base64url")}`; }
export function isTailnetIPv4(address: string) {
	const ip = address.split(".").map(Number);
	return ip.length === 4 && ip[0] === 100 && ip[1]! >= 64 && ip[1]! <= 127 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
}
async function syncFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	try { return await fetch(input, init); }
	catch (error) {
		const code = (error as { cause?: { code?: string } }).cause?.code;
		if (!["ENOTFOUND", "EAI_AGAIN"].includes(code ?? "") || typeof input !== "string") throw error;
		const url = new URL(input);
		if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net")) throw error;
		// Some embedded runtimes or managed system resolvers cannot resolve
		// MagicDNS. Ask Tailscale directly, while retaining TLS hostname checks.
		const resolver = new Resolver({ timeout: 3000, tries: 2 });
		resolver.setServers(["100.100.100.100"]);
		const addresses = await resolver.resolve4(url.hostname);
		init?.signal?.throwIfAborted();
		if (!addresses.length || addresses.some(address => !isTailnetIPv4(address))) throw error;
		return new Promise((resolve, reject) => {
			const req = httpsRequest(url, {
				method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined,
				lookup: (_hostname, options, callback) => {
					if (options.all) callback(null, addresses.map(address => ({ address, family: 4 })));
					else callback(null, addresses[0]!, 4);
				},
			}, response => {
				const headers = new Headers();
				for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
				resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode, headers }));
			});
			req.on("error", reject);
			req.end(init?.body);
		});
	}
}
export async function boundedJSON(response: Response) {
	if (!response.body) throw new SyncError(502, "Empty sync response.");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = []; let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			total += value.length;
			if (total > MAX_PACKAGE + 8192) throw new SyncError(413, "Sync response exceeds the size limit.");
			parts.push(value);
		}
		return JSON.parse(Buffer.concat(parts).toString("utf8"));
	} finally { await reader.cancel().catch(() => {}); }
}
export function remoteSessions(connection: SyncConnection, signal: AbortSignal, transport: typeof fetch = syncFetch) {
	async function request(route: string, body?: unknown) {
		const res = await transport(`${connection.url}${route}`, {
			method: body === undefined ? "GET" : "PUT", redirect: "error",
			headers: { Authorization: `Bearer ${connection.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
		});
		if (!res.ok) {
			await res.body?.cancel();
			throw new SyncError(res.status, res.status === 401 ? "Pairing was revoked. Pair with your Mac again." : res.status === 423 ? "Session is still working; sync will retry." : res.status === 409 ? "Session changed; sync will retry safely." : "The Mac could not complete sync. It will retry automatically.");
		}
		return boundedJSON(res);
	}
	return {
		async manifest(): Promise<Revision[]> {
			const value = await request("/v1/sessions");
			if (value.version !== 1 || value.hostId !== connection.hostId || !Array.isArray(value.sessions) || value.sessions.length > 2000 || value.sessions.some((r: Revision) => !CHAT_ID.test(r.id) || typeof r.busy !== "boolean" || !(r.hash === null || /^[a-f0-9]{64}$/.test(r.hash)))) throw new SyncError(409, "The Mac's sync identity or format changed. Pair again.");
			return value.sessions;
		},
		async get(id: string): Promise<SessionPackage> {
			const value = await request(`/v1/sessions/${id}`);
			const item = validatePackage(value.package);
			if (item.chat.id !== id || value.hash !== packageHash(item)) throw new SyncError(409, "Session verification failed; no data was imported.");
			return item;
		},
		async put(item: SessionPackage, expected: string | null): Promise<string> {
			const value = await request(`/v1/sessions/${item.chat.id}`, { package: item, expected });
			if (value.hash !== packageHash(item)) throw new SyncError(409, "The Mac did not confirm this session revision.");
			return value.hash;
		},
	};
}
export type RemoteSessions = ReturnType<typeof remoteSessions>;

export function chooseSyncSource(state: SyncState, value: unknown) {
	const choice = value as SyncResolution;
	if (!choice || !CHAT_ID.test(choice.id) || !["mac", "phone"].includes(choice.source) || !/^[a-f0-9]{64}$/.test(choice.localHash) || !/^[a-f0-9]{64}$/.test(choice.remoteHash)) throw new SyncError(400, "Choose the Mac or phone version of this session.");
	const pending = state.pending?.[choice.id];
	if (!pending || pending.localHash !== choice.localHash || pending.remoteHash !== choice.remoteHash) throw new SyncError(409, "This session changed. Review the versions and choose again.");
	(state.decisions ??= {})[choice.id] = { id: choice.id, source: choice.source, localHash: choice.localHash, remoteHash: choice.remoteHash };
}

/** Three-way revision comparison, never wall-clock last-writer-wins.
 * A conflicting session waits for an explicit, revision-bound source choice.
 * Other sessions keep syncing. Deletions remain local. */
export async function syncSessions(local: SessionRecords, remote: RemoteSessions, state: SyncState, save: () => void, check: () => void = () => {}) {
	const result = { uploaded: 0, downloaded: 0, conflicts: 0, deferred: 0 };
	const pending = state.pending ??= {}, decisions = state.decisions ??= {};
	const clear = (id: string) => { delete pending[id]; delete decisions[id]; };
	const index = new Map((await remote.manifest()).map(r => [r.id, r])); check();
	const localIndex = new Map(local.manifest().map(r => [r.id, r]));
	for (const id of new Set([...Object.keys(state.base), ...Object.keys(pending)])) {
		if (!localIndex.has(id) && !state.ignored.includes(id)) { state.ignored.push(id); save(); }
	}
	for (const id of new Set([...localIndex.keys(), ...index.keys(), ...Object.keys(pending)])) {
		check();
		if (state.ignored.includes(id)) { clear(id); save(); continue; }
		const remoteRevision = index.get(id);
		if (remoteRevision?.busy || localIndex.get(id)?.busy) { result.deferred++; continue; }
		try {
			const item = local.snapshot(id);
			const hash = item ? packageHash(item) : null;
			const remoteHash = remoteRevision?.hash ?? null;
			const decision = decisions[id];
			if (decision) {
				const chosen = decision.source === "phone" ? decision.localHash : decision.remoteHash;
				// An upload/import may have committed just before a lost response
				// or process exit. Recover its base before comparing newer edits.
				if (decision.source === "phone" ? remoteHash === chosen : hash === chosen) {
					state.base[id] = chosen; clear(id); save();
				} else if (item && hash === decision.localHash && remoteHash === decision.remoteHash) {
					if (decision.source === "phone") {
						await remote.put(item, decision.remoteHash); check(); result.uploaded++;
					} else {
						const incoming = await remote.get(id); check();
						if (packageHash(incoming) !== decision.remoteHash) throw new SyncError(409, "Mac session changed during sync.");
						local.apply(incoming, decision.localHash); result.downloaded++;
					}
					state.base[id] = chosen; clear(id); save(); continue;
				} else {
					// A decision never authorizes overwriting a newer version.
					delete decisions[id]; save();
				}
			}
			const base = state.base[id];
			if (hash === remoteHash) { if (hash) state.base[id] = hash; clear(id); save(); continue; }
			if (pending[id] && (!hash || !remoteHash || hash === base || remoteHash === base)) { clear(id); save(); }
			if (!remoteHash) {
				// A remote deletion doesn't delete an offline local copy or resurrect
				// it on the Mac unless the learner has actually edited it since sync.
				if (item && (!base || hash !== base)) {
					const written = await remote.put(item, null); check(); state.base[id] = written; save(); result.uploaded++;
				}
				continue;
			}
			if (!item || hash === base) {
				const incoming = await remote.get(id); check();
				state.base[id] = local.apply(incoming, hash); save(); result.downloaded++;
				continue;
			}
			if (remoteHash === base) {
				const written = await remote.put(item, base); check(); state.base[id] = written; save(); result.uploaded++;
				continue;
			}
			if (pending[id]?.localHash === hash && pending[id]?.remoteHash === remoteHash) continue;
			const incoming = await remote.get(id); check();
			const current = local.snapshot(id);
			if (!current || packageHash(current) !== hash) throw new SyncError(409, "Local session changed during sync.");
			pending[id] = { id, title: item.chat.title.slice(0, 240), localHash: hash!, remoteHash: packageHash(incoming),
				localUpdatedAt: item.chat.updatedAt, remoteUpdatedAt: incoming.chat.updatedAt,
				localMessages: item.chat.messages.length, remoteMessages: incoming.chat.messages.length };
			save();
		} catch (e) {
			if (e instanceof SyncError && [404, 409, 423].includes(e.status)) { result.deferred++; continue; }
			throw e;
		}
	}
	result.conflicts = Object.keys(pending).length;
	return result;
}
