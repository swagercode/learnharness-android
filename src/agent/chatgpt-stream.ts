import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { chatGPTAbortController, chatGPTScope, chatGPTScopeCurrent, chatGPTLease, chatGPTDenial } from "./chatgpt-bridge.ts";
import type { AdmissionScope, ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { capturePreparedBackgroundPayload } from "./background-capture.ts";
import { retryChatGPTRequest } from "./chatgpt-retry.ts";
import { chatGPTServedSpeed, supportsAstraFastMode, type ChatGPTSpeed } from "../core/fast-mode.ts";
import { LESSON_PACING_ERROR, LESSON_RECOVERY_INSTRUCTIONS, type LessonPacing } from "./lesson-pacing.ts";

// Preserve the provider's completed-response evidence alongside native usage.
// Do not add application metadata to the model's replayed message history.
const speeds = new WeakMap<object, ChatGPTSpeed>();
export function chatGPTSpeedForUsage(usage: object): ChatGPTSpeed | undefined { return speeds.get(usage); }

const USAGE = "https://chatgpt.com/settings/usage";
export function chatGPTStreamError(message: string, fastMode = false): string {
	if (message === "lesson_response_timeout") return LESSON_PACING_ERROR;
	if (fastMode && /service[_ -]tier/i.test(message)) return "ChatGPT could not use Fast mode for this request. Choose Standard under Thinking → Astra speed, then retry. Your session is preserved; no API-key fallback was used.";
	if (/usage_limit|quota/.test(message)) return `ChatGPT plan usage limit reached. Manage usage at ${USAGE}. No API-key fallback was used.`;
	if (/slow_down|rate_limit|429/.test(message)) return "ChatGPT is temporarily limiting requests. Automatic retries could not complete this request. Try again later.";
	if (/subscription_sharing_(usage|user)_unavailable|server_is_overloaded|50[0234]/.test(message)) return "ChatGPT is temporarily unavailable. Automatic retries could not complete this request. Try again later.";
	if (/scope|authorization_context|permission/.test(message)) return "ChatGPT plan permission is missing. Reconnect in Providers and authorize plan use. No API-key fallback was used.";
	if (/expired|invalid_grant|401|invalid_user/.test(message)) return "Your ChatGPT session expired. Reconnect in Providers. No API-key fallback was used.";
	if (/background|Background/.test(message)) return "ChatGPT background use is off in this app. Enable Allow background use for all ChatGPT accounts in Providers to run this work. No API-key fallback was used.";
	if (/eligible|403/.test(message)) return "This ChatGPT account or workspace does not permit this request. Check ChatGPT settings; reconnecting may not change eligibility.";
	if (/cancel|abort|closed|disconnect/i.test(message)) return "ChatGPT request cancelled or connection closed. No API-key fallback was used.";
	if (/catalog|model/.test(message)) return "The selected model is unavailable for this ChatGPT account. Refresh Providers and explicitly choose an available model. No API-key fallback was used.";
	if (/incomplete|terminal|interrupted|stop reason/.test(message)) return "ChatGPT returned an incomplete response. Retry when ready; no API-key fallback was used.";
	return "ChatGPT request failed. Temporary connection and service failures are retried automatically. Check your connection and ChatGPT usage if this keeps happening. No API-key fallback was used.";
}

/** Restrict the body at the final payload seam, even if caller samplingParams add fields. */
export function chatGPTPayload(raw: unknown, selectedModelId: string, fastMode = false): Record<string, unknown> {
	const payload = raw as Record<string, unknown>;
	const out: Record<string, unknown> = { model: selectedModelId, store: false, stream: true };
	// The saved opt-in owns this field; caller payload hooks cannot enable
	// a higher-usage tier or silently downgrade an explicit Fast request.
	// The ChatGPT plan endpoint rejects "fast"; "priority" is the documented
	// equivalent and the value advertised in its account model catalog.
	if (fastMode && supportsAstraFastMode({ provider: "chatgpt", id: selectedModelId })) out.service_tier = "priority";
	for (const key of ["instructions", "reasoning", "include", "text", "tool_choice", "parallel_tool_calls", "prompt_cache_key"]) {
		if (payload[key] !== undefined) out[key] = payload[key];
	}
	if (!Array.isArray(payload.input)) throw new Error("ChatGPT requires stateless input history");
	out.input = payload.input.map((item) => item?.role === "system" ? { ...item, role: "developer" } : item);
	if (Array.isArray(payload.tools) && payload.tools.length) {
		if (payload.tools.some((tool) => tool.type !== "function" && tool.type !== "custom")) throw new Error("Unsupported ChatGPT tool capability");
		out.tools = [{ type: "namespace", name: "learnharness", description: "LearnHarness local learning tools", tools: payload.tools }];
	}
	return out;
}

/** Only ChatGPT history is translated. Mixed API-key history keeps its actual identity. */
export function chatGPTHistory(context: TranscriptContext, logicalModel: Model<Api>): TranscriptContext {
	// Apply Pi's normal foreign-model signature treatment BEFORE the alias
	// becomes openai, or real API-key turns could look like subscription turns.
	const messages = transformMessages(context.messages, logicalModel);
	return { ...context, messages: messages.map((m) => m.role === "assistant" && m.provider === "chatgpt" ? { ...m, provider: "openai" } : m) };
}
function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: "chatgpt", model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function chatGPTStream(background: () => boolean, lifecycle?: ChatGPTDispatchLifecycle, fastMode = false, pacing?: LessonPacing): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const useFastMode = fastMode && supportsAstraFastMode(logicalModel);
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = chatGPTAbortController(purpose);
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		void (async () => {
			let partial = empty(logicalModel);
			let scope: AdmissionScope | undefined;
			let committed = false;
			let terminal = false;
			let started = false;
			const check = () => { if (signal.aborted || !scope || !chatGPTScopeCurrent(scope)) throw new Error("cancelled or catalog authority changed"); };
			try {
				if (logicalModel.provider !== "chatgpt") throw new Error("ChatGPT account catalog has no selected model");
				if (Object.keys(options?.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) throw new Error("Authorization override is forbidden");
				scope = chatGPTScope(logicalModel.id);
				lifecycle?.captured(scope);
				const credentials = await chatGPTLease(scope, purpose);
				check();
				// NEVER dispatch through Models under openai: that would expose ambient API-key fallback.
				const transport: Model<"openai-responses"> = { ...logicalModel, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", headers: undefined, samplingParams: undefined, compat: { ...logicalModel.compat, supportsDeveloperRole: true } };
				const delegate = options?.fetch ?? globalThis.fetch;
				// A silent attempt may be replaced once, before any text or tool
				// call is delivered. Completed work from earlier calls is retained
				// in context; recovery never reruns an already executed tool.
				let recovering = false;
				for (;;) {
					let completed = false;
					let servedSpeed: ChatGPTSpeed["served"] = "unconfirmed";
					let failure = "";
					let timedOut = false;
					let delivered = false;
					const attempt = new AbortController();
					const attemptSignal = AbortSignal.any([signal, attempt.signal]);
					let timer: ReturnType<typeof setTimeout> | undefined;
					if (pacing) {
						pacing.deadline ??= Date.now() + pacing.turnMs;
						const remaining = pacing.deadline - Date.now();
						if (remaining <= 0) throw new Error("lesson_response_timeout");
						timer = setTimeout(() => { timedOut = true; attempt.abort(); }, Math.min(pacing.attemptMs, remaining));
					}
					try {
						const source = streamSimple(transport, chatGPTHistory(context, logicalModel), {
							...options,
							apiKey: credentials.accessToken,
							signal: attemptSignal,
							maxRetries: 0,
							headers: { "OpenAI-Beta": null, ...options?.headers },
							fetch: (input, init) => {
								// The SDK retry layer stays disabled: one logical admission and
								// one set of input messages, even across several HTTP attempts.
								const requestSignal = init?.signal ? AbortSignal.any([attemptSignal, init.signal]) : attemptSignal;
								return retryChatGPTRequest(async (httpAttempt) => {
									check();
									const accessToken = httpAttempt === 0 && !recovering ? credentials.accessToken : (await chatGPTLease(scope!, purpose)).accessToken;
									check();
									requestSignal.throwIfAborted();
									if (!committed) {
										lifecycle?.beforeDispatch(scope!);
										committed = true;
									}
									const headers = new Headers(init?.headers);
									headers.set("authorization", `Bearer ${accessToken}`);
									return delegate(input, { ...init, headers, signal: requestSignal });
								}, requestSignal);
							},
							onPayload: async (raw, model) => {
								const replacement = await options?.onPayload?.(raw, model);
								const payload = chatGPTPayload(replacement === undefined ? raw : replacement, logicalModel.id, useFastMode);
								// Long lessons accumulate opaque reasoning from earlier replies.
								// Keep every replay item/signature for protocol continuity, but
								// ask Astra to render only the active turn's reasoning. Verified
								// on the subscription endpoint; other models keep their defaults.
								if (pacing && logicalModel.id === "gpt-6-astra") {
									payload.reasoning = { ...(payload.reasoning as Record<string, unknown> | undefined), context: "current_turn" };
								}
								if (recovering) payload.instructions = `${typeof payload.instructions === "string" ? payload.instructions : ""}\n\n${LESSON_RECOVERY_INSTRUCTIONS}`;
								check();
								capturePreparedBackgroundPayload(payload, logicalModel);
								return payload;
							},
							onProviderStreamEvent: async (raw, model) => {
								const event = raw as { type?: string; code?: string; error?: { code?: string }; response?: { error?: { code?: string }; status?: string; service_tier?: unknown } };
								if (event.type === "response.completed" && event.response?.status === "completed" && !event.response?.error) {
									completed = true;
									servedSpeed = chatGPTServedSpeed(event.response.service_tier);
								}
								if (["response.incomplete", "response.failed", "error"].includes(event.type ?? "") || event.response?.error) failure = event.code || event.error?.code || event.response?.error?.code || "incomplete terminal response";
								await options?.onProviderStreamEvent?.(raw, model);
							},
						});
						for await (const event of source) {
							const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
							// Copy the message, not its tool/reasoning blocks: IDs/signatures remain byte-for-byte intact.
							partial = { ...message, provider: "chatgpt" };
							delivered ||= partial.content.some(block => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0));
							if (timedOut) throw new Error("lesson_response_timeout");
							check();
							if (event.type === "done") {
								if (!completed || failure) throw new Error(failure || "missing terminal response.completed");
								speeds.set(partial.usage, { requested: useFastMode ? "fast" : "standard", served: servedSpeed });
								terminal = true;
								output.push({ ...event, message: partial });
							} else if (event.type === "error") {
								throw new Error(failure || event.error.errorMessage || "ChatGPT stream error");
							} else if (event.type !== "start" || !started) {
								started ||= event.type === "start";
								output.push({ ...event, partial });
							}
						}
						return;
					} catch (err) {
						const incomplete = failure === "incomplete terminal response";
						if (pacing && !pacing.recoveryUsed && !delivered && (timedOut || incomplete) && !signal.aborted && scope && chatGPTScopeCurrent(scope) && Date.now() < pacing.deadline!) {
							pacing.recoveryUsed = true;
							recovering = true;
							partial = empty(logicalModel);
							continue;
						}
						throw timedOut && !signal.aborted ? new Error("lesson_response_timeout") : err;
					} finally {
						if (timer) clearTimeout(timer);
						attempt.abort();
					}
				}
			} catch (err) {
				if (terminal) return;
				if (!committed) lifecycle?.noDispatch(await chatGPTDenial(scope, controller, options?.signal?.aborted === true, purpose));
				partial = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: chatGPTStreamError(err instanceof Error ? err.message : "", useFastMode) };
				output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
			} finally { release(); output.end(); }
		})();
		return output;
	};
}
