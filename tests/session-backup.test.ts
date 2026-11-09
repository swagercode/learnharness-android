import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { unzipSync } from "fflate";
import { sessionBackupArchive, sessionBackupSnapshot } from "../src/server/session-backup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backup-test-")); roots.push(root);
	const write = (name: string, value: unknown) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), JSON.stringify(value)); };
	write("chats/chat_test.json", { id: "chat_test", title: "My session", messages: [{ role: "user", content: "Keep me" }] });
	write("jobs/job_test.json", { id: "job_test", chatId: "chat_test", status: "done", result: { html: "<h1>Demo</h1>" } });
	write("settings.json", { version: 1, models: {} });
	write("auth.json", { secret: "never-export-this" });
	write("chatgpt-credentials.json", { token: "never-export-this" });
	return { root, write };
}
describe("restorable session backup", () => {
	it("round-trips exact records and embedded artifacts with verified manifest hashes; excludes credentials", () => {
		const { root } = fixture();
		const snapshot = sessionBackupSnapshot(root, () => false);
		assert.equal(snapshot.sessions, 1); assert.equal(snapshot.jobs, 1);
		const zip = unzipSync(sessionBackupArchive(snapshot));
		const manifest = JSON.parse(Buffer.from(zip["learnharness-backup.json"]!).toString());
		assert.equal(manifest.format, "learnharness-backup"); assert.equal(manifest.version, 1);
		assert.equal(manifest.files.length, 3);
		assert.equal(Object.keys(zip).length, 4);
		for (const record of manifest.files) {
			const restored = Buffer.from(zip[`data/${record.path}`]!);
			assert.deepEqual(restored, fs.readFileSync(path.join(root, record.path)));
			assert.equal(record.bytes, restored.length);
			assert.equal(record.sha256, createHash("sha256").update(restored).digest("hex"));
			assert.ok(!restored.toString().includes("never-export-this"));
		}
	});
	it("refuses snapshots while a session or background job is running", () => {
		const { root, write } = fixture();
		assert.throws(() => sessionBackupSnapshot(root, () => true), /finish responding/);
		write("jobs/job_test.json", { id: "job_test", chatId: "chat_test", status: "running" });
		assert.throws(() => sessionBackupSnapshot(root, () => false), /background research/);
	});
	it("refuses linked files, damaged records, and empty session collections", () => {
		const { root, write } = fixture();
		write("chats/chat_test.json", { id: "different", messages: [] });
		assert.throws(() => sessionBackupSnapshot(root, () => false), /damaged/);
		fs.unlinkSync(path.join(root, "chats/chat_test.json"));
		fs.symlinkSync(path.join(root, "auth.json"), path.join(root, "chats/chat_test.json"));
		assert.throws(() => sessionBackupSnapshot(root, () => false), /linked/);
		fs.unlinkSync(path.join(root, "chats/chat_test.json"));
		assert.throws(() => sessionBackupSnapshot(root, () => false), /no saved sessions/);
	});
});
