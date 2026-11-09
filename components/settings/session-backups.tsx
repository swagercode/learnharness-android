"use client";

import { useEffect, useRef, useState } from "react";

export function SessionBackups() {
	const [android, setAndroid] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => setAndroid(navigator.userAgent.includes("LearnHarnessAndroid/")), []);
	async function download() {
		if (busy) return;
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/backups/sessions?check=1", { cache: "no-store" });
			if (!response.ok) throw new Error((await response.json()).error ?? "Could not prepare your backup.");
			const a = document.createElement("a");
			a.href = "/api/backups/sessions"; a.download = "";
			document.body.appendChild(a); a.click(); a.remove();
		} catch (e) { setError(e instanceof Error ? e.message : "Could not export. Please try again."); }
		finally { setBusy(false); }
	}
	return <div className="mt-4 border-t border-border pt-5" data-testid="session-backups">
		<h3 className="font-prose text-lg">Session backups</h3>
		<p className="mt-2 text-sm text-muted-foreground">Save all sessions, research results, demos, and preferences in a restorable backup.</p>
		<div className="mt-3 flex flex-wrap gap-3">
			<button type="button" onClick={() => void download()} disabled={busy} data-testid="export-sessions"
				className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-accent disabled:opacity-50">{busy ? "Preparing…" : "Export sessions…"}</button>
			{android && <>
				<input ref={input} type="file" accept=".lhbackup.zip,application/zip" className="hidden" aria-label="Session backup file" />
				<button type="button" onClick={() => input.current?.click()} className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-accent">Import backup…</button>
			</>}
		</div>
		{error && <p role="alert" className="mt-2 text-sm text-red-500">{error}</p>}
		{android && <p className="mt-3 text-sm text-muted-foreground">Installing a LearnHarness APK update keeps your sessions. Keep the app installed; uninstalling or clearing its storage removes local data.</p>}
		<p className="mt-2 text-xs text-muted-foreground">API keys, sign-ins, the knowledge graph, and original source files are not included.</p>
	</div>;
}
