import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { nativeInputCause } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";

export const FINISH_LESSON_TOOL = "finish_lesson";
export const LESSON_CONTINUATION_ERROR = "The tutor did not provide the next lesson step, even after continuing automatically. Your answer is saved. Please retry.";

/** Find an answered question across completed tool work. A new learner
 * message, automatic wake, dismissal, or explicit finish is a boundary.
 * This also reconstructs the obligation after a failed turn is retried. */
export function lessonAnswerPending(messages: readonly AgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant") {
			if (m.stopReason === "aborted") return false;
			continue;
		}
		if (m.role === "system" || (m.role === "custom" && m.customType === "plan-block")) continue;
		if (m.role !== "toolResult") return false;
		if ((QUESTION_TOOLS as readonly string[]).includes(m.toolName)) {
			return nativeInputCause(m, messages.slice(0, i)) === "learner";
		}
		if (!m.isError && [FINISH_LESSON_TOOL, "probe_done"].includes(m.toolName)) return false;
	}
	return false;
}
