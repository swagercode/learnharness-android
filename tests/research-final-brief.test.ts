import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";

function engine(responses: FauxResponseStep[]) {
	const core = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	core.setResponses(responses);
	return { model: core.getModel(), streamFn: core.streamSimple };
}
const brief = "## Summary\nEvidence collected.\n## Gaps\nFurther verification is needed.";

describe("research final brief", () => {
	it("synthesizes the collected evidence after the twelfth tool call instead of returning no text", async () => {
		let calls = 0;
		const responses = Array.from({ length: 12 }, (_, i) => fauxAssistantMessage([
			fauxToolCall("web_search", { query: `facet ${i}` }, { id: `search${i}` }),
		], { stopReason: "toolUse" }));
		const result = await runResearcherAgent("Research a question", {
			engine: engine([...responses, (context) => {
				assert.equal(getCurrentTools(context.messages).length, 0, "the synthesis request cannot search again");
				assert.equal(context.messages.filter((m) => m.role === "toolResult").length, 12);
				return fauxAssistantMessage([fauxText(brief)]);
			}]),
			search: () => ({ id: "tavily", search: async () => [{ title: "Source", url: "https://example.com", snippet: "Evidence" }] }),
			onUsage: () => calls++,
		});
		assert.equal(result, brief);
		assert.equal(calls, 13, "the final summary is included in usage and bounded to one call");
	});
	it("asks once for a brief after an empty response, then reports a useful failure if still empty", async () => {
		let calls = 0;
		await assert.rejects(runResearcherAgent("Research", { engine: engine([fauxAssistantMessage([]), fauxAssistantMessage([])]), onUsage: () => calls++ }), /final summary request/);
		assert.equal(calls, 2);
	});
	it("does not retry a provider failure", async () => {
		let calls = 0;
		await assert.rejects(runResearcherAgent("Research", { engine: engine([() => { calls++; throw new Error("provider unavailable"); }]) }), /provider unavailable/);
		assert.equal(calls, 1);
	});
	it("returns an ordinary final brief without an extra request", async () => {
		let calls = 0;
		assert.equal(await runResearcherAgent("Research", { engine: engine([fauxAssistantMessage(brief)]), onUsage: () => calls++ }), brief);
		assert.equal(calls, 1);
	});
});
