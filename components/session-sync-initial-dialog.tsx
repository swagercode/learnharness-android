"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useBackdropDismiss } from "./backdrop-dismiss";

export function SessionSyncInitialDialog({ busy, error, onChoose, onClose }: {
	busy: boolean; error?: string;
	onChoose: (source: "phone" | "mac") => void; onClose: () => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	const later = useRef<HTMLButtonElement>(null);
	const dismiss = useBackdropDismiss(() => { if (!busy) onClose(); });
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		later.current?.focus({ preventScroll: true });
		return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
	}, []);
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
		<div ref={panel} role="dialog" aria-modal="true" aria-labelledby="sync-initial-title" aria-describedby="sync-initial-description"
			data-testid="sync-initial-dialog" className="max-h-[calc(100dvh-2rem)] w-full min-w-0 max-w-md overflow-y-auto overscroll-contain rounded-xl border bg-card p-5 shadow-xl [overflow-wrap:anywhere]" onClick={event => event.stopPropagation()}>
			<h2 id="sync-initial-title" className="font-prose text-xl">First sync</h2>
			<p id="sync-initial-description" className="mt-2 text-sm text-muted-foreground">Choose which device to use for sessions already on both devices. Sessions found on just one device are copied to the other.</p>
			<div className="mt-4 space-y-3">
				<button type="button" disabled={busy} className={choice} onClick={() => onChoose("phone")} data-testid="sync-use-phone">
					<span className="block text-sm font-medium">Upload phone to Mac</span>
					<span className="mt-1 block text-xs text-muted-foreground">Use the phone’s version for shared sessions on this first sync.</span>
				</button>
				<button type="button" disabled={busy} className={choice} onClick={() => onChoose("mac")} data-testid="sync-use-mac">
					<span className="block text-sm font-medium">Use Mac versions</span>
					<span className="mt-1 block text-xs text-muted-foreground">Use the Mac’s version for shared sessions on this first sync.</span>
				</button>
			</div>
			{busy && <p role="status" className="mt-3 text-sm">Applying your choice…</p>}
			{error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
			<p className="mt-3 text-xs text-muted-foreground">After this first sync, the latest saved version of each session syncs automatically in both directions. Replaced versions are kept in private recovery copies.</p>
			<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">Offline work is always available.</p>
				<button ref={later} type="button" disabled={busy} onClick={onClose} data-testid="sync-initial-later" className="min-h-11 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">Not now</button>
			</div>
		</div>
	</div>, document.body);
}
