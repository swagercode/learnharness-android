"use client";

import { useEffect } from "react";

/** Start the sync runtime through the shell's authenticated API path on every
 * app launch. The server owns the timer afterwards, even with a hidden WebView.
 * Keeping filesystem access in a route also preserves Next's privacy excludes;
 * instrumentation traces are not filtered by route tracing configuration. */
export function SessionSyncLifecycle() {
	useEffect(() => {
		const start = () => { void fetch("/api/sync", { cache: "no-store" }).catch(() => {}); };
		start(); window.addEventListener("online", start); window.addEventListener("focus", start);
		return () => { window.removeEventListener("online", start); window.removeEventListener("focus", start); };
	}, []);
	return null;
}
