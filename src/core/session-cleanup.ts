/** Local archive marker: keeps the recoverable record out of session lists. */
export interface SessionCleanup {
	replacementId: string;
	revision: string;
	appliedAt: string;
}
export function cleanupReplacement(record: unknown): string | undefined {
	const chat = record as { id?: unknown; syncCleanup?: SessionCleanup } | null;
	const marker = chat?.syncCleanup;
	if (marker && typeof marker.replacementId === "string" && /^chat_[A-Za-z0-9_-]{1,100}$/.test(marker.replacementId) && marker.replacementId !== chat?.id && /^[a-f0-9]{64}$/.test(marker.revision) && Number.isFinite(Date.parse(marker.appliedAt))) return marker.replacementId;
}
