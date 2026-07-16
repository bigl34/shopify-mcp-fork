/**
 * A fetch wrapper that retries transient transport failures against the Shopify
 * Admin GraphQL API.
 *
 * Some Shopify edge responses are transient, and an identical request can
 * succeed on retry. graphql-request has no built-in retry handling, so this
 * wrapper retries only transport failures that are safe to attempt again.
 *
 * Safety of retrying these specific failures:
 *  - GraphQL business errors arrive as HTTP 200 with an `errors` body, so they
 *    are never retried here (only the HTTP transport layer is considered).
 *  - On the Shopify GraphQL endpoint a 404 is ALWAYS a transport/edge fault: a
 *    genuine "resource not found" comes back as 200 + errors, never as a 404.
 *    So a 404 means the request never reached the resolver — retrying a 404'd
 *    mutation cannot double-apply it.
 *  - Deterministic client faults (400 bad request, 401/403 auth, 422 invalid)
 *    are NOT retried — they must surface immediately.
 */

type FetchFunction = (url: any, init?: any) => Promise<any>;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  404, // transient Shopify/Cloudflare edge fault (see file header)
  408, // request timeout
  425, // too early
  429, // throttled (honours Retry-After below)
  500,
  502,
  503,
  504
]);

export interface RetryingFetchOptions {
  /** Total tries including the first. */
  maxAttempts?: number;
  /** Exponential backoff base, in milliseconds. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff wait, in milliseconds. */
  maxDelayMs?: number;
  /** Abort + retry any single attempt that exceeds this, in milliseconds. */
  attemptTimeoutMs?: number;
  /** Prefix for the stderr retry log lines. */
  label?: string;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createRetryingFetch(
  baseFetch: FetchFunction,
  options: RetryingFetchOptions = {}
): FetchFunction {
  const maxAttempts = options.maxAttempts ?? 12;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 1500;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 15000;
  const label = options.label ?? "shopify-mcp";

  const backoffDelayMs = (attemptIndex: number): number => {
    const exponential = baseDelayMs * Math.pow(2, attemptIndex);
    const capped = Math.min(exponential, maxDelayMs);
    const jitter = capped * 0.25 * Math.random();
    return Math.round(capped + jitter);
  };

  return async (url: any, init?: any): Promise<any> => {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const isLastAttempt = attempt === maxAttempts - 1;

      // Bound each attempt so a hung socket can't wedge the whole tool call.
      // Respect a caller-supplied signal if one already exists.
      const callerAlreadyHasSignal = Boolean(init?.signal);
      const abortController = new AbortController();
      const attemptTimer = setTimeout(
        () => abortController.abort(),
        attemptTimeoutMs
      );
      const attemptInit = callerAlreadyHasSignal
        ? init
        : { ...init, signal: abortController.signal };

      try {
        const response = await baseFetch(url, attemptInit);

        const statusIsRetryable = RETRYABLE_STATUSES.has(response.status);
        if (!statusIsRetryable) {
          return response;
        }

        if (isLastAttempt) {
          // Hand the real (still-failing) response back to graphql-request so
          // it can throw its normal GraphQL error with the true status.
          return response;
        }

        // Drain the body before retrying so undici releases the socket.
        await response.text().catch(() => {});

        const retryAfterHeader = response.headers?.get?.("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : 0;
        const waitMs = Math.max(retryAfterMs, backoffDelayMs(attempt));

        console.error(
          `[${label}] transient HTTP ${response.status} (attempt ${attempt + 1}/${maxAttempts}) — retrying in ${waitMs}ms`
        );
        await sleep(waitMs);
        continue;
      } catch (error) {
        lastError = error;

        if (isLastAttempt) {
          throw error;
        }

        const waitMs = backoffDelayMs(attempt);
        const reason = (error as Error)?.message ?? String(error);
        console.error(
          `[${label}] network error (attempt ${attempt + 1}/${maxAttempts}) — retrying in ${waitMs}ms: ${reason}`
        );
        await sleep(waitMs);
        continue;
      } finally {
        clearTimeout(attemptTimer);
      }
    }

    // The loop always returns or throws on the last attempt; this is only here
    // to satisfy the type checker.
    throw lastError ?? new Error(`[${label}] retry loop exhausted`);
  };
}
