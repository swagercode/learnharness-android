import { CHAT_ID, MAX_PACKAGE, SyncError, packageHash, validatePackage, type Revision, type SessionPackage, type SessionRecords } from "../../store/session-sync.ts";

import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export interface SyncConnection { url: string; token: string; hostId: string }
export type SyncSource = "phone" | "mac";
export interface SyncState {
	base: Record<string, string>;
	ignored: string[];
	/** v17 legacy copy mapping, retained without deleting its sessions. */
	conflicts?: Record<string, string>;
	initial?: { source: SyncSource; remaining?: string[]; complete?: boolean };
}
export const emptySyncState = (source?: SyncSource): SyncState => ({ base: {}, ignored: [], ...(source ? { initial: { source } } : {}) });
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
	async function request(route: string, body?: unknown, method?: string) {
		const res = await transport(`${connection.url}${route}`, {
			method: method ?? (body === undefined ? "GET" : "PUT"), redirect: "error",
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
		async wake() {
			const value = await request("/v1/wake");
			if (!Array.isArray(value.requests) || value.requests.length > 100 || value.requests.some((r: { id: string; chatId: string }) => !/^[a-f0-9-]{36}$/.test(r.id) || !CHAT_ID.test(r.chatId))) throw new SyncError(409, "Update the Mac sync companion.");
			return value.requests as { id: string; chatId: string }[];
		},
		async ready(ids: string[]) { await request("/v1/ready", { ids }, "POST"); },
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
export type RemoteSessions = Pick<ReturnType<typeof remoteSessions>, "manifest" | "get" | "put">;

/** Includes non-sidebar edits and completed artifact changes. Imports retain
 * the source timestamps; they never manufacture a newer revision. */
export function sessionModifiedAt(item: SessionPackage): number {
	const dates = [item.chat.syncUpdatedAt, item.chat.updatedAt, ...item.jobs.map(job => job.updatedAt)];
	return Math.max(0, ...dates.map(value => typeof value === "string" ? Date.parse(value) || 0 : 0));
}
export function latestSource(local: SessionPackage, remote: SessionPackage, tie: SyncSource): SyncSource {
	const a = sessionModifiedAt(local), b = sessionModifiedAt(remote);
	return a === b ? tie : a > b ? "phone" : "mac";
}

/** One initial source preference applies only to shared sessions. Afterwards,
 * a one-sided change always propagates; simultaneous offline changes use the
 * newest saved version of that session, with the replaced revision backed up. */
export async function syncSessions(local: SessionRecords, remote: RemoteSessions, state: SyncState, save: () => void, check: () => void = () => {}, onlyId?: string) {
	const result = { uploaded: 0, downloaded: 0, deferred: 0 };
	if (!state.initial) return result;
	const index = new Map((await remote.manifest()).map(r => [r.id, r])); check();
	const localIndex = new Map(local.manifest().map(r => [r.id, r]));
	if (!state.initial.complete && !state.initial.remaining) {
		state.initial.remaining = [...new Set([...localIndex.keys(), ...index.keys()])]; save();
	}
	const initialIds = new Set(state.initial.complete ? [] : state.initial.remaining);
	const settled = (id: string, hash?: string | null) => {
		if (hash) state.base[id] = hash;
		initialIds.delete(id); state.initial!.remaining = [...initialIds]; save();
	};
	for (const id of Object.keys(state.base)) if (!localIndex.has(id) && !state.ignored.includes(id)) { state.ignored.push(id); save(); }
	for (const id of new Set([...localIndex.keys(), ...index.keys(), ...initialIds])) {
		if (onlyId && state.initial.complete && id !== onlyId) continue;
		check();
		if (state.ignored.includes(id)) { if (initialIds.has(id)) settled(id); continue; }
		const remoteRevision = index.get(id);
		if (remoteRevision?.busy || localIndex.get(id)?.busy) { result.deferred++; continue; }
		try {
			const item = local.snapshot(id), hash = item ? packageHash(item) : null;
			const remoteHash = remoteRevision?.hash ?? null, base = state.base[id];
			if (hash === remoteHash) { if (hash !== base || initialIds.has(id)) settled(id, hash); continue; }
			if (!remoteHash) {
				if (item && (!base || hash !== base || initialIds.has(id))) {
					const written = await remote.put(item, null); check(); settled(id, written); result.uploaded++;
				} else if (initialIds.has(id)) settled(id);
				continue;
			}
			if (!item) {
				const incoming = await remote.get(id); check(); settled(id, local.apply(incoming, null)); result.downloaded++; continue;
			}
			let source: SyncSource;
			let incoming: SessionPackage | undefined;
			if (initialIds.has(id)) source = state.initial.source;
			else if (hash === base) source = "mac";
			else if (remoteHash === base) source = "phone";
			else {
				incoming = await remote.get(id); check();
				if (packageHash(incoming) !== remoteHash) throw new SyncError(409, "Mac session changed during sync.");
				source = latestSource(item, incoming, state.initial.source);
			}
			if (source === "phone") {
				const current = local.snapshot(id);
				if (!current || packageHash(current) !== hash) throw new SyncError(409, "Phone session changed during sync.");
				const written = await remote.put(item, remoteHash); check(); settled(id, written); result.uploaded++;
			} else {
				incoming ??= await remote.get(id); check();
				if (packageHash(incoming) !== remoteHash) throw new SyncError(409, "Mac session changed during sync.");
				settled(id, local.apply(incoming, hash)); result.downloaded++;
			}
		} catch (e) {
			if (e instanceof SyncError && [404, 409, 423].includes(e.status)) { result.deferred++; continue; }
			throw e;
		}
	}
	if (!initialIds.size && !state.initial.complete) { state.initial.complete = true; save(); }
	return result;
}
