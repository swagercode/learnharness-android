import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../../core/native-messages.ts";
import { lessonMaterials } from "../../core/lesson-materials.ts";
import { serverExecute } from "../tool-execute.ts";

const inputSchema = Type.Object({
	sourceId: Type.Optional(Type.String({ minLength: 1, description: "The original artifact message id in this session, when known." })),
	query: Type.Optional(Type.String({ minLength: 1, description: "Match a demo title. Ambiguous matches return candidates; retry with sourceId." })),
	kind: Type.Optional(Type.Union([Type.Literal("demo"), Type.Literal("figure")], {
		description: "Limit to a demo or figure. With no sourceId or query, shows the most recently delivered match (default: demo).",
	})),
});

export function showAgainTool(ctx: {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
}): AgentTool<typeof inputSchema> {
	return {
		name: "show_again",
		label: "show_again",
		description: "Show an earlier verified demo or figure from this session again at the current conversation position. " +
			"Use before asking the learner to reuse it, so they do not need to scroll back. No regeneration or background job. " +
			"The demo opens as a fresh instance: explicitly restate any needed setup. Keep it separate from questions, " +
			"and include every required starting value and operation in the question's own text.",
		parameters: inputSchema,
		executionMode: "sequential",
		execute: serverExecute("show_again", inputSchema, async ({ sourceId, query, kind }) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: "This session could not be found." };
			const materials = lessonMaterials(record.messages);
			const selectedKind = kind ?? (sourceId || query ? undefined : "demo");
			const candidates = materials.filter((material) =>
				(!selectedKind || material.kind === selectedKind) &&
				(!sourceId || material.id === sourceId) &&
				(!query || material.title.toLowerCase().includes(query.trim().toLowerCase())),
			);
			if (!candidates.length || (!sourceId && query && candidates.length > 1)) {
				return {
					ok: false,
					error: candidates.length ? "Several artifacts match. Retry with a sourceId." : "No matching delivered artifact in this session.",
					candidates: (candidates.length ? candidates : materials).map(({ id, kind, title }) => ({ sourceId: id, kind, title })),
				};
			}
			const material = candidates[candidates.length - 1]!;
			return {
				text: JSON.stringify({ ok: true, sourceId: material.id, kind: material.kind, title: material.title,
					...(material.kind === "demo" ? { state: "fresh instance; restate any required setup" } : {}) }),
				details: { ok: true, material },
			};
		}),
	};
}
