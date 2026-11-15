"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SessionSyncInitialDialog } from "./session-sync-initial-dialog";
import { SYNC_REVIEW_EVENT, SYNC_STATUS_EVENT } from "./session-sync-events";

/** Boot the server-owned sync loop through the authenticated shell API. */
export function SessionSyncLifecycle() {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const working = useRef(false), dismissed = useRef(false);
	useEffect(() => {
		let active = true;
		const refresh = async (review = false) => {
			if (working.current) return;
			try {
				const response = await fetch("/api/sync", { cache: "no-store" });
				if (!response.ok) return;
				const value = await response.json();
				if (review) dismissed.current = false;
				if (active && !working.current) setOpen(!!value.initialRequired && !dismissed.current);
			} catch { /* local runtime reconnects on the next visible poll */ }
		};
		const start = () => { if (document.visibilityState !== "hidden") void refresh(); };
		const review = () => { setError(undefined); void refresh(true); };
		start(); const timer = setInterval(start, 5000);
		window.addEventListener("online", start); window.addEventListener("focus", start);
		window.addEventListener(SYNC_STATUS_EVENT, start); window.addEventListener(SYNC_REVIEW_EVENT, review);
		document.addEventListener("visibilitychange", start);
		return () => {
			active = false; clearInterval(timer);
			window.removeEventListener("online", start); window.removeEventListener("focus", start);
			window.removeEventListener(SYNC_STATUS_EVENT, start); window.removeEventListener(SYNC_REVIEW_EVENT, review);
			document.removeEventListener("visibilitychange", start);
		};
	}, []);
	const close = useCallback(() => { if (!working.current) { dismissed.current = true; setOpen(false); setError(undefined); } }, []);
	async function choose(source: "phone" | "mac") {
		if (working.current) return;
		working.current = true; setBusy(true); setError(undefined);
		try {
			const response = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "initial", source }) });
			const value = await response.json();
			if (!response.ok) throw new Error(value.error ?? "Sync could not start. Try again.");
			setOpen(!!value.initialRequired);
		} catch (e) { setError(e instanceof Error ? e.message : "Sync could not start. Try again."); }
		finally { working.current = false; setBusy(false); window.dispatchEvent(new Event(SYNC_STATUS_EVENT)); }
	}
	return open ? <SessionSyncInitialDialog busy={busy} error={error} onChoose={source => void choose(source)} onClose={close} /> : null;
}
