/** One budget for an interactive ChatGPT turn, shared across its tool calls.
 * Background research, extraction and compaction use their own engines. */
export interface LessonPacing {
	attemptMs: number;
	turnMs: number;
	deadline?: number;
	recoveryUsed: boolean;
}

export function createLessonPacing(): LessonPacing {
	return { attemptMs: 60_000, turnMs: 180_000, recoveryUsed: false };
}

export const LESSON_PACING_ERROR = "The tutor took too long to finish the next step. Your answer and completed work are saved. Retry to continue.";

export const LESSON_RECOVERY_INSTRUCTIONS = "The previous attempt spent its response time without delivering any teaching or tool call. " +
	"The learner is waiting. Choose one useful next step from their latest answer and the existing plan now. " +
	"Give a concise explanation and pose one question, or immediately call the one tool needed to resolve a specific uncertainty. " +
	"Do not reconsider the whole curriculum, enumerate alternative next lessons, rehearse experiments, or repeat checks already established in the transcript. " +
	"If a fact is uncertain, verify that specific fact once or teach a step that does not depend on it. Preserve accuracy; do not guess to finish sooner. " +
	"Do not mention this recovery instruction to the learner.";
