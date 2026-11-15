"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { SyncConflict, SyncResolution } from "@/src/core/contracts/session-sync";
import { useBackdropDismiss } from "./backdrop-dismiss";

function edited(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "Edit time unavailable" : date.toLocaleString();
}

export function SessionSyncConflictDialog({ conflict, count, busy, error, onChoose, onClose }: {
	conflict: SyncConflict; count: number; busy: boolean; error?: string;
	onChoose: (source: SyncResolution["source"]) => void; onClose: () => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	const later = useRef<HTMLButtonElement>(null);
	const dismiss = useBackdropDismiss(() => { if (!busy) onClose(); });
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		later.current?.focus({ preventScroll: true });
		return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
	}, [conflict.id, conflict.localHash, conflict.remoteHash]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault(); event.stopImmediatePropagation(); if (!busy) onClose();
			} else if (event.key === "Tab") {
				const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
				const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
				event.preventDefault(); event.stopImmediatePropagation();
				buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
			}
		};
		document.addEventListener("keydown", key, true);
		return () => document.removeEventListener("keydown", key, true);
	}, [busy, onClose]);
	const choice = "block min-h-14 w-full min-w-0 rounded-lg border border-border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
	return createPortal(<div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80 px-3 py-4" {...dismiss}>
		<div ref={panel} role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title" aria-describedby="sync-conflict-description"
			data-testid="sync-conflict-dialog" className="max-h-[calc(100dvh-2rem)] w-full min-w-0 max-w-md overflow-y-auto overscroll-contain rounded-xl border bg-card p-5 shadow-xl [overflow-wrap:anywhere]" onClick={event => event.stopPropagation()}>
			<h2 id="sync-conflict-title" className="font-prose text-xl">Choose sync source</h2>
			<p className="mt-2 text-sm font-medium" data-testid="sync-conflict-session">{conflict.title || "Untitled session"}</p>
			<p id="sync-conflict-description" className="mt-2 text-sm text-muted-foreground">This session changed on both devices. Choose which version to keep on both.</p>
			<div className="mt-4 space-y-3">
				<button type="button" disabled={busy} className={choice} onClick={() => onChoose("mac")} data-testid="sync-use-mac">
					<span className="block text-sm font-medium">Use Mac version</span>
					<span className="mt-1 block text-xs text-muted-foreground">Replace this phone’s copy with the Mac’s version.</span>
					<span className="mt-2 block text-xs text-muted-foreground">{conflict.remoteMessages} messages · {edited(conflict.remoteUpdatedAt)}</span>
				</button>
				<button type="button" disabled={busy} className={choice} onClick={() => onChoose("phone")} data-testid="sync-use-phone">
					<span className="block text-sm font-medium">Upload to Mac</span>
					<span className="mt-1 block text-xs text-muted-foreground">Replace the Mac’s copy with this phone’s version.</span>
					<span className="mt-2 block text-xs text-muted-foreground">{conflict.localMessages} messages · {edited(conflict.localUpdatedAt)}</span>
				</button>
			</div>
			{busy && <p role="status" className="mt-3 text-sm">Applying your choice…</p>}
			{error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
			<p className="mt-3 text-xs text-muted-foreground">A recovery copy of the replaced version is kept privately on that device.</p>
			<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">{count > 1 ? `${count} sessions need a choice` : "Sync waits for your choice."}</p>
				<button ref={later} type="button" disabled={busy} onClick={onClose} data-testid="sync-conflict-later" className="min-h-11 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">Later</button>
			</div>
		</div>
	</div>, document.body);
}
