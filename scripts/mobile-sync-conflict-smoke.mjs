/** Synthetic conflict UI. All sync writes are intercepted; no learner data. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
const origin = process.env.LH_LAYOUT_URL ?? "http://localhost:3227";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw Error("Use an isolated local fixture server");
const out = resolve(".local-preview/mobile-v18-conflict-ui"); mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const pause = ms => new Promise(done => setTimeout(done, ms));
try {
	for (const [width, height] of [[320, 640], [412, 924], [412, 320], [924, 412]]) {
		const page = await browser.newPage(); await page.setViewport({ width, height, isMobile: width < 600, hasTouch: width < 600 });
		const conflict = { id: "chat_conflict", title: "Spatial reasoning: " + "LongSessionTitle".repeat(10), localHash: "a".repeat(64), remoteHash: "b".repeat(64), localUpdatedAt: "2026-11-15T10:00:00Z", remoteUpdatedAt: "2026-11-15T11:00:00Z", localMessages: 38, remoteMessages: 46 };
		let status = { mode: "client", canHost: false, conflicts: 1, pending: [conflict], url: "https://mac.tailnet-test.ts.net:47823" }, failure = "stale";
		const writes = [];
		await page.setRequestInterception(true);
		page.on("request", async req => {
			if (new URL(req.url()).pathname === "/api/sync") {
				let response = status, code = 200;
				if (req.method() === "POST") {
					const body = JSON.parse(req.postData()); writes.push(body);
					assert.equal(body.action, "resolve");
					await pause(150);
					if (failure === "stale") {
						status = { ...status, pending: [{ ...conflict, remoteHash: "c".repeat(64), remoteMessages: 92 }] };
						response = { error: "This session changed. Review the versions and choose again." }; code = 409; failure = "";
					} else if (failure === "offline") { response = { error: "Mac unavailable. Sync will retry automatically." }; code = 503; failure = ""; }
					else response = status = { ...status, conflicts: 0, pending: [] };
				}
				return void req.respond({ status: code, contentType: "application/json", body: JSON.stringify(response) });
			}
			if (!["GET", "HEAD"].includes(req.method())) return void req.abort();
			void req.continue();
		});
		await page.goto(`${origin}/chat/new`, { waitUntil: "domcontentloaded", timeout: 120000 });
		await page.waitForSelector('[data-testid="sync-conflict-dialog"]', { visible: true });
		async function refresh(review = false) {
			await page.evaluate(review => window.dispatchEvent(new Event(review ? "lh:review-sync-conflicts" : "lh:sync-status-changed")), review); await pause(250);
		}
		async function audit(name) {
			const bounds = await page.$eval('[data-testid="sync-conflict-dialog"]', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; });
			assert(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1, `${width}x${height} dialog stays in viewport`);
			assert(bounds.scrollWidth <= bounds.clientWidth + 1, "Long session names wrap without horizontal overflow");
			assert(await page.$$eval('[data-testid="sync-conflict-dialog"] button', buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)));
			await page.screenshot({ path: resolve(out, `${width}x${height}-${name}.png`) });
		}
		await audit("choice");
		assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "sync-conflict-later");
		await page.keyboard.press("Tab");
		assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "sync-use-mac");
		await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
		assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "sync-conflict-later");
		await page.keyboard.press("Escape"); await refresh();
		assert.equal(await page.$('[data-testid="sync-conflict-dialog"]'), null); assert.equal(writes.length, 0);
		await page.evaluate(() => document.querySelector('[data-testid="settings-entry"]').click());
		await page.waitForSelector('[data-testid="settings-nav-general"]'); await page.click('[data-testid="settings-nav-general"]');
		await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-sync"] button')].some(button => button.textContent === "Choose sync source"));
		await page.evaluate(() => [...document.querySelectorAll('[data-testid="session-sync"] button')].find(button => button.textContent === "Choose sync source").click());
		await page.waitForSelector('[data-testid="sync-conflict-dialog"]'); await refresh();
		assert(await page.$('[data-testid="sync-conflict-dialog"]'), "Explicit review stays open across polling");
		await page.click('[data-testid="sync-use-mac"]');
		await page.waitForFunction(() => document.querySelector('[data-testid="sync-conflict-dialog"] [role="alert"]')?.textContent.includes("changed"));
		await page.waitForFunction(() => document.querySelector('[data-testid="sync-use-mac"]')?.textContent.includes("92 messages"));
		assert.equal(writes[0].resolution.source, "mac"); assert.equal(writes[0].resolution.remoteHash, "b".repeat(64));
		await audit("changed");
		await page.click('[data-testid="sync-use-mac"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="sync-conflict-dialog"]'));
		assert.equal(writes[1].resolution.remoteHash, "c".repeat(64));
		await page.click('[aria-label="Close settings"]');
		status = { ...status, conflicts: 1, pending: [{ ...conflict, localHash: "d".repeat(64), remoteHash: "e".repeat(64) }] }; failure = "offline";
		await refresh(); await page.waitForSelector('[data-testid="sync-conflict-dialog"]');
		await page.click('[data-testid="sync-use-phone"]');
		await page.waitForFunction(() => document.querySelector('[data-testid="sync-conflict-dialog"] [role="alert"]')?.textContent.includes("unavailable"));
		assert.equal(writes[2].resolution.source, "phone"); assert.equal(writes[2].resolution.localHash, "d".repeat(64));
		await audit("offline");
		await page.click('[data-testid="sync-use-phone"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="sync-conflict-dialog"]'));
		assert.equal(writes.length, 4);
		console.log(`PASS ${width}x${height}: source choices, revision refresh, offline retry, focus, dismissal and bounded layout`);
		await page.close();
	}
} finally { await browser.close(); }
