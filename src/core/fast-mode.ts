/** Fast processing is an explicit per-session opt-in on the ChatGPT route.
 * Keep the model and reasoning level unchanged; other providers/models do
 * not inherit the higher-usage request when a learner changes models. */
export function supportsAstraFastMode(model?: { provider?: string; id?: string }): boolean {
	return model?.provider === "chatgpt" && model.id === "gpt-6-astra";
}
