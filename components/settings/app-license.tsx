export function AppLicense() {
	return <div className="space-y-2 border-t pt-4 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="app-license">
		<p className="font-medium text-foreground">LearnHarness Android</p>
		<p>An independent Android port of LearnHarness by Amos Blomqvist and contributors, based on Matias Sanmiguel’s fork. Android modifications by swagercode, November 2026.</p>
		<p>Free software under GNU AGPL-3.0-only. You may modify and redistribute it under that license. Provided without warranty.</p>
		<div className="flex flex-wrap gap-x-4 gap-y-2">
			<a className="underline underline-offset-2" href="https://github.com/swagercode/learnharness-android" target="_blank" rel="noreferrer">Source code</a>
			<a className="underline underline-offset-2" href="https://github.com/swagercode/learnharness-android/blob/main/LICENSE" target="_blank" rel="noreferrer">License</a>
		</div>
	</div>;
}
