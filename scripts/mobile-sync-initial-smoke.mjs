/** Synthetic first-sync setup UI. All sync writes are intercepted; no learner data. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
const origin = process.env.LH_LAYOUT_URL ?? "http://localhost:3227";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw Error("Use an isolated local fixture server");
const out = resolve(".local-preview/mobile-v18-initial-ui"); mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const pause = ms => new Promise(done => setTimeout(done, ms));
try {
	for (const [width, height] of [[320, 640], [412, 924], [412, 320], [924, 412]]) {
		const page = await browser.newPage(); await page.setViewport({ width, height, isMobile: width < 600, hasTouch: width < 600 });
		let status = { mode: "client", canHost: false, initialRequired: true, url: "https://mac.tailnet-test.ts.net:47823" }, fail = true;
		const writes = [];
		await page.setRequestInterception(true);
		page.on("request", async req => {
			if (new URL(req.url()).pathname === "/api/sync") {
				let response = status, code = 200;
				if (req.method() === "POST") {
					const body = JSON.parse(req.postData()); writes.push(body);
					assert.equal(body.action, "initial");
					await pause(150);
					if (fail) { response = { error: "Sync could not start. Try again." }; code = 503; fail = false; }
					else response = status = { ...status, initialRequired: false };
				}
				return void req.respond({ status: code, contentType: "application/json", body: JSON.stringify(response) });
			}
			if (!["GET", "HEAD"].includes(req.method())) return void req.abort();
			void req.continue();
		});
		await page.goto(`${origin}/chat/new`, { waitUntil: "domcontentloaded", timeout: 120000 });
		await page.waitForSelector('[data-testid="sync-initial-dialog"]', { visible: true });
		async function refresh(review = false) {
			await page.evaluate(review => window.dispatchEvent(new Event(review ? "lh:review-initial-sync" : "lh:sync-status-changed")), review); await pause(250);
		}
		async function audit(name) {
			const bounds = await page.$eval('[data-testid="sync-initial-dialog"]', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; });
			assert(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1, `${width}x${height} dialog stays in viewport`);
			assert(bounds.scrollWidth <= bounds.clientWidth + 1, "First-sync setup has no horizontal overflow");
			assert(await page.$$eval('[data-testid="sync-initial-dialog"] button', buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)));
			await page.screenshot({ path: resolve(out, `${width}x${height}-${name}.png`) });
		}
		await audit("choice");
		assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "sync-initial-later");
		await page.keyboard.press("Tab");
		assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "sync-use-phone");
		await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
		assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "sync-initial-later");
		await page.keyboard.press("Escape"); await refresh();
		assert.equal(await page.$('[data-testid="sync-initial-dialog"]'), null); assert.equal(writes.length, 0);
		await page.evaluate(() => document.querySelector('[data-testid="settings-entry"]').click());
		await page.waitForSelector('[data-testid="settings-nav-general"]'); await page.click('[data-testid="settings-nav-general"]');
		await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-sync"] button')].some(button => button.textContent === "Choose first sync source"));
		await page.evaluate(() => [...document.querySelectorAll('[data-testid="session-sync"] button')].find(button => button.textContent === "Choose first sync source").click());
		await page.waitForSelector('[data-testid="sync-initial-dialog"]'); await refresh();
		assert(await page.$('[data-testid="sync-initial-dialog"]'), "Explicit review stays open across polling");
		await page.click('[data-testid="sync-use-phone"]');
		await page.waitForFunction(() => document.querySelector('[data-testid="sync-initial-dialog"] [role="alert"]')?.textContent.includes("Try again"));
		assert.equal(writes[0].source, "phone");
		await audit("retry");
		await page.click('[data-testid="sync-use-phone"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="sync-initial-dialog"]'));
		await refresh(); assert.equal(await page.$('[data-testid="sync-initial-dialog"]'), null);
		assert.equal(writes.length, 2);
		console.log(`PASS ${width}x${height}: first phone source, retry, focus, dismissal and bounded layout`);
		await page.close();
	}
} finally { await browser.close(); }
