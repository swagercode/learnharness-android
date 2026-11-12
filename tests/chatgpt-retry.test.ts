import { test } from "node:test";
import assert from "node:assert/strict";
import { retryChatGPTRequest } from "../src/agent/chatgpt-retry.ts";
import { chatGPTStreamError } from "../src/agent/chatgpt-stream.ts";

function clock() {
	let now = Date.parse("2026-11-12T12:00:00Z");
	const delays: number[] = [];
	return { now: () => now, random: () => 0, delays,
		sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); delays.push(ms); now += ms; },
		advance: (ms: number) => { now += ms; },
	};
}
const errorResponse = (status: number, code?: string, headers?: HeadersInit) => Response.json({ error: { code } }, { status, headers });

test("temporary service, proxy, request-timeout, conflict, and explicit rate limits recover", async () => {
	for (const [status, code] of [[500, undefined], [502, undefined], [503, "subscription_sharing_user_unavailable"], [503, "subscription_sharing_usage_unavailable"], [504, undefined], [408, undefined], [409, undefined], [429, "slow_down"], [429, "rate_limit_exceeded"]] as const) {
		const time = clock(); let attempts = 0;
		const result = await retryChatGPTRequest(async () => ++attempts === 1 ? errorResponse(status, code) : new Response("ready"), new AbortController().signal, time);
		assert.equal(await result.text(), "ready"); assert.equal(attempts, 2); assert.deepEqual(time.delays, [2000]);
	}
});

test("network fetch errors and known connection failures recover without catching arbitrary exceptions", async () => {
	for (const error of [new TypeError("fetch failed"), new TypeError("Failed to fetch"), Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), new TypeError("fetch failed", { cause: { code: "EAI_AGAIN" } })]) {
		let attempts = 0;
		const result = await retryChatGPTRequest(async () => { if (++attempts === 1) throw error; return new Response("ready"); }, new AbortController().signal, clock());
		assert.equal(await result.text(), "ready"); assert.equal(attempts, 2);
	}
	for (const error of [new Error("observer failed"), new TypeError("Cannot read properties of undefined"), new DOMException("Cancelled", "AbortError")]) {
		let attempts = 0;
		await assert.rejects(retryChatGPTRequest(async () => { attempts++; throw error; }, new AbortController().signal, clock()), (caught) => caught === error);
		assert.equal(attempts, 1);
	}
});

test("auth, plan limits, invalid capabilities, and ambiguous 429s never retry", async () => {
	for (const [status, code] of [[401, "invalid_user"], [403, "permission_denied"], [400, "subscription_sharing_unsupported_capability"], [429, "subscription_sharing_usage_limit_exceeded"], [429, "subscription_sharing_workplace_individual_usage_limit_exceeded"], [429, "insufficient_quota"], [429, undefined], [503, "invalid_grant"]] as const) {
		const time = clock(); const response = errorResponse(status, code, { "x-should-retry": "true" }); let attempts = 0;
		assert.equal(await retryChatGPTRequest(async () => { attempts++; return response; }, new AbortController().signal, time), response);
		assert.equal(attempts, 1); assert.deepEqual(time.delays, []);
		assert.deepEqual(await response.json(), { error: code ? { code } : {} }, "classification preserves the SDK error body");
	}
});

test("server no-retry instruction is respected", async () => {
	const time = clock(); let attempts = 0;
	await retryChatGPTRequest(async () => { attempts++; return errorResponse(503, undefined, { "x-should-retry": "false" }); }, new AbortController().signal, time);
	assert.equal(attempts, 1); assert.deepEqual(time.delays, []);
});

test("Retry-After seconds, HTTP dates, and milliseconds are minimum waits", async () => {
	for (const [headers, expected] of [[{ "retry-after": "15" }, 15000], [{ "retry-after": "Thu, 12 Nov 2026 12:00:20 GMT" }, 20000], [{ "retry-after-ms": "12500" }, 12500], [{ "retry-after": "20", "retry-after-ms": "5000" }, 20000], [{ "retry-after": "0.1" }, 2000], [{ "retry-after": "garbage" }, 2000]] as const) {
		const time = clock(); let attempts = 0;
		await retryChatGPTRequest(async () => ++attempts === 1 ? errorResponse(503, undefined, headers) : new Response(), new AbortController().signal, time);
		assert.deepEqual(time.delays, [expected]);
	}
});

test("five retries use exponential backoff and jitter then return the last error intact", async () => {
	const time = clock(); let attempts = 0;
	const result = await retryChatGPTRequest(async () => { attempts++; return errorResponse(503, "server_is_overloaded"); }, new AbortController().signal, { ...time, random: () => 0.8 });
	assert.equal(attempts, 6); assert.deepEqual(time.delays, [2400, 4800, 9600, 19200, 38400]);
	assert.equal(result.status, 503); assert.equal((await result.json()).error.code, "server_is_overloaded");
});

test("exhausted network retries propagate the original failure", async () => {
	const failure = new TypeError("fetch failed"); let attempts = 0;
	await assert.rejects(retryChatGPTRequest(async () => { attempts++; throw failure; }, new AbortController().signal, clock()), (error) => error === failure);
	assert.equal(attempts, 6);
});

test("long Retry-After and elapsed request time stop further retries instead of retrying early", async () => {
	for (const slowRequest of [false, true]) {
		const time = clock(); let attempts = 0;
		const response = await retryChatGPTRequest(async () => { attempts++; if (slowRequest) time.advance(299000); return errorResponse(503, undefined, { "retry-after": slowRequest ? "1" : "600" }); }, new AbortController().signal, time);
		assert.equal(response.status, 503); assert.equal(attempts, 1); assert.deepEqual(time.delays, []);
	}
});

test("Android suspension past the retry deadline retains the final error and does not dispatch", async () => {
	const time = clock(); let attempts = 0;
	const response = await retryChatGPTRequest(async () => { attempts++; return errorResponse(503, "server_is_overloaded"); }, new AbortController().signal, { ...time, sleep: async () => { time.advance(300001); } });
	assert.equal(attempts, 1); assert.equal((await response.json()).error.code, "server_is_overloaded");
});

test("Stop cancels a real backoff immediately, and pre-cancelled work never dispatches", async () => {
	for (const alreadyAborted of [false, true]) {
		const controller = new AbortController(); let attempts = 0;
		if (alreadyAborted) controller.abort();
		const result = retryChatGPTRequest(async () => { attempts++; setTimeout(() => controller.abort(), 10); return errorResponse(503); }, controller.signal);
		await assert.rejects(result, { name: "AbortError" });
		assert.equal(attempts, alreadyAborted ? 0 : 1);
	}
});

test("a successful streaming response is handed through without reading or replaying its body", async () => {
	let attempts = 0;
	const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: partial\n\n")); controller.error(new Error("interrupted after output")); } }));
	assert.equal(await retryChatGPTRequest(async () => { attempts++; return response; }, new AbortController().signal, clock()), response);
	await assert.rejects(response.text(), /interrupted/); assert.equal(attempts, 1);
});

test("rate limiting and service failures are not mislabeled as an exhausted plan", () => {
	assert.match(chatGPTStreamError("429 slow_down"), /temporarily limiting/);
	assert.match(chatGPTStreamError("503 server_is_overloaded"), /temporarily unavailable/);
	assert.match(chatGPTStreamError("subscription_sharing_workplace_individual_usage_limit_exceeded"), /plan usage limit/);
});
