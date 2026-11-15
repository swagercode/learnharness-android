"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncConflict, SyncResolution } from "@/src/core/contracts/session-sync";
import { SessionSyncConflictDialog } from "./session-sync-conflict-dialog";
import { SYNC_REVIEW_EVENT, SYNC_STATUS_EVENT } from "./session-sync-events";

/** Start the sync runtime through the shell's authenticated API path on every
 * app launch. The server owns the timer afterwards, even with a hidden WebView.
 * Keeping filesystem access in a route also preserves Next's privacy excludes;
 * instrumentation traces are not filtered by route tracing configuration. */
export function SessionSyncLifecycle() {
	const [pending, setPending] = useState<SyncConflict[]>([]);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const working = useRef(false);
	const dismissed = useRef(new Set<string>());
	const currentId = useRef<string | undefined>(undefined);
	const accept = useCallback((value: { pending?: SyncConflict[] }, review = false) => {
		const next = value.pending ?? [];
		if (next[0]?.id !== currentId.current) setError(undefined);
		currentId.current = next[0]?.id;
		for (const id of dismissed.current) if (!next.some(conflict => conflict.id === id)) dismissed.current.delete(id);
		if (review) for (const conflict of next) dismissed.current.delete(conflict.id);
		setPending(next);
		setOpen(next.length > 0 && (review || next.some(conflict => !dismissed.current.has(conflict.id))));
	}, []);
	useEffect(() => {
		let active = true, sequence = 0;
		const refresh = async (review = false) => {
			if (working.current) return;
			const request = ++sequence;
			try {
				const response = await fetch("/api/sync", { cache: "no-store" });
				if (!response.ok) return;
				const value = await response.json();
				if (active && request === sequence && !working.current) accept(value, review);
			} catch { /* local runtime will reconnect on the next visible poll */ }
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
	}, [accept]);
	const close = useCallback(() => {
		if (working.current) return;
		for (const conflict of pending) dismissed.current.add(conflict.id);
		setOpen(false); setError(undefined);
	}, [pending]);
	async function choose(source: SyncResolution["source"]) {
		const conflict = pending[0]; if (!conflict || working.current) return;
		working.current = true; setBusy(true); setError(undefined);
		try {
			const resolution: SyncResolution = { id: conflict.id, source, localHash: conflict.localHash, remoteHash: conflict.remoteHash };
			const response = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve", resolution }) });
			const value = await response.json();
			if (!response.ok) throw new Error(value.error ?? "Sync could not complete. Try again.");
			accept(value, true);
			if (value.pending?.some((item: SyncConflict) => item.id === conflict.id)) setError(value.error ?? "This session is working or changed. Review the versions before choosing again.");
		} catch (e) { setError(e instanceof Error ? e.message : "Sync could not complete. Try again."); }
		finally { working.current = false; setBusy(false); window.dispatchEvent(new Event(SYNC_STATUS_EVENT)); }
	}
	return open && pending[0] ? <SessionSyncConflictDialog conflict={pending[0]} count={pending.length} busy={busy} error={error} onChoose={source => void choose(source)} onClose={close} /> : null;
}
