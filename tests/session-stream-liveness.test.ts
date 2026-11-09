import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { newUserMessage } from "../src/core/native-messages.ts";

const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const settled = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(frame({ type: "turn-settled" })); c.close(); } }));
function heldStream() {
	let ready!: () => void;
	const reading = new Promise<void>(resolve => { ready = resolve; });
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const response = new Response(new ReadableStream<Uint8Array>({
		start(c) { controller = c; }, pull() { ready(); }, cancel() { cancelled = true; },
	}, { highWaterMark: 0 }));
	return { response, reading, close: () => { if (!cancelled) controller.close(); }, cancelled: () => cancelled };
}

describe("half-open session stream recovery", () => {
	it("replaces a stream that never closes once the server confirms completion, without sending input again", async () => {
		const held = heldStream(); let streams = 0; let posts = 0;
		const saved = newUserMessage("Saved complete transcript");
		const m = new SessionModel({ chatId: "chat_test", initialMessages: [], fetch: async (url, init) => {
			if (init?.method === "POST") { posts++; return Response.json({ ok: true }); }
			if (String(url).startsWith("/api/jobs")) return Response.json({ turnInFlight: false });
			if (String(url).endsWith("/stream")) return ++streams === 1 ? held.response : settled();
			return Response.json({ messages: [saved] });
		} });
		const first = m.resumeStream(false); await held.reading;
		assert.equal(m.status, "submitted");
		await m.reconcileStream(); await first;
		assert.equal(m.status, "ready");
		assert.equal(held.cancelled(), true);
		assert.equal(streams, 2); assert.equal(posts, 0);
		assert.deepEqual(m.getState().nativeMessages, [saved]);
	});
	it("leaves legitimate long thinking alone, but replays it on foreground return", async () => {
		const held = heldStream(); let streams = 0;
		const m = new SessionModel({ chatId: "chat_test", initialMessages: [], fetch: async (url) => {
			if (String(url).startsWith("/api/jobs")) return Response.json({ turnInFlight: true });
			if (String(url).endsWith("/stream")) return ++streams === 1 ? held.response : settled();
			return Response.json({ messages: [] });
		} });
		const first = m.resumeStream(false); await held.reading;
		await m.reconcileStream();
		assert.equal(streams, 1); assert.equal(held.cancelled(), false); assert.equal(m.status, "submitted");
		await m.reconcileStream(true); await first;
		assert.equal(streams, 2); assert.equal(m.status, "ready");
	});
	it("does not touch a submission whose POST acknowledgement is still pending", async () => {
		let accept!: (value: Response) => void; let requests = 0;
		const m = new SessionModel({ chatId: "chat_test", initialMessages: [], fetch: async () => { requests++; return new Promise(resolve => { accept = resolve; }); } });
		const sending = m.send({ type: "text", text: "Only submit once" });
		await m.reconcileStream(true);
		assert.equal(requests, 1); assert.equal(m.status, "submitted");
		m.stop(); accept(Response.json({ ok: true })); await sending;
		assert.equal(requests, 1);
	});
	it("ignores stale liveness replies after the view is detached", async () => {
		const held = heldStream(); let resolveProbe!: (response: Response) => void; let streams = 0;
		const m = new SessionModel({ chatId: "chat_test", initialMessages: [], fetch: async (url) => {
			if (String(url).startsWith("/api/jobs")) return new Promise(resolve => { resolveProbe = resolve; });
			streams++; return held.response;
		} });
		const first = m.resumeStream(false); await held.reading;
		const probe = m.reconcileStream(); m.stop();
		resolveProbe(Response.json({ turnInFlight: false })); await probe;
		assert.equal(streams, 1); assert.equal(m.status, "ready");
		held.close(); await first;
	});
	it("does not treat an unavailable liveness endpoint as completion", async () => {
		const held = heldStream();
		const m = new SessionModel({ chatId: "chat_test", initialMessages: [], fetch: async (url) => String(url).startsWith("/api/jobs") ? new Response("offline", { status: 503 }) : held.response });
		const first = m.resumeStream(false); await held.reading;
		await m.reconcileStream(); assert.equal(m.status, "submitted"); assert.equal(held.cancelled(), false);
		m.stop(); held.close(); await first;
	});
});
