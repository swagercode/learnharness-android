import { androidBackgroundResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	if (process.env.LH_ANDROID !== "1") return new Response(null, { status: 404 });
	return androidBackgroundResponse();
}
