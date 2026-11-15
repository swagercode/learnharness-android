/** Private Mac setup. Never resets existing Tailscale services or changes
 * session records. The matching Mac app starts the sync listener. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

const tailscale = process.env.LH_TAILSCALE_BIN ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const data = process.env.LH_SYNC_DATA_DIR ?? path.join(os.homedir(), "Library/Application Support/LearnHarness/data");
const status = JSON.parse(execFileSync(tailscale, ["status", "--json"], { encoding: "utf8" }));
if (status.BackendState !== "Running") throw new Error("Connect Tailscale on this Mac first.");
const hostname = status.Self?.DNSName?.replace(/\.$/, "");
if (!hostname || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname)) throw new Error("Enable MagicDNS for this Mac in Tailscale first.");
const services = JSON.parse(execFileSync(tailscale, ["serve", "status", "--json"], { encoding: "utf8" }));
const existing = services.TCP?.["47823"];
const handlers = services.Web?.[`${hostname}:47823`]?.Handlers;
if (existing && (!existing.HTTPS || Object.keys(handlers ?? {}).length !== 1 || handlers?.["/"]?.Proxy !== "http://127.0.0.1:47823")) throw new Error("Tailscale port 47823 is already used by another service.");
if (services.AllowFunnel?.[`${hostname}:47823`]) throw new Error("Disable public Funnel on port 47823 before setting up private sync.");
const directory = path.join(data, "sync-private"), file = path.join(directory, "config.json");
let config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
if (config && config.mode !== "off" && config.mode !== "host") throw new Error("This app is already paired as a sync client; disconnect it before hosting.");
if (config?.mode !== "host") config = { mode: "host", url: `https://${hostname}:47823`, token: randomBytes(32).toString("hex"), hostId: randomUUID() };
else config.url = `https://${hostname}:47823`;
if (!existing) execFileSync(tailscale, ["serve", "--bg", "--https=47823", "http://127.0.0.1:47823"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const temp = `${file}.${randomUUID()}.tmp`;
fs.writeFileSync(temp, JSON.stringify(config), { mode: 0o600 }); fs.renameSync(temp, file);
const code = `lh-sync-1:${Buffer.from(JSON.stringify({ url: config.url, token: config.token, hostId: config.hostId })).toString("base64url")}`;
const pairing = path.join(directory, "private-pairing.txt");
fs.writeFileSync(pairing, code + "\n", { mode: 0o600 });
console.log("Private Tailscale sync configured at", config.url);
console.log("Open the matching LearnHarness Mac app. Pair your phone from Settings → General → Session sync.");
console.log("Private pairing file:", pairing);
