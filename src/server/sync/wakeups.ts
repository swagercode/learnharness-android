import { randomUUID } from "node:crypto";

/** A connected phone long-polls this private channel. Opening/editing a Mac
 * session asks it to flush that session before the Mac reads its record. */
export class SyncWakeups {
	private activeUntil = 0;
	private listeners = new Set<() => void>();
	private pending = new Map<string, { chatId: string; finish: (ready: boolean) => void }>();
	constructor(private pollMs = 20_000, private editMs = 4_000) {}
	async wait(signal: AbortSignal): Promise<{ id: string; chatId: string }[]> {
		this.activeUntil = Date.now() + this.pollMs + 10_000;
		if (!this.pending.size && !signal.aborted) await new Promise<void>(resolve => {
			const done = () => { clearTimeout(timer); this.listeners.delete(done); signal.removeEventListener("abort", done); resolve(); };
			const timer = setTimeout(done, this.pollMs);
			this.listeners.add(done); signal.addEventListener("abort", done, { once: true });
		});
		return signal.aborted ? [] : [...this.pending].map(([id, request]) => ({ id, chatId: request.chatId }));
	}
	request(chatId: string): Promise<boolean> {
		if (Date.now() > this.activeUntil) return Promise.resolve(false);
		return new Promise(resolve => {
			const id = randomUUID();
			const finish = (ready: boolean) => { clearTimeout(timer); this.pending.delete(id); resolve(ready); };
			const timer = setTimeout(() => finish(false), this.editMs);
			this.pending.set(id, { chatId, finish });
			for (const notify of this.listeners) notify();
		});
	}
	ready(ids: string[]) { for (const id of ids) this.pending.get(id)?.finish(true); }
	close() {
		this.activeUntil = 0;
		for (const request of this.pending.values()) request.finish(false);
		for (const notify of this.listeners) notify();
	}
}
