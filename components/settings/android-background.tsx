"use client";

import { useEffect, useState } from "react";

export function AndroidBackground() {
	const [android, setAndroid] = useState(false);
	useEffect(() => setAndroid(navigator.userAgent.includes("LearnHarnessAndroid/")), []);
	if (!android) return null;
	return <div className="mt-4 border-t border-border pt-5">
		<h3 className="font-prose text-lg">Background work</h3>
		<p className="mt-2 text-sm text-muted-foreground">Responses and research continue when you leave the app or lock your phone. Allow notifications to hear when a session is ready, then tap the alert to open it.</p>
		<div className="mt-3 flex flex-wrap gap-3">
			<a href="learnharness://notifications" className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm hover:bg-accent">Notification settings</a>
			<a href="learnharness://app-settings" className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm hover:bg-accent">Android app settings</a>
		</div>
		<p className="mt-2 text-sm text-muted-foreground">For long tasks, allow background battery usage in Android app settings. Battery restrictions can delay work while your phone is asleep.</p>
		<p className="mt-2 text-xs text-muted-foreground">Force stopping the app or restarting your phone interrupts active work. Saved sessions remain available.</p>
	</div>;
}
