import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CHAT_ID, MAX_PACKAGE, SyncError, packageHash, type SessionRecords } from "../../store/session-sync.ts";

import { SyncWakeups } from "./wakeups.ts";

export function syncHost(records: SessionRecords, token: string, hostId: string, activity: () => void = () => {}, wakeups = new SyncWakeups()) {
	function respond(res: ServerResponse, status: number, value: unknown) {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		res.end(JSON.stringify(value));
	}
	async function body(req: IncomingMessage) {
		const chunks: Buffer[] = []; let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_PACKAGE + 8192) throw new SyncError(413, "Session exceeds the sync limit.");
			chunks.push(chunk);
		}
		try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SyncError(400, "Invalid sync request."); }
	}
	const server = createServer(async (req, res) => {
		try {
			const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
			if (!/^[a-f0-9]{64}$/.test(supplied) || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new SyncError(401, "Pair this device to sync.");
			if (req.headers.origin || req.headers["sec-fetch-site"] === "cross-site") throw new SyncError(403, "Sync is available only to paired apps.");
			if (req.method === "GET" && req.url === "/v1/wake") {
				const controller = new AbortController();
				const abort = () => controller.abort(); res.once("close", abort);
				try { respond(res, 200, { requests: await wakeups.wait(controller.signal) }); }
				finally { res.removeListener("close", abort); }
				return;
			}
			if (req.method === "POST" && req.url === "/v1/ready") {
				if (req.headers["content-type"] !== "application/json") throw new SyncError(415, "Use JSON for sync.");
				const value = await body(req);
				if (!Array.isArray(value?.ids) || value.ids.length > 100 || value.ids.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw new SyncError(400, "Invalid sync acknowledgement.");
				wakeups.ready(value.ids); respond(res, 200, { ok: true }); return;
			}
			if (req.method === "GET" && req.url === "/v1/cleanup") {
				respond(res, 200, { version: 1, hostId, requests: records.cleanupRequests() }); return;
			}
			if (req.method === "GET" && req.url === "/v1/sessions") {
				respond(res, 200, { version: 1, hostId, sessions: records.manifest() }); activity(); return;
			}
			const id = req.url?.startsWith("/v1/sessions/") ? req.url.slice(13) : "";
			if (!CHAT_ID.test(id)) throw new SyncError(404, "Unknown sync route.");
			if (req.method === "GET") {
				const item = records.snapshot(id);
				if (!item) throw new SyncError(404, "Session no longer exists.");
				respond(res, 200, { package: item, hash: packageHash(item) }); activity(); return;
			}
			if (req.method === "PUT") {
				if (req.headers["content-type"] !== "application/json") throw new SyncError(415, "Use JSON for sync.");
				const value = await body(req);
				if (!value || value.package?.chat?.id !== id || !(value.expected === null || typeof value.expected === "string" && /^[a-f0-9]{64}$/.test(value.expected))) throw new SyncError(400, "Invalid session revision.");
				respond(res, 200, { hash: records.apply(value.package, value.expected) }); activity(); return;
			}
			throw new SyncError(405, "Unsupported sync method.");
		} catch (e) {
			respond(res, e instanceof SyncError ? e.status : 500, { error: e instanceof SyncError ? e.message : "Sync could not complete. Local sessions are preserved." });
		}
	});
	server.on("close", () => wakeups.close());
	server.requestTimeout = 45_000;
	server.headersTimeout = 10_000;
	server.maxHeadersCount = 30;
	return server;
}
