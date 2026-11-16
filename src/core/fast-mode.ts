/** Fast processing is an explicit per-session opt-in on the ChatGPT route.
 * Keep the model and reasoning level unchanged; other providers/models do
 * not inherit the higher-usage request when a learner changes models. */
export function supportsAstraFastMode(model?: { provider?: string; id?: string }): boolean {
	return model?.provider === "chatgpt" && model.id === "gpt-6-astra";
}

/** A request preference is not evidence of the processing tier actually served. */
export interface ChatGPTSpeed {
	requested: "standard" | "fast";
	served: "standard" | "fast" | "unconfirmed";
}

export function chatGPTServedSpeed(tier: unknown): ChatGPTSpeed["served"] {
	if (tier === "fast" || tier === "priority") return "fast";
	if (tier === "default") return "standard";
	return "unconfirmed";
}

export function chatGPTSpeedLabel(speed?: ChatGPTSpeed): string {
	if (!speed || speed.served === "unconfirmed") return "Last reply: speed not confirmed by OpenAI.";
	if (speed.served === "fast") return "Last reply: Fast confirmed by OpenAI.";
	return speed.requested === "fast" ? "Last reply: Standard. Fast was requested, but OpenAI served Standard." : "Last reply: Standard.";
}
