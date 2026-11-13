import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { FINISH_LESSON_TOOL } from "../../core/lesson-continuation.ts";

const parameters = Type.Object({
	reason: Type.Union([Type.Literal("learner_requested_pause"), Type.Literal("learning_goal_completed")]),
});

/** A deliberate stopping point, not an alternative to the next check.
 * No session is closed: the learner can resume with another message. */
export const finishLessonTool: AgentTool<typeof parameters> = {
	name: FINISH_LESSON_TOOL,
	label: "Finish lesson response",
	description: "Stop only when the learner explicitly asked to pause/stop, or their learning goal is actually complete. " +
		"Write a brief closing sentence to the learner BEFORE calling this tool. " +
		"Feedback on one answer, finishing one step, or waiting for reading is NOT completion: continue teaching and pose the next question instead. " +
		"To finish the initial assessment and start teaching, use probe_done instead.",
	parameters,
	executionMode: "sequential",
	execute: async (_id, input) => ({
		content: [{ type: "text", text: "Lesson response finished. Wait for the learner." }],
		details: { ok: true, reason: input.reason },
		terminate: true,
	}),
};

export const ANSWER_FOLLOW_THROUGH = "The learner has submitted an answer. Give any needed feedback, then continue the lesson to the next question tool in this same response. " +
	"Feedback alone, a transition sentence, or a promise to continue is not a stopping point. Teach or repair one step and pose its check; predictions also lead to teaching and a check. " +
	"Stop at the next question so the learner can answer. If they explicitly requested a pause or their learning goal is complete, write a brief closing sentence and call finish_lesson. " +
	"During probing, probe_done hands off to teaching when the assessment is complete.";

export const ANSWER_FOLLOW_THROUGH_REMINDER = "Your previous response stopped without a new question or an explicit lesson finish. " +
	"Continue from the feedback already visible; do not repeat it or re-grade/re-submit the answer. Take the next teaching or repair step and pose its question now. " +
	"Use finish_lesson only for a learner-requested pause or a completed learning goal.";
