import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backgroundCaptureDir, backgroundCaptureStream, createBackgroundCapture } from "../src/agent/background-capture.ts";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { chatGPTAbortController, chatGPTModels, refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";
import { chatGPTHistory, chatGPTPayload, chatGPTSpeedForUsage, chatGPTStream } from "../src/agent/chatgpt-stream.ts";
import { createLessonPacing, LESSON_RECOVERY_INSTRUCTIONS } from "../src/agent/lesson-pacing.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const realFetch = globalThis.fetch;
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const originalKey = process.env.OPENAI_API_KEY;
let leaseError: string | null = null;
let requests: { authorization: string | null; body: Record<string, any>; url: string }[] = [];
let responseEvents: unknown[] = [];
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const model = piModels().getModel("openai", "gpt-5") as Model<"openai-responses">;
const astra = piModels().getModel("openai", "gpt-6-astra") as Model<"openai-responses">;
const status = { available: true, pending: false, allowBackgroundUse: false, activeId: "scratch-account", accounts: [{ id: "scratch-account", email: "dummy@example.invalid", registration: "oaiapp_scratch", connected: true, planEnabled: true, background: false }], error: null };
before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	assert(model); assert(astra);
	process.env.OPENAI_API_KEY = "sk-scratch-must-never-be-used";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		queueMicrotask(() => {
			ipc({ channel: "lh:chatgpt", id: message.id, op: message.op,
				...(message.op === "lease" && leaseError ? { ok: false, error: leaseError, stamp: { epoch: 1, authorityRevision: 1, revision: 1 } } : { ok: true, value: message.op === "lease" ? { accessToken: "scratch-oauth-only", accountId: "scratch-account", epoch: 1, authorityRevision: 1, revision: 1 } : { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "scratch-account", models: [{ id: model.id, name: "Scratch account model" }, { id: astra.id, name: "Astra fixture" }, { id: "unknown-capabilities", name: "Do not invent capabilities" }] } }),
			});
		});
		callback?.(); return true;
	} });
	await refreshChatGPTModels([model, astra]);
	globalThis.fetch = async (input, init) => {
		const req = new Request(input, init);
		requests.push({ authorization: req.headers.get("authorization"), body: JSON.parse(await req.text()), url: req.url });
		return new Response(responseEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
});
after(() => {
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	globalThis.fetch = realFetch;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
});
const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const complete = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "resp_scratch", status: "completed", output, usage } });
const context = () => normalizeContext({ systemPrompt: "Scratch teacher instructions", messages: [{ role: "user", content: [{ type: "text", text: "Scratch learning material" }, { type: "image", data: "c2NyYXRjaA==", mimeType: "image/png" }], timestamp: 1 }], tools: [{ name: "scratch_tool", description: "Scratch local tool", parameters: Type.Object({ value: Type.String() }) }] });

function stalledResponse(signal: AbortSignal, events: unknown[] = [], onAbort = () => {}) {
	let abort: () => void;
	return new Response(new ReadableStream({
		start(controller) {
			for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
			abort = () => { onAbort(); controller.error(new DOMException("Aborted", "AbortError")); };
			if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		},
		cancel() { onAbort(); signal.removeEventListener("abort", abort); },
	}), { headers: { "content-type": "text/event-stream" } });
}

