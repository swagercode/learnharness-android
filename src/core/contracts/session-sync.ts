/** Only revision metadata crosses the local UI boundary; never pairing secrets. */
export interface SyncConflict {
	id: string;
	title: string;
	localHash: string;
	remoteHash: string;
	localUpdatedAt: string;
	remoteUpdatedAt: string;
	localMessages: number;
	remoteMessages: number;
}
export interface SyncResolution {
	id: string;
	source: "mac" | "phone";
	localHash: string;
	remoteHash: string;
}
