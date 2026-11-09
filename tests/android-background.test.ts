import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRecord, JobRecord } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { emit } from "../src/core/events.ts";
import { androidBackgroundResponse, androidSessionState } from "../src/server/android-background.ts";

const reply = (id: string, text = "A private lesson") => ({ id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 } as LhMessage);
const chat = (messages: LhMessage[] = [reply("a")]): ChatRecord => ({ id: "chat_check", title: "A session", createdAt: "1", updatedAt: "2", messages });
const job = (status: JobRecord["status"]): JobRecord => ({ id: "job_check", chatId: "chat_check", toolCallId: "tool", kind: "research", status, activity: "researching", createdAt: "1", updatedAt: "2" });

describe("Android background state", () => {
	it("tracks live turns and independent workers without treating pending delivery as running", () => {
		assert.equal(androidSessionState(chat(), [], true).busy, true);
		assert.equal(androidSessionState(chat(), [job("running")], false).busy, true);
		assert.equal(androidSessionState(chat(), [{ ...job("done"), delivery: { kind: "result", status: "pending" } }], false).busy, false);
	});
	it("only changes ready revisions for new readable work; excludes text and errors from the wire", () => {
		const first = androidSessionState(chat(), [], false);
		assert.equal(first.readyVersion, androidSessionState({ ...chat(), title: "Renamed", updatedAt: "later" }, [], false).readyVersion);
		assert.notEqual(first.readyVersion, androidSessionState(chat([reply("b")]), [], false).readyVersion);
		assert.equal(JSON.stringify(first).includes("private lesson"), false);
		const failed = androidSessionState(chat(), [], false, "secret provider detail");
		assert.ok(failed.errorVersion); assert.equal(JSON.stringify(failed).includes("secret provider"), false);
	});
	it("ignores thinking-only output, tool progress and aborted work", () => {
		const thinking = { id: "think", role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }], stopReason: "stop" } as LhMessage;
		const aborted = { ...reply("aborted"), stopReason: "aborted" } as LhMessage;
		assert.equal(androidSessionState(chat([thinking, aborted]), [{ ...job("error"), delivery: { kind: "abort", status: "delivered" } }], false).readyVersion, "");
		assert.equal(androidSessionState(chat([]), [{ ...job("error"), delivery: { kind: "abort", status: "delivered" } }], false).errorVersion, "");
	});
	it("recognizes questions and separates research success from failure", () => {
		const question = { id: "ask", role: "assistant", content: [{ type: "toolCall", id: "q", name: "quiz", arguments: {} }], stopReason: "toolUse" } as LhMessage;
		assert.ok(androidSessionState(chat([question]), [], false).readyVersion);
		assert.ok(androidSessionState(chat([]), [job("done")], false).readyVersion);
		assert.equal(androidSessionState(chat([]), [job("error")], false).readyVersion, "");
		assert.ok(androidSessionState(chat([]), [job("error")], false).errorVersion);
	});
	it("does not re-alert for compaction of older replies or job delivery bookkeeping", () => {
		const before = androidSessionState(chat([reply("old"), reply("current")]), [job("done")], false);
		const after = androidSessionState(chat([reply("current")]), [{ ...job("done"), updatedAt: "3", activity: "delivered", delivery: { kind: "result", status: "delivered" } }], false);
		assert.equal(before.readyVersion, after.readyVersion);
	});
	it("pushes durable state after events and heals a reconnect with the latest snapshot", async () => {
		let current = { busy: true, sessions: [androidSessionState(chat(), [], true)] };
		const read = (result: ReadableStreamReadResult<Uint8Array>) => JSON.parse(new TextDecoder().decode(result.value).slice(6));
		const reader = androidBackgroundResponse(() => current).body!.getReader();
		assert.equal(read(await reader.read()).busy, true);
		current = { busy: false, sessions: [androidSessionState(chat([reply("b")]), [], false)] };
		emit("turn-settled", { chatId: "chat_check" });
		assert.deepEqual(read(await reader.read()), current);
		await reader.cancel();
		const reconnected = androidBackgroundResponse(() => current).body!.getReader();
		assert.deepEqual(read(await reconnected.read()), current);
		await reconnected.cancel();
	});
});
