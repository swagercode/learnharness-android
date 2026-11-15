import { configureSync, syncStatus } from "@/src/server/session-sync";
import { SyncError } from "@/src/store/session-sync";

export const dynamic = "force-dynamic";
export async function GET() { return Response.json(await syncStatus(), { headers: { "Cache-Control": "no-store" } }); }
export async function POST(request: Request) {
	try {
		const text = await request.text();
		if (text.length > 8192) throw new SyncError(413, "Pairing code is too large.");
		return Response.json(await configureSync(JSON.parse(text)), { headers: { "Cache-Control": "no-store" } });
	} catch (e) {
		return Response.json({ error: e instanceof SyncError ? e.message : "Could not connect. Check Tailscale on both devices and keep LearnHarness open on your Mac." }, { status: e instanceof SyncError ? e.status : 503, headers: { "Cache-Control": "no-store" } });
	}
}
