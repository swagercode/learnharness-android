"use client";

import { useEffect, useState } from "react";

interface Status { mode: "off" | "host" | "client"; canHost: boolean; url?: string; busy?: boolean; lastSync?: string; error?: string; conflicts?: number; deferred?: number; code?: string }
export function SessionSync() {
	const [status, setStatus] = useState<Status>();
	const [code, setCode] = useState("");
	const [address, setAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		let active = true;
		const refresh = async () => {
			try {
				const response = await fetch("/api/sync", { cache: "no-store" });
				if (!response.ok) throw new Error();
				const value = await response.json();
				if (active) setStatus(previous => ({ ...value, ...(previous?.mode === value.mode && previous?.code ? { code: previous.code } : {}) }));
			} catch { if (active) setError("Could not read sync status. Reopen Settings to retry."); }
		};
		void refresh(); const timer = setInterval(() => void refresh(), 5000);
		return () => { active = false; clearInterval(timer); };
	}, []);
	async function action(action: string) {
		if (busy) return;
		setBusy(true); setError(undefined); setCopied(false);
		try {
			const response = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, code, address }) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? "Sync could not complete.");
			setStatus(result); if (action === "connect" || action === "disconnect") setCode("");
		} catch (e) { setError(e instanceof Error ? e.message : "Sync could not complete."); }
		finally { setBusy(false); }
	}
	const button = "min-h-11 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50";
	return <section className="mt-4 min-w-0 border-t border-border pt-5" data-testid="session-sync">
		<h3 className="font-prose text-lg">Session sync</h3>
		<p className="mt-2 text-sm text-muted-foreground">Continue your lessons on your phone and Mac over Tailscale. Keep Tailscale connected on both devices and LearnHarness open on the Mac.</p>
		{!status ? <p className="mt-3 text-sm">Loading…</p> : <fieldset disabled={busy} className="mt-3 min-w-0 space-y-3">
			{status.mode === "off" ? <>
				<label className="block text-sm">Pairing code from your Mac
					<textarea value={code} onChange={event => setCode(event.target.value)} placeholder="lh-sync-1:…" autoComplete="off" spellCheck={false} rows={2}
						className="mt-2 block w-full min-w-0 resize-y rounded-md border bg-background p-3 text-base [overflow-wrap:anywhere]" data-testid="sync-pairing-input" />
				</label>
				<button type="button" className={button} disabled={!code.trim() || busy} onClick={() => void action("connect")}>Connect to Mac</button>
				{status.canHost && <details className="min-w-0 rounded-md border p-3">
					<summary className="cursor-pointer text-sm">Use this Mac as the sync host</summary>
					<label className="mt-3 block text-sm">This Mac's Tailscale hostname
						<input value={address} onChange={event => setAddress(event.target.value)} placeholder="your-mac.your-tailnet.ts.net" autoComplete="off" autoCapitalize="none" spellCheck={false} className="mt-2 block min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-base" />
					</label>
					<p className="mt-2 text-xs text-muted-foreground">Set up private Tailscale HTTPS on port 47823 on this Mac. Setup instructions are included with the release.</p>
					<button type="button" className={`${button} mt-3`} disabled={!address.trim() || busy} onClick={() => void action("host")}>Start sync host</button>
				</details>}
			</> : <>
				<p className="text-sm font-medium">{status.mode === "host" ? "This Mac is the sync host" : "Connected to your Mac"}</p>
				<p className="break-all text-xs text-muted-foreground">{status.url}</p>
				<p role="status" className="text-sm">{status.busy ? "Syncing…" : status.lastSync ? `Last synced ${new Date(status.lastSync).toLocaleString()}` : status.mode === "host" ? "Ready for your phone to connect." : "Waiting for first sync…"}</p>
				{!!status.deferred && <p className="text-xs text-muted-foreground">Some sessions are still working or changed during sync. They will retry automatically.</p>}
				{!!status.conflicts && <p className="text-sm">Changes were made on both devices. Both versions are saved; look for “Offline conflict copy” in your sessions.</p>}
				<div className="flex flex-wrap gap-2">
					{status.mode === "client" && <button type="button" className={button} onClick={() => void action("now")}>Sync now</button>}
					{status.mode === "host" && <button type="button" className={button} onClick={() => void action("pairing")}>Show pairing code</button>}
					<button type="button" className={button} onClick={() => void action("disconnect")}>Disconnect sync</button>
				</div>
				{status.code && <div className="min-w-0 space-y-2">
					<p className="text-xs text-muted-foreground">This private code gives access to your sessions. Paste it in Session sync on your phone.</p>
					<textarea readOnly value={status.code} aria-label="Private pairing code" rows={3} spellCheck={false} className="block w-full min-w-0 resize-y rounded-md border bg-background p-3 text-sm [overflow-wrap:anywhere]" />
					<button type="button" className={button} onClick={async () => { try { await navigator.clipboard.writeText(status.code!); setCopied(true); } catch { setError("Select the pairing code and copy it manually."); } }}>{copied ? "Copied" : "Copy pairing code"}</button>
				</div>}
			</>}
		</fieldset>}
		{(error || status?.error) && <p role="alert" className="mt-3 break-words text-sm text-red-500">{error || status?.error}</p>}
		<p className="mt-3 text-xs text-muted-foreground">Sync includes sessions, plans, completed research and demos. Changes made offline sync when connected again. Conflicting edits keep both copies. Deletions, the knowledge graph, original files, app preferences, API keys and sign-ins stay on each device.</p>
	</section>;
}
