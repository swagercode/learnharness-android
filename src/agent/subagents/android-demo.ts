import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { DemoRunResult, RunDemoOptions } from "./headless.ts";

// JSON inside an inline script must not be able to close that script.
const scriptJSON = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Same opaque-origin sandbox as the delivered demo. No native JavaScript
 * interface, app origin, cookies, local files or network are exposed. */
export function androidDemoDocument(html: string, probe?: string): string {
	const nonce = randomUUID();
	const harness = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<script>(()=>{
const nonce=${scriptJSON(nonce)};
const send=(kind,value)=>parent.postMessage({nonce,kind,value},"*");
const text=(x)=>{try{return typeof x==="string"?x:JSON.stringify(x)}catch{return String(x)}};
const original=console.error.bind(console);
console.error=(...args)=>{send("consoleErrors",args.map(text).join(" "));original(...args)};
addEventListener("error",e=>{if(e.target!==window){send("failedRequests",e.target.src||e.target.href||"Resource failed")}else send("pageErrors",e.message||"Uncaught error")},true);
addEventListener("unhandledrejection",e=>send("pageErrors",text(e.reason)||"Unhandled rejection"));
addEventListener("securitypolicyviolation",e=>send("failedRequests","Offline verifier blocked "+e.blockedURI));
addEventListener("message",e=>{
if(e.source!==parent||e.data?.nonce!==nonce||e.data.kind!=="probe")return;
Promise.resolve().then(()=>e.data.expression?(0,eval)(e.data.expression):null).then(value=>{
let encoded=JSON.stringify(value===undefined?null:value);
if(encoded.length>65536)throw Error("Probe result is too large");
send("probeResult",JSON.parse(encoded));
}).catch(error=>{send("pageErrors","probe failed: "+String(error));send("probeResult",null)});
});
})();</script>`;

	const instrumented = /<head\b[^>]*>/i.test(html)
		? html.replace(/<head\b[^>]*>/i, (head) => head + harness)
		: html.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + harness);
	return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}iframe{border:0;width:100%;height:800px}</style></head><body><script>
(()=>{
const frame=document.createElement("iframe");frame.sandbox="allow-scripts";
const nonce=${scriptJSON(nonce)}, result={consoleErrors:[],pageErrors:[],failedRequests:[]};
window.__lhLoaded=false;window.__lhResult=null;
addEventListener("message",e=>{
if(e.source!==frame.contentWindow||e.data?.nonce!==nonce)return;
const {kind,value}=e.data;
if(kind==="probeResult"){${probe ? "result.probeResult=value;" : ""}window.__lhResult=result;return}
if(["consoleErrors","pageErrors","failedRequests"].includes(kind)&&result[kind].length<32)result[kind].push(String(value).slice(0,1000));
});
window.__lhStartProbe=()=>frame.contentWindow.postMessage({nonce,kind:"probe",expression:${scriptJSON(probe ?? "")}},"*");
frame.onload=()=>{window.__lhLoaded=true};
frame.srcdoc=${scriptJSON(instrumented)};document.body.appendChild(frame);
})();</script></body></html>`;
}

export function androidRendererReason(env: Record<string, string | undefined> = process.env): string | null {
	return env.LH_ANDROID_RENDER_DIR ? null : "Android demo verification requires Android 9 or newer and an up-to-date Android System WebView. Update LearnHarness and try the demo again.";
}

/** Private app-cache mailbox shared with the bound native renderer service.
 * Atomic request/response files work without a browser-debug port or an HTTP
 * endpoint that generated HTML could call. A timeout is a failed verification. */
export async function runAndroidDemo(html: string, opts: RunDemoOptions = {}, directory = process.env.LH_ANDROID_RENDER_DIR, timeoutMs = 130_000): Promise<DemoRunResult> {
	if (!directory) throw new Error(androidRendererReason({})!);
	if (Buffer.byteLength(html, "utf8") > 1_000_000 || (opts.probe?.length ?? 0) > 64_000) throw new Error("Demo is too large for Android verification. Use a smaller self-contained document.");
	const id = randomUUID();
	const request = path.join(directory, `${id}.request`), response = path.join(directory, `${id}.response`);
	const payload = JSON.stringify({ document: androidDemoDocument(html, opts.probe), settleMs: Math.min(5000, Math.max(0, opts.settleMs ?? 2000)), createdAt: Date.now() });
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await fs.writeFile(`${request}.tmp`, payload, { mode: 0o600, flag: "wx" });
		await fs.rename(`${request}.tmp`, request);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const stat = await fs.stat(response);
				if (stat.size > 262_144) throw new Error("Android verifier returned an oversized result");
				const value: unknown = JSON.parse(await fs.readFile(response, "utf8"));
				if (!value || typeof value !== "object") throw new Error("Invalid Android verification result");
				const result = value as DemoRunResult;
				for (const key of ["consoleErrors", "pageErrors", "failedRequests"] as const) {
					if (!Array.isArray(result[key]) || result[key].some((entry) => typeof entry !== "string")) throw new Error("Invalid Android verification errors");
				}
				// Never trust a success flag that disagrees with the actual errors.
				return { ...result, ok: result.consoleErrors.length === 0 && result.pageErrors.length === 0 && result.failedRequests.length === 0 };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		throw new Error("Android demo verification timed out. Reopen LearnHarness and try the demo again.");
	} finally {
		await Promise.all([request, `${request}.tmp`, response].map(file => fs.rm(file, { force: true }).catch(() => {})));
	}
}
