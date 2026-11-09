import { createHash } from "node:crypto";
import type { ChatRecord, JobRecord } from "../core/contracts.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { subscribe } from "../core/events.ts";
import { chatStore } from "../store/chats.ts";
import { jobStore } from "../store/jobs.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { compactionInFlight } from "./compaction.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { turnFailure } from "./turn-runs.ts";

const version = (parts: unknown[]) => parts.length ? createHash("sha256").update(JSON.stringify(parts)).digest("hex") : "";

/** Opaque revisions only: notification transport never carries lesson text,
 * reasoning, provider errors, credentials, or research contents. Progress,
 * renames and delivery bookkeeping must not produce another ready alert. */
export function androidSessionState(chat: ChatRecord, jobs: JobRecord[], busy: boolean, failure?: string) {
	const ready: unknown[] = [];
	const errors: unknown[] = [];
	for (const message of chat.messages) {
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") continue;
		if (message.stopReason === "error") { errors.push(message.id); continue; }
		const visible = message.content.filter((part) =>
			(part.type === "text" && part.text.trim()) ||
			(part.type === "toolCall" && (QUESTION_TOOLS as readonly string[]).includes(part.name)));
		if (visible.length) ready.splice(0, ready.length, [message.id, visible]);
	}
	for (const job of [...jobs].sort((a, b) => a.id.localeCompare(b.id))) {
		if (job.delivery?.kind === "abort") continue;
		if (job.status === "done") ready.push([job.id, "done"]);
		if (job.status === "error") errors.push(job.id);
	}
	if (failure) errors.push([chat.updatedAt, failure]);
	return { id: chat.id, title: chat.title, busy: busy || jobs.some((job) => job.status === "running"), readyVersion: version(ready), errorVersion: version(errors) };
}

export function androidBackgroundSnapshot() {
	const extractions = extractionStatuses();
	const sessions = chatStore.listChats().flatMap(({ id }) => {
		const chat = chatStore.getChat(id);
		return chat ? [androidSessionState(chat, jobStore.listJobs(id), isTurnRunning(id) || compactionInFlight(id), turnFailure(id))] : [];
	});
	return { busy: extractions.length > 0 || sessions.some((session) => session.busy), sessions };
}

/** Native service subscribes independently of the WebView. Full snapshots
 * on connect/reconnect heal missed events without replaying model requests. */
export function androidBackgroundResponse(snapshot = androidBackgroundSnapshot): Response {
	let teardown: (() => void) | undefined;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let pending: ReturnType<typeof setTimeout> | undefined;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let unsubscribe: (() => void) | undefined;
			const stop = () => { closed = true; unsubscribe?.(); clearTimeout(pending); clearInterval(heartbeat); };
			const send = () => {
				pending = undefined;
				if (closed) return;
				try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot())}\n\n`)); }
				catch (error) { stop(); controller.error(error); }
			};
			unsubscribe = subscribe(() => { if (!pending) pending = setTimeout(send, 150); });
			// Also repairs stale liveness and renews the native bounded wake lock.
			heartbeat = setInterval(send, 25_000);
			teardown = stop;
			send();
		},
		cancel() { teardown?.(); },
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
