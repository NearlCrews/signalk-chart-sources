import { assertPublicHttpsUrlShape } from '../src/validate.js'

// Request policy for the scheduled upstream monitor: which URLs it may fetch, and which failures are
// worth another attempt.

/** Validate an initial or redirected URL used by the scheduled upstream monitor. */
export function checkedPublicHttpsUrl(value: string, base?: string): URL {
  const url = new URL(value, base)
  // The same shape catalog URLs must have: a public service on the default port, with nothing after
  // the request target that a server never sees anyway.
  assertPublicHttpsUrlShape(url, url.href)
  return url
}

/** An upstream answer with a status outside 200 to 299. */
export class HttpStatusError extends Error {
  readonly status: number

  constructor(url: string, status: number) {
    super(`${url} returned HTTP ${status}`)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

/** An error's message, or the thrown value itself when it is not an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An error's message followed by its cause's, which fetch keeps the useful half of a failure in. */
function describeFailure(error: unknown): string {
  const message = errorMessage(error)
  return error instanceof Error && error.cause !== undefined ? `${message} (${errorMessage(error.cause)})` : message
}

/**
 * A request that got no complete answer: a refused or reset connection, a failed lookup, or the
 * deadline. fetch reports most of these as a bare "fetch failed", so the message carries the URL
 * and the underlying cause instead.
 */
export class UpstreamUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`${url} could not be fetched: ${describeFailure(cause)}`, { cause })
    this.name = 'UpstreamUnreachableError'
  }
}

/**
 * A rejection handler for a request or body read against the URL: it rethrows the failure as an
 * UpstreamUnreachableError, which the retry policy treats as transient.
 */
export function rethrowUnreachable(url: string): (error: unknown) => never {
  return (error) => {
    throw new UpstreamUnreachableError(url, error)
  }
}

/** Statuses a later attempt can plausibly change: a timeout, a rate limit, or a server or gateway fault. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * Whether a failed fetch is worth another attempt. Only an unreachable upstream or a transient status
 * qualifies; any other status, and a response the monitor itself rejected, would fail the same way again.
 */
export function isTransientFetchFailure(error: unknown): boolean {
  if (error instanceof HttpStatusError) return TRANSIENT_STATUSES.has(error.status)
  return error instanceof UpstreamUnreachableError
}

/**
 * The pause before each retry of a transient failure, one per retry. They give a gateway fault a few
 * seconds to clear: a 502 retried after half a second mostly meets the same fault. Three timed-out
 * attempts and both pauses still fit well inside the workflow timeout.
 */
const RETRY_DELAYS_MS = [2_000, 6_000] as const
/** How far each pause may stray either way, as a fraction of it. */
const RETRY_JITTER = 0.2

/**
 * The pause before retrying after the given failed attempt, counting from zero, or undefined once the
 * retries are spent. Each pause strays up to a fifth either way at random, so the checks that share a
 * host and failed together do not all retry it in the same instant.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number | undefined {
  const delay = RETRY_DELAYS_MS[attempt]
  return delay === undefined ? undefined : delay * (1 - RETRY_JITTER + 2 * RETRY_JITTER * random())
}
