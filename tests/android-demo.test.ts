import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { androidDemoDocument, androidRendererReason, runAndroidDemo } from "../src/agent/subagents/android-demo.ts";
import { realHeadless } from "../src/agent/subagents/headless.ts";

async function mailbox(result: unknown, test: (directory: string) => Promise<void>) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-android-demo-"));
	let busy = false;
	const timer = setInterval(async () => {
		if (busy) return; busy = true;
		try {
			for (const name of await fs.readdir(directory)) {
				if (!name.endsWith(".request")) continue;
				const request = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
				assert.match(request.document, /frame.sandbox="allow-scripts"/);
				await fs.writeFile(path.join(directory, name.replace(".request", ".response")), JSON.stringify(result));
			}
		} finally { busy = false; }
	}, 10);
	try { await test(directory); } finally { clearInterval(timer); await fs.rm(directory, { recursive: true, force: true }); }
}

describe("Android demo verification", () => {
	it("selects Android verification without Chrome and gives Android-specific missing-runtime guidance", () => {
		const prior = { android: process.env.LH_ANDROID, directory: process.env.LH_ANDROID_RENDER_DIR };
		try {
			process.env.LH_ANDROID = "1"; delete process.env.LH_ANDROID_RENDER_DIR;
			assert.equal(realHeadless.available(), false); assert.match(realHeadless.unavailableReason()!, /Android/);
			assert.doesNotMatch(realHeadless.unavailableReason()!, /Chrome executable|CHROME_PATH/);
			process.env.LH_ANDROID_RENDER_DIR = "/private/cache";
			assert.equal(realHeadless.available(), true); assert.equal(realHeadless.unavailableReason(), null);
		} finally {
			if (prior.android === undefined) delete process.env.LH_ANDROID; else process.env.LH_ANDROID = prior.android;
			if (prior.directory === undefined) delete process.env.LH_ANDROID_RENDER_DIR; else process.env.LH_ANDROID_RENDER_DIR = prior.directory;
		}
		assert.match(androidRendererReason({})!, /Android/);
	});
	it("escapes embedded documents and probes so they cannot escape the host script", () => {
		const document = androidDemoDocument('<!doctype html><head></head><script>const x="</script><script>parent.pwned=true"</script>', '"</script><script>parent.pwned=true"');
		assert.equal((document.match(/<\/script>/gi) ?? []).length, 1);
		assert.match(document, /allow-scripts/); assert.doesNotMatch(document, /allow-same-origin/);
		assert.match(document, /default-src 'none'/);
		assert.match(document, /\\u003c!doctype html>/);
	});
	it("returns native probe results and cleans up private mailbox files", async () => {
		await mailbox({ consoleErrors: [], pageErrors: [], failedRequests: [], probeResult: { clicked: 2 }, ok: true }, async directory => {
			const result = await runAndroidDemo("<button>Test</button>", { probe: "2" }, directory, 2000);
			assert.equal(result.ok, true); assert.deepEqual(result.probeResult, { clicked: 2 });
			assert.deepEqual(await fs.readdir(directory), []);
		});
	});
	it("never accepts a success flag if the renderer found an error", async () => {
		await mailbox({ consoleErrors: [], pageErrors: ["ReferenceError: missing"], failedRequests: [], ok: true }, async directory => {
			assert.equal((await runAndroidDemo("<script>missing()</script>", {}, directory, 2000)).ok, false);
		});
	});
	it("fails closed on malformed results and a missing renderer", async () => {
		await mailbox({ ok: true }, async directory => { await assert.rejects(runAndroidDemo("demo", {}, directory, 2000), /Invalid Android/); });
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-demo-timeout-"));
		try {
			await assert.rejects(runAndroidDemo("demo", {}, directory, 20), /timed out/);
			assert.deepEqual(await fs.readdir(directory), []);
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});
});
