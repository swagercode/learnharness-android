/** Run against mobile-layout-fixtures.mjs's isolated server. All model/catalog
 * and settings responses below are fixtures; model POSTs are blocked. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const origin = process.env.LH_LAYOUT_URL ?? "http://localhost:3226";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) throw new Error("Use an isolated local fixture server");
const fixture = process.env.LH_LAYOUT_FIXTURE;
if (!fixture) throw new Error("LH_LAYOUT_FIXTURE must name the synthetic fixture directory");
const record = JSON.parse(readFileSync(resolve(fixture, "data/chats/chat_mobile_layout_check.json"), "utf8"));
const output = resolve(process.env.LH_LAYOUT_ARTIFACTS ?? ".local-preview/mobile-v16-speed");
mkdirSync(output, { recursive: true });
const model = { provider: "chatgpt", id: "gpt-6-astra" };
const slot = { model, thinkingLevel: "low" };
const catalog = {
	models: [{ ...model, name: "Astra", input: ["text", "image"], reasoning: true, supportedLevels: ["low", "medium", "high", "xhigh", "max"], cost: null, contextWindow: 272000, maxTokens: 128000 }],
	providers: [{ id: "chatgpt", keyPresent: true }], defaults: slot,
	slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {},
};
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--disable-background-networking"] });
try {
	for (const [width, height] of [[320, 640], [412, 924], [412, 440], [844, 390]]) {
		const page = await browser.newPage();
		page.on("pageerror", error => console.error("Fixture page error:", error.message));
		page.on("requestfailed", request => console.error("Fixture request failed:", request.url(), request.failure()?.errorText));
		page.on("console", message => { if (message.type() === "error") console.error("Fixture console:", message.text()); });
		await page.setViewport({ width, height, isMobile: true, hasTouch: true });
		let settings = { ...slot };
		await page.evaluateOnNewDocument(() => { localStorage.setItem("lh:sidebar-open", "0"); });
		await page.setRequestInterception(true);
		page.on("request", request => {
			const url = new URL(request.url());
			const json = body => request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
			if (url.origin === origin) {
				if (url.pathname === "/api/models") return void json(catalog);
				if (url.pathname === "/api/settings") return void json({ settings: { models: catalog.slots } });
				if (url.pathname === `/api/chats/${record.id}`) return void json({ ...record, settings });
				if (url.pathname === `/api/chats/${record.id}/settings` && request.method() === "PUT") {
					settings = JSON.parse(request.postData());
					return void json({ settings });
				}
			}
			if (!["GET", "HEAD"].includes(request.method())) return void request.abort();
			return void request.continue();
		});
		await page.goto(`${origin}/chat/${record.id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
		const trigger = "[data-testid=stats-thinking]";
		await page.waitForSelector(`${trigger}[aria-label*="Standard"]`, { visible: true, timeout: 30000 });
		await page.click(trigger);
		await page.waitForSelector("[data-testid=astra-speed-fast]", { visible: true });
		await page.$eval("[data-testid=astra-speed-fast]", el => el.scrollIntoView({ block: "nearest" }));
		await new Promise(done => setTimeout(done, 250));
		const bounds = await page.$eval("[data-testid=thinking-menu]", el => el.getBoundingClientRect().toJSON());
		assert(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1, JSON.stringify(bounds));
		assert(await page.$eval("[data-testid=astra-speed-fast]", el => el.getBoundingClientRect().height >= 44), "Touch target is at least 44px high");
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
		await page.screenshot({ path: resolve(output, `${width}x${height}.png`) });
		await page.click("[data-testid=astra-speed-fast]");
		await page.waitForSelector(`${trigger}[aria-label*="Fast"]`);
		assert.deepEqual(settings, { ...slot, fastMode: true });
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForSelector(`${trigger}[aria-label*="Fast"]`, { visible: true });
		await page.click(trigger);
		await page.$eval("[data-testid=astra-speed-standard]", el => el.scrollIntoView({ block: "nearest" }));
		await page.click("[data-testid=astra-speed-standard]");
		await page.waitForSelector(`${trigger}[aria-label*="Standard"]`);
		assert.deepEqual(settings, { ...slot, fastMode: false });
		console.log(`PASS ${width}x${height}: bounded speed menu, explicit enable, reload, and Standard restore`);
		await page.close();
	}
} catch (error) {
	const pages = await browser.pages();
	const page = pages.at(-1);
	if (page) {
		await page.screenshot({ path: resolve(output, "failure.png") });
		console.error((await page.$eval("body", el => el.innerText)).slice(-2500));
	}
	throw error;
} finally { await browser.close(); }
