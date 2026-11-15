/** Synthetic UI only. Never makes a real sync/provider mutation. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
const origin = process.env.LH_LAYOUT_URL ?? "http://localhost:3227";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw Error("Use an isolated local fixture server");
const out = resolve(".local-preview/mobile-v17-sync-ui"); mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
try {
	for (const [width, height] of [[320, 640], [412, 924], [412, 440], [1100, 820]]) {
		const page = await browser.newPage(); await page.setViewport({ width, height, isMobile: width < 600, hasTouch: width < 600 });
		let status = { mode: "off", canHost: width > 600 }, reject = true;
		const writes = [];
		await page.setRequestInterception(true);
		page.on("request", req => {
			if (new URL(req.url()).pathname === "/api/sync") {
				let response = status, code = 200;
				if (req.method() === "POST") {
					const body = JSON.parse(req.postData()); writes.push(body);
					if (body.action === "connect" && reject) { response = { error: "Mac unavailable. Connect Tailscale on both devices." }; code = 503; reject = false; }
					else if (body.action === "connect") response = status = { mode: "client", canHost: status.canHost, url: "https://mac.tailnet-test.ts.net:47823", lastSync: new Date().toISOString(), conflicts: 1, deferred: 1 };
					else if (body.action === "disconnect") response = status = { mode: "off", canHost: status.canHost };
					else if (body.action === "host") response = status = { mode: "host", canHost: true, url: "https://mac.tailnet-test.ts.net:47823" };
					else if (body.action === "pairing") response = { ...status, code: "lh-sync-1:" + "synthetic_private_fixture_".repeat(18) };
				}
				return void req.respond({ status: code, contentType: "application/json", body: JSON.stringify(response) });
			}
			if (!["GET", "HEAD"].includes(req.method())) return void req.abort();
			void req.continue();
		});
		await page.goto(`${origin}/chat/new`, { waitUntil: "domcontentloaded", timeout: 120000 });
		await page.waitForSelector('[data-testid="settings-entry"]');
		await page.evaluate(() => document.querySelector('[data-testid="settings-entry"]').click());
		await page.waitForSelector('[data-testid="settings-nav-general"]', { visible: true });
		await page.click('[data-testid="settings-nav-general"]');
		await page.waitForSelector('[data-testid="sync-pairing-input"]');
		async function click(text) {
			await page.evaluate(text => [...document.querySelectorAll('[data-testid="session-sync"] button')].find(b => b.textContent === text).click(), text);
		}
		async function audit(name) {
			await page.$eval('[data-testid="session-sync"]', el => el.scrollIntoView({ block: "start" }));
			await new Promise(done => setTimeout(done, 150));
			const overflow = await page.$eval('[data-testid="session-sync"]', root => [...root.querySelectorAll("p,input,textarea,button,fieldset")].filter(el => {
				const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1);
			}).map(el => el.tagName));
			assert.deepEqual(overflow, [], `${width} ${name} horizontal overflow`);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
			await page.screenshot({ path: resolve(out, `${width}x${height}-${name}.png`) });
		}
		await audit("disconnected");
		await page.type('[data-testid="sync-pairing-input"]', "lh-sync-1:synthetic-code");
		await click("Connect to Mac");
		await page.waitForFunction(() => document.querySelector('[data-testid="session-sync"] [role="alert"]')?.textContent.includes("Mac unavailable"));
		assert(await page.$('[data-testid="sync-pairing-input"]'));
		await click("Connect to Mac");
		await page.waitForFunction(() => document.querySelector('[data-testid="session-sync"]').textContent.includes("Connected to your Mac"));
		await audit("connected");
		await click("Disconnect sync"); await page.waitForSelector('[data-testid="sync-pairing-input"]');
		if (status.canHost) {
			await page.click('[data-testid="session-sync"] summary');
			await page.type('[data-testid="session-sync"] input', "mac.tailnet-test.ts.net");
			await click("Start sync host");
			await page.waitForFunction(() => document.querySelector('[data-testid="session-sync"]').textContent.includes("Show pairing code"));
			await click("Show pairing code"); await page.waitForSelector('textarea[aria-label="Private pairing code"]');
			await audit("private-code");
		}
		assert.equal(writes[0].code, "lh-sync-1:synthetic-code");
		console.log(`PASS ${width}x${height}: bounded sync controls, offline error, connect and disconnect`);
		await page.close();
	}
} finally { await browser.close(); }
