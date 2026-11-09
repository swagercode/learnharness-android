"use client";

import { useRef, useState } from "react";
import { genericProviderKeyGuard, isProviderEnvVar, normalizeAuthKeyInput, validateKeyShape } from "@/src/core";

/** Shared key entry: a full-width field on phones, with actions below it. */
export function ApiKeyEditor({ id, label, testid, onSave, onCancel, onDelete }: {
	id: string;
	label: string;
	testid: string;
	onSave: (value: string) => Promise<string | null>;
	onCancel: () => void;
	onDelete?: () => Promise<void>;
}) {
	const [value, setValue] = useState("");
	const [visible, setVisible] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const working = useRef(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const deepgram = id === "DEEPGRAM_API_KEY";
	const normalized = normalizeAuthKeyInput(id, value);
	const check = (input: string) => isProviderEnvVar(id)
		? genericProviderKeyGuard(id, input) : validateKeyShape(id, input);

	async function save() {
		if (working.current || !normalized) return;
		const shape = check(normalized);
		if (!shape.ok) { setError(shape.error); return; }
		working.current = true;
		setBusy(true);
		setError(null);
		try {
			const message = await onSave(normalized);
			if (message) setError(message);
		} catch {
			setError("Could not save the key. Check your connection and try again.");
		} finally {
			working.current = false;
			setBusy(false);
		}
	}

	async function importFile(file: File) {
		if (working.current) return;
		working.current = true;
		setBusy(true);
		setError(null);
		try {
			if (file.size > 4096) throw new Error("Choose the small .txt file containing only your API key.");
			const key = normalizeAuthKeyInput(id, await file.text());
			const shape = check(key);
			if (!shape.ok) throw new Error(shape.error);
			setValue(key);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not read the key file. Try pasting the key instead.");
		} finally {
			working.current = false;
			setBusy(false);
		}
	}

	return <div className="min-w-0 rounded-md border border-border p-3" data-testid={`${testid}-editor`}>
		<label htmlFor={`${testid}-input`} className="mb-2 block font-ui text-sm text-foreground sm:text-xs">{label} API key</label>
		<div className="flex min-w-0 gap-2">
			<input
				id={`${testid}-input`}
				type={visible ? "text" : "password"}
				value={value}
				onChange={(e) => { setValue(e.target.value); setError(null); }}
				onPaste={(e) => {
					const pasted = e.clipboardData.getData("text");
					const clean = normalizeAuthKeyInput(id, pasted);
					if (deepgram && check(clean).ok) {
						e.preventDefault(); setValue(clean); setError(null);
					}
				}}
				onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
				placeholder="Paste your API key"
				aria-label={`${label} key`}
				aria-invalid={Boolean(error)}
				aria-describedby={`${testid}-help${error ? ` ${testid}-error` : ""}`}
				data-testid={`${testid}-input`}
				disabled={busy}
				autoComplete="off"
				autoCapitalize="none"
				autoCorrect="off"
				spellCheck={false}
				enterKeyHint="done"
				className="h-11 min-w-0 flex-1 rounded-sm border border-border bg-background px-3 font-mono text-base text-foreground placeholder:text-muted-foreground/60 focus:border-muted-foreground sm:h-9 sm:text-sm"
			/>
			<button type="button" onClick={() => setVisible(!visible)} aria-label={`${visible ? "Hide" : "Show"} ${label} key`} aria-pressed={visible}
				className="min-h-11 shrink-0 rounded-sm px-2 text-sm text-muted-foreground hover:bg-accent sm:min-h-9 sm:text-xs">{visible ? "Hide" : "Show"}</button>
		</div>
		<div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground" id={`${testid}-help`}>
			<span data-testid={`${testid}-count`}>{normalized.length ? `${normalized.length}${deepgram ? " / 40" : ""} characters` : deepgram ? "Paste the key itself, or import your key file." : "Paste the key from your provider."}</span>
			{deepgram && <>
				<input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" tabIndex={-1} aria-label="Deepgram key file" data-testid={`${testid}-file`}
					onChange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void importFile(file); }} />
				<button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="min-h-11 text-foreground underline underline-offset-4 disabled:opacity-40 sm:min-h-8" data-testid={`${testid}-import`}>Import key file</button>
			</>}
		</div>
		{error && <p role="alert" id={`${testid}-error`} data-testid={`${testid}-error`} className="mt-2 break-words text-sm text-red-500 sm:text-xs">{error}</p>}
		<div className="mt-3 flex flex-wrap items-center gap-2">
			<button type="button" onClick={() => void save()} disabled={busy || !normalized} data-testid={`${testid}-save`}
				className="min-h-11 rounded-sm bg-foreground px-4 text-sm font-medium text-background disabled:opacity-40 sm:min-h-8 sm:text-xs">{busy ? "Saving…" : "Save"}</button>
			<button type="button" onClick={onCancel} disabled={busy} data-testid={`${testid}-cancel`}
				className="min-h-11 rounded-sm border border-border px-4 text-sm text-foreground hover:bg-accent disabled:opacity-40 sm:min-h-8 sm:text-xs">Cancel</button>
			{onDelete && <button type="button" disabled={busy} data-testid={`${testid}-delete`} className="ml-auto min-h-11 px-2 text-sm text-muted-foreground hover:text-red-500 sm:min-h-8 sm:text-xs"
				onClick={async () => { if (working.current) return; working.current = true; setBusy(true); try { await onDelete(); onCancel(); } catch { setError("Could not delete the key. Try again."); } finally { working.current = false; setBusy(false); } }}>Delete</button>}
		</div>
	</div>;
}
