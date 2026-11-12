import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import { Type } from "typebox";

assert.equal(process.env.NODE_ENV, "test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-answer-continuation-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-only";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { runningTurn, settledTurnResponse, turnFailure } = await import("../src/server/turn-runs.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { SessionModel } = await import("../components/session-core.ts");
const { newUserMessage, pendingQuestionOf } = await import("../src/core/native-messages.ts");
const { buildAnswer, normalizeOptions } = await import("../src/core/question-core.ts");
const { endsInFailedTurn } = await import("../src/core/input-events.ts");
const { questionResult } = await import("../src/agent/tool-execute.ts");

const input = { question: "What are the updated predictions for A and B?", options: [{ label: "A: 20; B: 20." }, { label: "A: 170; B: 200." }], correctAnswer: "A: 170; B: 200.", explanation: "Add each new output to its existing prediction.", type: "check", nodeId: "predictions" };
const answer = buildAnswer({ id: "question", kind: "quiz", question: input.question, options: normalizeOptions(input.options), correctIndices: [2], mode: "single-select", createdAt: "fixture" }, { values: ["A: 170; B: 200."], confidence: 90 });

function fixture(steps: FauxResponseStep[], tools: AgentBuildOptions["tools"] = {}) {
	const faux = createFauxCore({}); let calls = 0;
	faux.setResponses(steps.map(step => (...args) => { calls++; return typeof step === "function" ? step(...args) : step; }));
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const chat = chatStore.createChat("Answer continuation fixture");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const question = { ...fauxAssistantMessage([fauxToolCall("quiz", input, { id: "question" })], { stopReason: "toolUse" }), id: "posed-question" } as LhMessage;
	chatStore.saveMessages(chat.id, [newUserMessage("Teach me predictions"), question]);
	const posts: string[] = [];
	const model = new SessionModel({ chatId: chat.id, initialMessages: chatStore.getChat(chat.id)!.messages, fetch: async (url, init) => {
		if (url === "/api/chat") {
			posts.push(String(init?.body));
			return handleChatRequest(new Request("http://test/api/chat", init), opts => createTeacherAgent(undefined, { ...opts, engine, tools }));
		}
		if (String(url).endsWith("/stream")) return runningTurn(chat.id) ? new Response(runningTurn(chat.id)!.subscribe()) : settledTurnResponse();
		return Response.json({ ...chatStore.getChat(chat.id), turnInFlight: isTurnRunning(chat.id), turnError: turnFailure(chat.id) });
	} });
	return { chat, model, posts, calls: () => calls, saved: () => chatStore.getChat(chat.id)!.messages };
}

for (const content of [[], [fauxText(" \n ")], [fauxThinking("The learner answered correctly.")]]) {
	test(`a silent response after Submit continues without another learner message: ${content[0]?.type ?? "empty"}`, async () => {
		const f = fixture([fauxAssistantMessage(content), fauxAssistantMessage([fauxText("Correct. Let’s use those updated predictions.")])]);
		await f.model.submitAnswer("quiz", "question", answer);
		assert.equal(f.model.getState().error, null);
		assert.equal(f.calls(), 2, "a silent completion still owes the answer a visible response");
		assert.equal(f.posts.length, 1); assert.equal(JSON.parse(f.posts[0]!).input.type, "answer");
		assert.equal(f.saved().filter(m => m.role === "user").length, 1, "no invented extra learner message");
		assert.equal(f.saved().filter(m => m.role === "toolResult").length, 1, "the answer is submitted once");
		assert(f.saved().some(m => m.role === "assistant" && m.content.some(b => b.type === "text" && b.text.startsWith("Correct."))));
		assert.equal(pendingQuestionOf(f.saved()), null); assert.equal(f.model.status, "ready");
		assert.equal(isTurnRunning(f.chat.id), false);
	});
}

test("a normal answer reaction uses one request", async () => {
	const f = fixture([fauxAssistantMessage([fauxText("Correct.")])]);
	await f.model.submitAnswer("quiz", "question", answer);
	assert.equal(f.model.getState().error, null);
	assert.equal(f.calls(), 1); assert.equal(f.posts.length, 1);
});

test("persistent silent responses stop after two continuations with a visible, retryable error", async () => {
	const f = fixture([fauxAssistantMessage([]), fauxAssistantMessage([fauxThinking("Still considering it.")]), fauxAssistantMessage([]), fauxAssistantMessage([fauxText("Correct, let’s continue.")])]);
	await f.model.submitAnswer("quiz", "question", answer);
	assert.equal(f.calls(), 3); assert.equal(isTurnRunning(f.chat.id), false);
	assert.match(f.model.getState().error?.message ?? "", /no reply after your answer/);
	const before = structuredClone(f.saved());
	assert.equal(endsInFailedTurn(before), true);
	await f.model.send({ type: "retry" });
	assert.equal(f.calls(), 4);
	assert.deepEqual(f.saved().slice(0, before.length), before, "even silent attempts remain in saved history");
	assert.equal(f.saved().filter(m => m.role === "toolResult").length, 1);
	assert.equal(f.model.getState().error, null);
});

for (const reason of ["error", "aborted", "length"] as const) {
	test(`a ${reason} response does not trigger a silent-reply continuation`, async () => {
		const f = fixture([fauxAssistantMessage([], { stopReason: reason, ...(reason === "error" ? { errorMessage: "fixture failure" } : {}) })]);
		await f.model.submitAnswer("quiz", "question", answer);
		assert.equal(f.calls(), 1);
	});
}

test("dismissing a question does not grant silent-reply continuations", async () => {
	const f = fixture([fauxAssistantMessage([])]);
	await f.model.submitAnswer("quiz", "question", { ...answer, dismissed: true });
	assert.equal(f.calls(), 1);
});

test("continuing a silent reply after tool work does not repeat the tool", async () => {
	let executions = 0;
	const f = fixture([
		fauxAssistantMessage([fauxToolCall("work", {}, { id: "work-once" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([]), fauxAssistantMessage([fauxText("Here is the next step.")]),
	], { work: { name: "work", label: "work", description: "Fixture work", parameters: Type.Object({}), execute: async () => { executions++; return { content: [{ type: "text", text: "Finished work" }], details: {} }; } } });
	await f.model.submitAnswer("quiz", "question", answer);
	assert.equal(f.calls(), 3); assert.equal(executions, 1);
	assert.equal(f.saved().filter(m => m.role === "toolResult" && m.toolName === "work").length, 1);
});

test("a new question pauses immediately instead of triggering automatic continuation", async () => {
	const f = fixture([fauxAssistantMessage([fauxToolCall("quiz", input, { id: "next-question" })], { stopReason: "toolUse" })], {
		quiz: { name: "quiz", label: "quiz", description: "Fixture question", parameters: Type.Any(), execute: async () => questionResult() },
	});
	await f.model.submitAnswer("quiz", "question", answer);
	assert.equal(f.calls(), 1); assert.equal(pendingQuestionOf(f.saved())?.toolCallId, "next-question");
});

test("ordinary messages do not enable the answer-only continuation rule", async () => {
	const f = fixture([fauxAssistantMessage([])]);
	await f.model.send({ type: "text", text: "A separate instruction" });
	assert.equal(f.calls(), 1);
});
