"use client";

import { useState } from "react";

/** A compact, read-only transcript in voice mode. Captured text stays in the
 * owning composer/dock, so changing input mode never discards an answer. */
export function DictationDraft({ value, onClear, label = "Dictation" }: { value: string; onClear: () => void; label?: string }) {
	const [review, setReview] = useState(false);
	const words = value.trim() ? value.trim().split(/\s+/).length : 0;
	return <div className="min-w-0 flex-1" data-testid="dictation-draft">
		<div className="flex min-h-10 flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<span className="min-w-0 flex-1 truncate" aria-live="polite">{words ? `${label} · ${words} ${words === 1 ? "word" : "words"}` : "Tap Dictate below"}</span>
			{words > 0 && <>
				<button type="button" className="min-h-10 px-1 underline underline-offset-2" aria-expanded={review} onClick={() => setReview(v => !v)}>{review ? "Hide" : "Review"}</button>
				<button type="button" className="min-h-10 px-1" onClick={onClear} aria-label={`Clear ${label.toLowerCase()}`}>Clear</button>
			</>}
		</div>
		{review && words > 0 && <p className="mb-2 max-h-20 overflow-y-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]" data-testid="dictation-review">{value}</p>}
	</div>;
}
