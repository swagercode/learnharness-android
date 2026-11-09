import type { LhMessage } from "./native-messages.ts";
import type { DemoResult, VisualResult } from "./contracts/jobs.ts";

export type LessonMaterial = {
	id: string;
	title: string;
	inverted: boolean;
} & (
	| { kind: "demo"; result: DemoResult }
	| { kind: "figure"; result: VisualResult }
);

/** Only delivered artifacts in this session can be shown again. Tool inputs,
 * failed/unverified demos, and previous copies are deliberately excluded. */
export function lessonMaterials(messages: readonly LhMessage[]): LessonMaterial[] {
	const materials: LessonMaterial[] = [];
	for (const message of messages) {
		if (message.role !== "custom" || message.customType !== "subagent-steer") continue;
		const data = message.details as {
			kind?: string;
			result?: Partial<DemoResult & VisualResult>;
			ui?: { inverted?: boolean };
		} | null;
		const result = data?.result;
		if (!result) continue;
		const common = { id: message.id, inverted: data?.ui?.inverted === true };
		if (data?.kind === "demo" && result.tested === true && typeof result.html === "string" && result.html.trim()) {
			const title = typeof result.title === "string" && result.title.trim() ? result.title : "Interactive demo";
			materials.push({ ...common, kind: "demo", title, result: { title, html: result.html, tested: true } });
		} else if (data?.kind === "visual" && typeof result.svg === "string" && result.svg.trim()) {
			materials.push({ ...common, kind: "figure", title: "Figure", result: { svg: result.svg } });
		}
	}
	return materials;
}
