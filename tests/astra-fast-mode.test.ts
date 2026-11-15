import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-astra-fast-"));
const previousData = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = scratch;
const { parseSettingsBody } = await import("../src/server/settings-body.ts");
const { resolveConversationSpec } = await import("../src/core/settings-resolution.ts");
const { chatStore } = await import("../src/store/chats.ts");
const astra = { provider: "chatgpt", id: "gpt-6-astra" };
after(() => {
	if (previousData === undefined) delete process.env.LH_DATA_DIR; else process.env.LH_DATA_DIR = previousData;
	fs.rmSync(scratch, { recursive: true, force: true });
});

test("Fast opt-in persists for one session, without changing its model, thinking or other sessions", () => {
	const chat = chatStore.createChat("Fast fixture");
	const other = chatStore.createChat("Standard fixture");
	const parsed = parseSettingsBody({ model: astra, thinkingLevel: "low", fastMode: true });
	assert(parsed.ok);
	chatStore.saveSettings(chat.id, parsed.settings);
	const saved = chatStore.getChat(chat.id)!;
	assert.deepEqual(saved.settings, parsed.settings);
	assert.deepEqual(resolveConversationSpec(saved.settings, null), { ...astra, thinkingLevel: "low", fastMode: true });
	assert.equal(chatStore.getChat(other.id)!.settings, undefined);
	assert.equal(resolveConversationSpec(undefined, { ...astra, thinkingLevel: "low" })!.fastMode, undefined);
	chatStore.saveSettings(chat.id, { ...parsed.settings, fastMode: false });
	assert.equal(resolveConversationSpec(chatStore.getChat(chat.id)!.settings, null)!.fastMode, false);
});

test("Fast requires an explicit supported model and a real boolean; stale flags cannot enable it on other routes", () => {
	for (const fastMode of ["true", 1, null, {}]) assert.equal(parseSettingsBody({ model: astra, fastMode }).ok, false);
	for (const model of [undefined, { ...astra, provider: "openai" }, { ...astra, id: "gpt-6-luna" }]) {
		assert.equal(parseSettingsBody({ model, fastMode: true }).ok, false);
	}
	assert.equal(parseSettingsBody({ fastMode: false }).ok, true);
	assert.equal(resolveConversationSpec({ model: { ...astra, id: "gpt-6-luna" }, fastMode: true }, null)!.fastMode, false);
});