test("a silent lesson timeout cancels its request before one focused recovery with the same account/model/history", async () => {
	const pacing = { ...createLessonPacing(), attemptMs: 35, turnMs: 3000 };
	let calls = 0, aborted = false, admitted = 0;
	const bodies: any[] = [];
	const stream = chatGPTStream(() => false, { captured() {}, beforeDispatch() { admitted++; }, noDispatch() { assert.fail("already admitted"); } }, false, pacing);
	const result = await stream({ ...astra, provider: "chatgpt" }, context(), { reasoning: "low", fetch: async (input, init) => {
		const req = new Request(input, init); bodies.push(await req.clone().json());
		assert.equal(req.headers.get("authorization"), "Bearer scratch-oauth-only");
		if (++calls === 1) return stalledResponse(req.signal, [{ type: "response.created", response: { id: "slow" } }], () => { aborted = true; });
		assert(aborted, "the first request must be cancelled before spending on another");
		return new Response(`data: ${JSON.stringify(complete())}\n\n`, { headers: { "content-type": "text/event-stream" } });
	} }).result();
	assert.equal(result.stopReason, "stop", JSON.stringify({ error: result.errorMessage, calls, admitted, aborted })); assert.equal(calls, 2); assert.equal(admitted, 1);
	assert.deepEqual(bodies[1].input, bodies[0].input, "preserve learner answers, images and completed tools");
	assert(bodies[1].instructions.endsWith(LESSON_RECOVERY_INSTRUCTIONS));
	assert.equal(bodies[1].model, astra.id); assert.equal(bodies[1].reasoning.effort, "low");
	assert.equal(bodies[0].reasoning.context, "current_turn"); assert.equal(bodies[1].reasoning.context, "current_turn");
	assert.equal(bodies[1].max_output_tokens, undefined, "subscription requests must omit unsupported caps");
	assert.equal(pacing.recoveryUsed, true);
});

test("a second silent timeout settles as a retryable error, not a user cancellation or endless loop", async () => {
	let calls = 0;
	const stream = chatGPTStream(() => false, undefined, false, { ...createLessonPacing(), attemptMs: 25, turnMs: 3000 });
	const source = stream({ ...astra, provider: "chatgpt" }, context(), { fetch: async (input, init) => { calls++; return stalledResponse(new Request(input, init).signal); } });
	const events = []; for await (const event of source) events.push(event);
	const result = await source.result();
	assert.equal(calls, 2); assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /took too long/);
	assert.equal(events.filter(e => e.type === "error").length, 1);
	assert.equal(events.filter(e => e.type === "start").length, 1, "recovery is one logical assistant message");
});

test("Stop during a paced request cancels immediately and never spends on recovery", async () => {
	let calls = 0;
	const controller = new AbortController();
	const stream = chatGPTStream(() => false, undefined, false, { ...createLessonPacing(), attemptMs: 100, turnMs: 3000 });
	const result = await stream({ ...astra, provider: "chatgpt" }, context(), { signal: controller.signal, fetch: async (input, init) => {
		calls++; setTimeout(() => controller.abort(), 10); return stalledResponse(new Request(input, init).signal);
	} }).result();
	assert.equal(calls, 1); assert.equal(result.stopReason, "aborted");
});

for (const kind of ["text", "tool"] as const) test(`a timed-out partial ${kind} is preserved and never automatically replayed`, async () => {
	let calls = 0;
	const events = kind === "tool" ? [
		{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "scratch_tool", namespace: "learnharness", arguments: "" } },
	] : [
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_partial", role: "assistant", content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "A partial explanation" },
	];
	const stream = chatGPTStream(() => false, undefined, false, { ...createLessonPacing(), attemptMs: 35, turnMs: 3000 });
	const result = await stream({ ...astra, provider: "chatgpt" }, context(), { fetch: async (input, init) => { calls++; return stalledResponse(new Request(input, init).signal, events); } }).result();
	assert.equal(calls, 1); assert.equal(result.stopReason, "error");
	assert(result.content.some(b => b.type === (kind === "tool" ? "toolCall" : "text")));
});

test("the lesson deadline and recovery allowance are shared across model/tool calls", async () => {
	const pacing = { ...createLessonPacing(), attemptMs: 25, turnMs: 3000 };
	const stream = chatGPTStream(() => false, undefined, false, pacing);
	let calls = 0;
	const fetch: typeof globalThis.fetch = async () => { calls++; return new Response(`data: ${JSON.stringify(complete())}\n\n`, { headers: { "content-type": "text/event-stream" } }); };
	assert.equal((await stream({ ...astra, provider: "chatgpt" }, context(), { fetch }).result()).stopReason, "stop");
	pacing.deadline = Date.now() - 1;
	const result = await stream({ ...astra, provider: "chatgpt" }, context(), { fetch }).result();
	assert.equal(calls, 1); assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /took too long/);
});

