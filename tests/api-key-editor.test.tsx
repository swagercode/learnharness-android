import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ApiKeyEditor } from "../components/settings/api-key-editor.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLElement;
const key = "a1B2".repeat(10); // synthetic; no provider calls
const element = (name: string) => document.querySelector<HTMLElement>(`[data-testid="key-${name}"]`)!;
async function mount(onSave: (value: string) => Promise<string | null>) {
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root.render(<ApiKeyEditor id="DEEPGRAM_API_KEY" label="Deepgram" testid="key" onSave={onSave} onCancel={() => {}} />));
}
async function importText(text: string, size = text.length) {
	const input = element("file");
	Object.defineProperty(input, "files", { configurable: true, value: [{ size, text: async () => text }] });
	await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
}
async function save() { await act(async () => element("save").click()); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

test("import reads and normalizes the key without saving until requested", async () => {
	const writes: string[] = [];
	await mount(async (value) => { writes.push(value); return null; });
	await importText(`\uFEFF${key.slice(0, 20)}\n${key.slice(20)}\n`);
	assert.deepEqual(writes, []);
	assert.match(element("count").textContent!, /40 \/ 40/);
	assert.equal(element("input").getAttribute("type"), "password");
	await save(); assert.deepEqual(writes, [key]);
});

test("filename and oversized file are rejected without storing or exposing their contents", async () => {
	await mount(async () => assert.fail("invalid file must not save"));
	await importText("LearnHarness-Deepgram-key.txt");
	assert.match(element("error").textContent!, /40-character/);
	assert.equal((element("input") as HTMLInputElement).value, "");
	await importText(key, 4097);
	assert.match(element("error").textContent!, /small .txt file/);
	assert.ok(element("save").hasAttribute("disabled"));
});

test("a failed save preserves the full key and releases the button for a retry", async () => {
	let attempts = 0;
	await mount(async (value) => { assert.equal(value, key); if (++attempts === 1) throw new Error("offline"); return null; });
	await importText(key);
	await save();
	assert.match(element("error").textContent!, /Check your connection/);
	assert.equal((element("input") as HTMLInputElement).value, key);
	assert.equal(element("save").hasAttribute("disabled"), false);
	await save(); assert.equal(attempts, 2);
});
