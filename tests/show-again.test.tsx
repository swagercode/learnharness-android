import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LhMessage } from "../src/core/native-messages.ts";
import { lessonMaterials } from "../src/core/lesson-materials.ts";
import { showAgainTool } from "../src/agent/tools/show-again.ts";
import { createTeacherTools, createProberTools } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { projectView } from "../src/core/view.ts";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { ShowAgainCard } from "../components/artifacts/show-again-card.tsx";

const demo = (id: string, title = "Two arrows", tested = true, html = "<button>Move</button>"): LhMessage => ({
	id, role: "custom", customType: "subagent-steer", display: true, content: "Demo ready", timestamp: 1,
	details: { kind: "demo", result: { title, tested, html, notes: "Private verification notes" }, ui: { inverted: true } },
});
const figure: LhMessage = { id: "figure", role: "custom", customType: "subagent-steer", display: true, content: "Figure ready", timestamp: 2,
	details: { kind: "visual", result: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle r="5"/></svg>' } } };
const messages = [demo("first"), demo("failed", "Failed", false), demo("empty", "Empty", true, ""), figure, demo("latest", "Other arrows")];
const ctx = { chatId: "current", chatStore: { getChat: (id: string) => id === "current" ? { messages } : null } };
const tool = showAgainTool(ctx);

describe("show an earlier material at the current position", () => {
	it("catalog accepts only original delivered, verified artifacts and keeps verification notes out", () => {
		assert.deepEqual(lessonMaterials(messages).map(x => x.id), ["first", "figure", "latest"]);
		assert.doesNotMatch(JSON.stringify(lessonMaterials(messages)), /Private verification notes/);
	});
	it("defaults to latest demo and sends only a slim receipt to the model", async () => {
		const result = await tool.execute("show", {});
		assert.equal((result.details as any).material.id, "latest");
		assert.equal((result.details as any).material.inverted, true);
		assert.match(JSON.stringify(result.content), /fresh instance/);
		assert.doesNotMatch(JSON.stringify(result.content), /<button>|Private verification/);
	});
	it("supports exact source, title and latest figure without mutating history", async () => {
		const before = JSON.stringify(messages);
		assert.equal((await tool.execute("a", { sourceId: "first" })).details.material.id, "first");
		assert.equal((await tool.execute("b", { query: "OTHER" })).details.material.id, "latest");
		assert.equal((await tool.execute("c", { kind: "figure" })).details.material.id, "figure");
		assert.equal(JSON.stringify(messages), before);
	});
	it("ambiguous titles and foreign/failed ids return candidates, never content", async () => {
		for (const input of [{ query: "arrows" }, { sourceId: "other-session" }, { sourceId: "failed" }]) {
			const result = await tool.execute("bad", input);
			assert.equal(result.details.ok, false);
			assert.doesNotMatch(JSON.stringify(result), /<button>|<svg/);
		}
	});
	it("missing sessions fail safely", async () => {
		const missing = showAgainTool({ ...ctx, chatId: "missing" });
		assert.equal((await missing.execute("bad", {})).details.ok, false);
	});
	it("native tool output projects to a separate sandboxed demo card, survives replay, and is not recatalogued", async () => {
		const result = await tool.execute("show", { sourceId: "first" });
		const native = [...messages, { id: "call-message", role: "assistant", content: [{ type: "toolCall", id: "show", name: "show_again", arguments: { sourceId: "first" } }], timestamp: 3 },
			{ id: "result-message", role: "toolResult", toolCallId: "show", toolName: "show_again", ...result, isError: false, timestamp: 4 }] as LhMessage[];
		const replay = JSON.parse(JSON.stringify(native)) as LhMessage[];
		const part = projectView(replay).flatMap(m => m.parts).find(p => p.type === "tool-show_again")!;
		assert.equal(part.state, "output-available");
		assert.equal(artifactRenderers.show_again, ShowAgainCard);
		const html = renderToStaticMarkup(<ShowAgainCard part={part as any} />);
		assert.match(html, /data-testid="show-again-card"/);
		assert.match(html, /sandbox="allow-scripts"/);
		assert.match(html, /demo-fullscreen-open/);
		assert.doesNotMatch(html, /question-dock|<form|Private verification/);
		assert.deepEqual(lessonMaterials(replay).map(x => x.id), ["first", "figure", "latest"]);
	});
	it("figure reuse retains the isolated SVG renderer", async () => {
		const output = (await tool.execute("show", { kind: "figure" })).details;
		const html = renderToStaticMarkup(<ShowAgainCard part={{ type: "tool-show_again", state: "output-available", toolCallId: "show", output }} />);
		assert.match(html, /data-testid="visual-card"/);
		assert.match(html, /<img/);
	});
	it("tool is available in all lesson roles independently of demo generation", () => {
		const context = { ...ctx, jobStore: {}, spawn: () => {}, deliver: () => {} } as any;
		for (const registry of [createTeacherTools(context, { demo: false }), createProberTools(context), practiceTools(ctx)]) {
			assert.equal(registry.show_again?.name, "show_again");
		}
	});
	it("the same self-contained task policy composes for teaching, probing, and practice", () => {
		for (const role of ["teacher", "prober", "practice"] as const) {
			const prompt = composeInstructions(role, {});
			assert.match(prompt, /## Every task stands on its own/);
			assert.match(prompt, /all four operations in the question itself/);
			assert.match(prompt, /Keep interactive models and demos separate from the question/);
		}
	});
});
