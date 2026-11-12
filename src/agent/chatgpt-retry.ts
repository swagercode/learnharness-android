// Retry only the HTTP admission step. Once a response body has been handed to
// the streaming parser, replaying it could duplicate output or local tool work.
const MAX_RETRIES = 5;
const RETRY_WINDOW_MS = 5 * 60_000;

type RetryClock = {
	now: () => number;
	random: () => number;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return; }
		const abort = () => { clearTimeout(timer); reject(signal.reason); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}

const clock: RetryClock = { now: Date.now, random: Math.random, sleep };

function networkFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const cause = error.cause as { code?: string } | undefined;
	const code = (error as Error & { code?: string }).code ?? cause?.code ?? "";
	return /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET))$/.test(code)
		|| (error instanceof TypeError && /fetch failed|failed to fetch|network request failed|load failed/i.test(error.message));
}

async function retryable(response: Response): Promise<boolean> {
	if (![408, 409, 429].includes(response.status) && response.status < 500) return false;
	if (response.headers.get("x-should-retry") === "false") return false;
	let code = "", type = "";
	try {
		const body = await response.clone().json() as { code?: unknown; error?: { code?: unknown; type?: unknown } };
		if (typeof body.error?.code === "string") code = body.error.code;
		else if (typeof body.code === "string") code = body.code;
		if (typeof body.error?.type === "string") type = body.error.type;
	} catch { /* Proxies sometimes return HTML for a temporary server error. */ }
	// Plan limits are also 429. Never guess a reset time or spin on auth,
	// eligibility, unsupported capabilities, billing, or exhausted quota.
	if (/quota|usage_limit|billing|credit|invalid|expired|permission|auth|eligib|unsupported|access_denied/i.test(`${code} ${type}`)) return false;
	if (response.status === 429) return /^(slow_down|rate_limit_exceeded|rate_limit_error|too_many_requests|throttled)$/.test(code || type);
	return true;
}

function retryAfter(response: Response | undefined, now: number): number {
	const header = response?.headers.get("retry-after");
	const milliseconds = response?.headers.get("retry-after-ms");
	const seconds = header?.trim() && /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : NaN;
	const date = header && !Number.isFinite(seconds) ? Date.parse(header) - now : NaN;
	const ms = milliseconds?.trim() && /^\d+(\.\d+)?$/.test(milliseconds.trim()) ? Number(milliseconds) : NaN;
	return Math.max(0, ...[seconds, date, ms].filter(Number.isFinite));
}

/** A bounded, cancellable retry loop in the local runtime, independent of the UI. */
export async function retryChatGPTRequest(
	request: (attempt: number) => Promise<Response>,
	signal: AbortSignal,
	timing: RetryClock = clock,
): Promise<Response> {
	const deadline = timing.now() + RETRY_WINDOW_MS;
	let response: Response | undefined;
	let failure: unknown;
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		if (attempt > 0 && timing.now() >= deadline) {
			if (response) return response;
			throw failure;
		}
		// Release the previous error response only when another attempt will run.
		void response?.body?.cancel().catch(() => {});
		response = undefined;
		try {
			response = await request(attempt);
		} catch (error) {
			signal.throwIfAborted();
			if (!networkFailure(error)) throw error;
			failure = error;
		}
		signal.throwIfAborted();
		if (response && !await retryable(response)) return response;
		signal.throwIfAborted();
		const delay = Math.max(2_000 * 2 ** attempt * (1 + timing.random() * 0.25), retryAfter(response, timing.now()));
		if (attempt >= MAX_RETRIES || timing.now() + delay >= deadline) {
			if (response) return response;
			throw failure;
		}
		await timing.sleep(delay, signal);
		signal.throwIfAborted();
	}
}