test("one silent incomplete response recovers, but a subscription usage refusal never does", async () => {
	for (const quota of [false, true]) {
		let calls = 0;
		const pacing = { ...createLessonPacing(), attemptMs: 500, turnMs: 3000 };
		const stream = chatGPTStream(() => false, undefined, false, pacing);
		const result = await stream({ ...astra, provider: "chatgpt" }, context(), { fetch: async () => {
			const event = ++calls === 1 ? quota
				? { type: "error", code: "subscription_sharing_usage_limit_exceeded" }
				: { type: "response.incomplete", response: { id: "silent", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" }, usage } }
				: complete();
			return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		} }).result();
		assert.equal(calls, quota ? 1 : 2); assert.equal(result.stopReason, quota ? "error" : "stop");
		if (quota) assert.match(result.errorMessage!, /plan usage limit/);
	}
});

test("a later tool continuation does not get a second automatic recovery allowance", async () => {
	const pacing = { ...createLessonPacing(), attemptMs: 25, turnMs: 3000, recoveryUsed: true };
	const stream = chatGPTStream(() => false, undefined, false, pacing);
	let calls = 0;
	const result = await stream({ ...astra, provider: "chatgpt" }, context(), { fetch: async (input, init) => { calls++; return stalledResponse(new Request(input, init).signal); } }).result();
	assert.equal(calls, 1); assert.equal(result.stopReason, "error");
});

test("catalog intersects supported capabilities, without inventing model limits", () => {
	assert.equal(chatGPTModels().length, 2);
	assert.equal(chatGPTModels()[0]!.provider, "chatgpt");
	assert.equal(chatGPTModels()[0]!.contextWindow, model.contextWindow);
	assert.deepEqual(chatGPTModels()[0]!.input, model.input);
});

test("alias resolves only OAuth; native Responses body is stateless/namespaced, image/history preserved and logical output retained", async () => {
	requests = [];
	const tool = { type: "function_call", id: "fc_scratch", call_id: "call_scratch", name: "scratch_tool", namespace: "learnharness", arguments: '{"value":"yes"}', status: "completed" };
	const reasoning = { type: "reasoning", id: "rs_scratch", summary: [], encrypted_content: "scratch-encrypted-reasoning" };
	responseEvents = [{ type: "response.created", response: { id: "resp_scratch" } }, { type: "response.output_item.added", output_index: 0, item: reasoning }, { type: "response.output_item.done", output_index: 0, item: reasoning }, { type: "response.output_item.added", output_index: 1, item: tool }, { type: "response.output_item.done", output_index: 1, item: tool }, complete([reasoning, tool])];
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	const stream = engine.streamFn(engine.model, context(), { temperature: 0.7, maxTokens: 1000, samplingParams: { top_p: 0.5 }, onPayload: (payload) => ({ ...payload as object, model: "caller-cannot-change", dangerous: true }) });
	const events = [];
	for await (const event of stream) { events.push(event); if ("partial" in event) assert.equal(event.partial.provider, "chatgpt"); }
	const result = await stream.result();
	assert.equal(result.provider, "chatgpt"); assert.equal(result.stopReason, "toolUse");
	assert.equal(requests.length, 1); assert.equal(requests[0]!.url, "https://api.openai.com/v1/responses");
	assert.equal(requests[0]!.authorization, "Bearer scratch-oauth-only");
	const body = requests[0]!.body;
	assert.equal(body.store, false); assert.equal(body.stream, true);
	for (const key of ["temperature", "top_p", "max_output_tokens", "previous_response_id", "background", "metadata", "prompt_cache_retention"]) assert.equal(body[key], undefined, key);
	assert.equal(body.input[0].role, "developer");
	assert.equal(body.input[1].content[1].type, "input_image");
	assert.equal(body.tools[0].type, "namespace"); assert.equal(body.tools[0].tools[0].name, "scratch_tool");
	const call = result.content.find((block) => block.type === "toolCall")!;
	assert.equal(call.id, "call_scratch|fc_scratch"); assert.equal(call.namespace, "learnharness");
	const thinking = result.content.find((block) => block.type === "thinking")!;
	assert.equal(thinking.thinkingSignature, JSON.stringify(reasoning));
	const history = normalizeContext({ messages: [...context().messages, result, { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, content: [{ type: "text", text: "Scratch tool result" }], timestamp: 2 }] });
	responseEvents = [complete()];
	await engine.streamFn(engine.model, history).result();
	const replay = requests[1]!.body.input;
	assert(replay.some((item: any) => item.encrypted_content === "scratch-encrypted-reasoning"));
	assert(replay.some((item: any) => item.type === "function_call" && item.id === "fc_scratch" && item.namespace === "learnharness"));
	assert(replay.some((item: any) => item.type === "function_call_output" && item.call_id === "call_scratch"));
});

test("interactive Astra limits reasoning context without deleting signed history, changing effort or affecting background models", async () => {
	const signature = { type: "reasoning", id: "rs_history", summary: [], encrypted_content: "opaque-prior-reasoning" };
	const prior: AssistantMessage = { role: "assistant", provider: "chatgpt", api: "openai-responses", model: astra.id, content: [
		{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(signature), redacted: true },
		{ type: "toolCall", id: "call_history|fc_history", name: "scratch_tool", namespace: "learnharness", arguments: { value: "earlier work" } },
	], stopReason: "toolUse", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 };
	const history = normalizeContext({ ...context(), messages: [...context().messages, prior, { role: "toolResult", toolCallId: "call_history|fc_history", toolName: "scratch_tool", content: [{ type: "text", text: "Completed work" }], isError: false, timestamp: 2 }] });
	const saved = JSON.stringify(history);
	for (const [selected, interactive] of [[astra, true], [astra, false], [model, true]] as const) {
		requests = []; responseEvents = [complete()];
		const engine = piEngineForSpec({ provider: "chatgpt", id: selected.id, thinkingLevel: "low" }, false, undefined, undefined, interactive);
		await engine.streamFn(engine.model, history).result();
		const body = requests[0]!.body;
		assert.equal(body.reasoning.context, interactive && selected === astra ? "current_turn" : undefined);
		assert.equal(body.reasoning.effort, "low");
		if (selected === astra) {
			assert(body.input.some((item: any) => item.encrypted_content === signature.encrypted_content));
			assert(body.input.some((item: any) => item.type === "function_call" && item.id === "fc_history"));
			assert(body.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_history"));
		}
	}
	assert.equal(JSON.stringify(history), saved, "saved lesson history must not be changed");
});

test("mixed history never blanket-relabels API providers or reuses foreign reasoning signatures", () => {
	const native: AssistantMessage = { role: "assistant", provider: "openai", api: "openai-responses", model: model.id, content: [{ type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"API-only"}', redacted: true }], stopReason: "stop", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 };
	const own = { ...native, provider: "chatgpt", content: [{ type: "thinking" as const, thinking: "", thinkingSignature: '{"encrypted_content":"ChatGPT-only"}', redacted: true }] };
	const transformed = chatGPTHistory(normalizeContext({ messages: [native, own] }), { ...model, provider: "chatgpt" });
	assert.equal((transformed.messages[0] as AssistantMessage).provider, "openai");
	assert.deepEqual((transformed.messages[0] as AssistantMessage).content, []);
	assert.equal((transformed.messages[1] as AssistantMessage).content[0]!.type, "thinking");
	assert.equal(native.content.length, 1, "source history must not be mutated");
});

test("Astra Fast opt-in reaches the final OAuth request and preserves Low effort across calls", async () => {
	for (const fastMode of [undefined, false, true]) {
		requests = []; responseEvents = [complete()];
		const engine = piEngineForSpec({ provider: "chatgpt", id: astra.id, thinkingLevel: "low", fastMode }, false);
		for (let step = 0; step < 2; step++) {
			const result = await engine.streamFn(engine.model, context(), {
				onPayload: raw => ({ ...raw as object, service_tier: "ultrafast" }),
			}).result();
			assert.equal(result.stopReason, "stop");
		}
		assert.equal(requests.length, 2);
		for (const request of requests) {
			assert.equal(request.body.model, astra.id);
			assert.equal(request.body.reasoning.effort, "low");
			assert.equal(request.body.service_tier, fastMode ? "priority" : undefined);
			assert.equal(request.authorization, "Bearer scratch-oauth-only");
		}
	}
	assert.equal(chatGPTPayload({ input: [], service_tier: "fast" }, model.id, true).service_tier, undefined);
});

test("Fast tier refusal explains how to return to Standard without silently changing tier or credentials", async () => {
	requests = [];
	responseEvents = [{ type: "error", code: "service_tier_access_denied", message: "private account detail" }];
	const engine = piEngineForSpec({ provider: "chatgpt", id: astra.id, thinkingLevel: "low", fastMode: true }, false);
	const result = await engine.streamFn(engine.model, context()).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /Choose Standard/);
	assert(!result.errorMessage!.includes("private account detail"));
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.body.service_tier, "priority");
});

test("reported processing speed comes from completion, never the request or preliminary events", async () => {
	for (const [tier, served] of [["priority", "fast"], ["fast", "fast"], ["default", "standard"], ["auto", "unconfirmed"], [undefined, "unconfirmed"]] as const) {
		requests = [];
		responseEvents = [
			{ type: "response.created", response: { id: "resp_scratch", service_tier: "priority" } },
			{ ...complete(), response: { ...complete().response, service_tier: tier } },
		];
		const engine = piEngineForSpec({ provider: "chatgpt", id: astra.id, thinkingLevel: "low", fastMode: true }, false);
		const result = await engine.streamFn(engine.model, context()).result();
		assert.equal(result.stopReason, "stop");
		assert.equal(requests.length, 1, "A Standard response must not trigger another billed request");
		assert.deepEqual(chatGPTSpeedForUsage(result.usage), { requested: "fast", served });
		assert(!JSON.stringify(result).includes("chatgptSpeed"), "Processing metadata stays out of model history");
	}
	responseEvents = [{ ...complete(), response: { ...complete().response, service_tier: "default" } }];
	const standard = piEngineForSpec({ provider: "chatgpt", id: astra.id, thinkingLevel: "low" }, false);
	const result = await standard.streamFn(standard.model, context()).result();
	assert.deepEqual(chatGPTSpeedForUsage(result.usage), { requested: "standard", served: "standard" });
	responseEvents = [{ type: "response.failed", response: { status: "failed", service_tier: "priority", error: { code: "server_error" } } }];
	const failed = await standard.streamFn(standard.model, context()).result();
	assert.equal(failed.stopReason, "error");
	assert.equal(chatGPTSpeedForUsage(failed.usage), undefined);
});

test("no terminal completed is never success; late quota/incomplete streams are actionable/redacted", async () => {
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	for (const events of [[{ type: "response.created", response: { id: "resp_partial" } }], [{ type: "response.incomplete", response: { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" }, usage } }], [{ type: "error", code: "subscription_sharing_usage_limit_exceeded", message: "secret scratch provider diagnostic" }]]) {
		responseEvents = events;
		const result = await engine.streamFn(engine.model, context()).result();
		assert.equal(result.stopReason, "error"); assert.equal(result.provider, "chatgpt");
		assert(!result.errorMessage?.includes("secret scratch provider diagnostic"));
		if (JSON.stringify(events).includes("usage_limit")) assert(result.errorMessage?.includes("https://chatgpt.com/settings/usage"));
	}
});

test("OAuth failure and background denial NEVER use ambient OPENAI_API_KEY", async () => {
	requests = [];
	for (const error of ["expired ChatGPT session", "Background use is off", "catalog unavailable", "quota exceeded"]) {
		leaseError = error;
		const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, true);
		assert.equal((await engine.streamFn(engine.model, context()).result()).stopReason, "error");
	}
	leaseError = null;
	assert.equal(requests.length, 0);
});

test("consent revocation cancels only applicable background streams and preserves foreground", () => {
	const foreground = chatGPTAbortController(false);
	const background = chatGPTAbortController(true);
	ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 2 }, status, invalidate: "background" });
	assert.equal(foreground.controller.signal.aborted, false);
	assert.equal(background.controller.signal.aborted, true);
	foreground.release(); background.release();
});

test("payload sanitizer omits unsupported fields and rejects unsupported hosted tools", () => {
	assert.deepEqual(chatGPTPayload({ model: "scratch", input: [], stream: false, store: true, metadata: { test: true }, previous_response_id: "old", background: true }, "scratch"), { model: "scratch", input: [], stream: true, store: false });
	assert.throws(() => chatGPTPayload({ input: [], tools: [{ type: "tool_search" }] }, "scratch"), /Unsupported/);
});

test("native identity/session/cache/fetch and awaited caller observers survive enforcement; terminal outcome exactly once", async () => {
	const { APP_IDENTITY } = await import("../src/agent/models.ts");
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	let headers = new Headers(), payload: any, observed = 0, responses = 0, delegated = 0;
	responseEvents = [complete()];
	const stream = engine.streamFn(engine.model, context(), {
		identity: APP_IDENTITY, sessionId: "exact-native-chat-session", timeoutMs: 12345,
		headers: { "x-native-observer": "retained", "x-suppressed": null },
		fetch: async (input, init) => { delegated++; const req = new Request(input, init); headers = req.headers; payload = JSON.parse(await req.text()); return new Response(`data: ${JSON.stringify(complete())}\n\n`, { headers: { "content-type": "text/event-stream" } }); },
		onPayload: async (raw, native) => { await Promise.resolve(); assert.equal(native.provider, "openai"); return { ...raw as object, model: "not-the-selected-model", store: true, metadata: { forbidden: true } }; },
		onResponse: async (_response, native) => { await Promise.resolve(); assert.equal(native.provider, "openai"); responses++; },
		onProviderStreamEvent: async (_raw, native) => { await Promise.resolve(); assert.equal(native.provider, "openai"); observed++; },
	});
	const events = []; for await (const event of stream) events.push(event);
	assert.equal(delegated, 1); assert.equal(observed, 1); assert.equal(responses, 1);
	assert.equal(headers.get("user-agent"), APP_IDENTITY.userAgent.custom);
	assert.equal(headers.get("session_id"), "exact-native-chat-session");
	assert.equal(headers.get("x-client-request-id"), "exact-native-chat-session");
	assert.equal(headers.get("x-native-observer"), "retained"); assert.equal(headers.get("x-suppressed"), null);
	assert.equal(payload.prompt_cache_key, "exact-native-chat-session"); assert.equal(payload.model, model.id); assert.equal(payload.metadata, undefined);
	assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
	const failed = engine.streamFn(engine.model, context(), { onProviderStreamEvent: async () => { throw new Error("private observer detail"); } });
	const failedEvents = []; for await (const event of failed) failedEvents.push(event);
	assert.equal(failedEvents.filter((e) => e.type === "error").length, 1); assert.equal(failedEvents.filter((e) => e.type === "done").length, 0);
	assert(!(await failed.result()).errorMessage?.includes("private observer detail"));
});

test("background capture matches final ChatGPT transport body without changing awaited callbacks or foreground", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chatgpt-capture-"));
	const previousDir = backgroundCaptureDir.current, previousFlag = process.env.LH_BACKGROUND_CAPTURE;
	backgroundCaptureDir.current = dir; process.env.LH_BACKGROUND_CAPTURE = "all";
	t.after(() => {
		backgroundCaptureDir.current = previousDir;
		if (previousFlag === undefined) delete process.env.LH_BACKGROUND_CAPTURE; else process.env.LH_BACKGROUND_CAPTURE = previousFlag;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, true);
	const capture = createBackgroundCapture({ role: "auditor", runId: "chatgpt-final" })!;
	const observed = backgroundCaptureStream(engine.streamFn, capture);
	let callbackFinished = false, responseObserved = false, actualBody: unknown;
	responseEvents = [complete()];
	const result = await observed(engine.model, context(), {
		onPayload: async (raw, native) => {
			await Promise.resolve(); assert.equal(native.provider, "openai"); callbackFinished = true;
			return { ...raw as object, model: "must-not-survive", metadata: { private: "must-not-survive" }, dangerous: true };
		},
		onResponse: async () => { await Promise.resolve(); responseObserved = true; },
		fetch: async (input, init) => {
			assert(callbackFinished);
			const request = new Request(input, init);
			assert.equal(request.headers.get("authorization"), "Bearer scratch-oauth-only");
			actualBody = JSON.parse(await request.text());
			return new Response(`data: ${JSON.stringify(complete())}\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	}).result();
	capture.reply(result); capture.finish();
	assert(responseObserved); assert.equal(result.stopReason, "stop");
	const record = JSON.parse(fs.readFileSync(path.join(dir, "auditor-chatgpt-final.json"), "utf8"));
	assert.deepEqual(record.request.payload, actualBody);
	assert.equal(record.request.format, "provider");
	assert.equal(record.request.model.provider, "chatgpt");
	assert.equal(record.request.payload.input[0].role, "developer");
	assert.equal(record.request.payload.tools[0].type, "namespace");
	assert.equal(record.request.payload.metadata, undefined);
	assert.equal(record.request.payload.dangerous, undefined);
	assert(!JSON.stringify(record).includes("scratch-oauth-only"));
	assert(!JSON.stringify(record).includes("must-not-survive"));
	await engine.streamFn(engine.model, context()).result();
	assert.equal(fs.readdirSync(dir).length, 1, "No async-local observer leaks into ordinary foreground/direct calls");
});

test("case-insensitive Authorization overrides including null are refused before native fetch", async () => {
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
	const before = requests.length;
	for (const headers of [{ Authorization: "Bearer wrong" }, { authorization: null }, { AUTHORIZATION: "" }] as Record<string, string | null>[]) {
		assert.equal((await engine.streamFn(engine.model, context(), { headers }).result()).stopReason, "error");
	}
	assert.equal(requests.length, before);
});

test("transient HTTP retry keeps the exact payload, identity, account, and single admission", { timeout: 10000 }, async () => {
	let admitted = 0, captured = 0, payloads = 0, denied = 0;
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false, {
		captured: () => { captured++; }, beforeDispatch: () => { admitted++; }, noDispatch: () => { denied++; },
	});
	const bodies: string[] = [], headers: Headers[] = [];
	const result = await engine.streamFn(engine.model, context(), {
		sessionId: "same-session", onPayload: () => { payloads++; },
		fetch: async (input, init) => {
			const request = new Request(input, init); bodies.push(await request.text()); headers.push(request.headers);
			return bodies.length === 1 ? Response.json({ error: { code: "subscription_sharing_usage_unavailable" } }, { status: 503 }) : new Response(`data: ${JSON.stringify(complete())}\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	}).result();
	assert.equal(result.stopReason, "stop"); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
	assert.equal(captured, 1); assert.equal(admitted, 1); assert.equal(payloads, 1); assert.equal(denied, 0);
	for (const header of headers) { assert.equal(header.get("authorization"), "Bearer scratch-oauth-only"); assert.equal(header.get("session_id"), "same-session"); }
});

test("background consent revocation during backoff cancels without a second request", { timeout: 1000 }, async () => {
	const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, true);
	let attempts = 0;
	const result = await engine.streamFn(engine.model, context(), { fetch: async () => {
		attempts++;
		setTimeout(() => ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 2 }, status, invalidate: "background" }), 10);
		return Response.json({ error: { code: "server_is_overloaded" } }, { status: 503 });
	} }).result();
	assert.equal(result.stopReason, "aborted"); assert.equal(attempts, 1);
});

test("full credential-storage invalidation aborts foreground and background controllers and clears capabilities", () => {
	const foreground = chatGPTAbortController(false), background = chatGPTAbortController(true);
	ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 2, revision: 3 }, status: { ...status, available: false }, invalidate: "all" });
	assert(foreground.controller.signal.aborted); assert(background.controller.signal.aborted); assert.equal(chatGPTModels().length, 0);
	foreground.release(); background.release();
});
