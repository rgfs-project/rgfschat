import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type Response as UndiciResponse,
} from 'undici';
import { AppError } from '../errors/AppError.ts';

/**
 * SSRF protection for outbound provider requests (INV-19).
 *
 * The threat is a provider URL — from config, or from an admin edit in Phase 9 —
 * that points at something inside our own network: a metadata service, an
 * internal admin panel, a database. Validating the URL *string* is not enough,
 * because a hostname that resolves to a public address during validation can
 * resolve to `169.254.169.254` a second later. That is DNS rebinding.
 *
 * So validation happens in two parts:
 *   1. the URL shape is checked (scheme, no credentials, no fragment);
 *   2. at **request time** the hostname is resolved, every returned address is
 *      checked, and the connection is then **pinned** to an address that
 *      passed — the socket cannot be redirected to a different one afterwards.
 *
 * Redirects are never followed: a 302 to `http://169.254.169.254/` would
 * otherwise walk straight past every check above.
 */

export interface HostPolicy {
  /**
   * Whether private/loopback ranges are permitted. Default `true`, because a
   * local llama.cpp on `127.0.0.1` or a LAN box is the primary use case.
   * Metadata and link-local ranges are blocked regardless.
   */
  allowPrivateHosts: boolean;
  /** When non-empty, only these hostnames may be used at all. */
  hostAllowlist: string[];
}

export const DEFAULT_HOST_POLICY: HostPolicy = {
  allowPrivateHosts: true,
  hostAllowlist: [],
};

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Reasons are deliberately coarse: they are logged, never returned to a client. */
export type SsrfRejection =
  | 'scheme'
  | 'credentials'
  | 'fragment'
  | 'hostname'
  | 'allowlist'
  | 'unresolvable'
  | 'blocked-address';

export class SsrfError extends Error {
  readonly reason: SsrfRejection;

  constructor(reason: SsrfRejection, message: string) {
    super(message);
    this.name = 'SsrfError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const numbers = parts.map((part) => Number(part));
  return numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? numbers : null;
}

/**
 * Cloud metadata and link-local addresses. **Always blocked**, whatever the
 * host policy says — there is no legitimate reason for a chat provider to live
 * at a metadata endpoint, and reaching one is the classic SSRF payoff.
 */
export function isAlwaysBlocked(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number, number, number];
    // 169.254.0.0/16 — link-local, and 169.254.169.254 is the metadata service
    // on AWS, GCP, Azure, DigitalOcean, and Oracle.
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8 — "this host"; 0.0.0.0 reaches every local service.
    if (a === 0) return true;
    return false;
  }

  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  // fe80::/10 link-local, and the IPv6 metadata addresses.
  if (lower.startsWith('fe80:')) return true;
  if (lower === 'fd00:ec2::254') return true;
  if (lower === '::' || lower === '::0') return true;
  // IPv4-mapped IPv6 (::ffff:169.254.169.254) must not slip past the v4 checks.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return isAlwaysBlocked(mapped[1]);

  return false;
}

/** Loopback, RFC1918, CGNAT, and their IPv6 equivalents. */
export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    return false;
  }

  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1') return true; // loopback
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return isPrivateAddress(mapped[1]);

  return false;
}

/** Decides whether a *resolved* address may be connected to. */
export function checkAddress(address: string, policy: HostPolicy): void {
  if (isAlwaysBlocked(address)) {
    throw new SsrfError('blocked-address', 'Address is in a permanently blocked range.');
  }
  if (!policy.allowPrivateHosts && isPrivateAddress(address)) {
    throw new SsrfError('blocked-address', 'Private addresses are not permitted.');
  }
}

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

/**
 * Static checks on the URL itself. Cheap, and safe to run on config load —
 * but **not sufficient on its own**, because the hostname is not resolved here.
 */
export function validateProviderUrl(raw: string, policy: HostPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('hostname', 'Provider URL is not a valid URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfError('scheme', 'Only http and https provider URLs are allowed.');
  }
  // `http://user:pass@host/` can smuggle a different authority past naive
  // parsers, and would leak credentials into logs.
  if (url.username !== '' || url.password !== '') {
    throw new SsrfError('credentials', 'Provider URLs must not contain credentials.');
  }
  if (url.hash !== '') {
    throw new SsrfError('fragment', 'Provider URLs must not contain a fragment.');
  }
  if (url.hostname === '') {
    throw new SsrfError('hostname', 'Provider URL has no hostname.');
  }

  if (policy.hostAllowlist.length > 0) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!policy.hostAllowlist.some((allowed) => allowed.toLowerCase() === host)) {
      throw new SsrfError('allowlist', 'Provider host is not in the allowlist.');
    }
  }

  // A literal IP can be judged immediately; a name needs DNS at request time.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    checkAddress(url.hostname.replace(/^\[|\]$/g, ''), policy);
  }

  return url;
}

// ---------------------------------------------------------------------------
// Request-time resolution and pinning
// ---------------------------------------------------------------------------

/** Injectable so tests can drive rebinding without real DNS. */
export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family }));
};

/**
 * Resolves a hostname and returns only addresses that pass the policy.
 *
 * Every returned address is checked, not just the first: a hostname that
 * resolves to both a public and a metadata address must be rejected outright
 * rather than raced.
 */
export async function resolveAllowedAddresses(
  hostname: string,
  policy: HostPolicy,
  resolver: Resolver = systemResolver
): Promise<{ address: string; family: number }[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');

  if (isIP(bare) !== 0) {
    checkAddress(bare, policy);
    return [{ address: bare, family: isIP(bare) }];
  }

  let results: { address: string; family: number }[];
  try {
    results = await resolver(bare);
  } catch {
    throw new SsrfError('unresolvable', 'Provider hostname could not be resolved.');
  }

  if (results.length === 0) {
    throw new SsrfError('unresolvable', 'Provider hostname resolved to no addresses.');
  }

  // Reject if *any* resolved address is disallowed. Filtering to the good ones
  // would let an attacker mix one valid address in to unblock the rest.
  for (const { address } of results) checkAddress(address, policy);

  return results;
}

/**
 * Builds a dispatcher pinned to pre-validated addresses.
 *
 * The custom `lookup` ignores the system resolver entirely and hands back only
 * addresses that already passed `checkAddress`. That closes the rebinding
 * window between validation and connection: a second DNS answer cannot reach
 * the socket. The hostname stays in the URL, so TLS SNI and certificate
 * verification still work normally.
 */
export function pinnedDispatcher(
  addresses: { address: string; family: number }[],
  connectTimeoutMs: number
): Dispatcher {
  return new Agent({
    connect: {
      timeout: connectTimeoutMs,
      lookup: (_hostname, _options, callback) => {
        if (addresses.length === 0) {
          callback(new Error('no permitted addresses'), [] as never);
          return;
        }
        callback(
          null,
          addresses.map(({ address, family }) => ({ address, family }))
        );
      },
    },
  });
}

/**
 * Validates, resolves, pins, and performs a request.
 *
 * `redirect: 'error'` is not optional: following a redirect would re-resolve a
 * new URL outside every check above, which is the easiest way to defeat SSRF
 * protection entirely.
 *
 * The caller **must** call `release()` when finished with the response. The
 * dispatcher owns the socket, so closing it eagerly here would tear down a
 * streaming body the moment `fetch` resolved — long before the caller has read
 * any of it.
 */
export interface SafeResponse {
  /**
   * undici's `Response`, not the global one.
   *
   * The dispatcher and the fetch implementation must come from the *same*
   * undici copy: Node's global `fetch` is bound to its own bundled undici, and
   * handing it a dispatcher from the installed package fails at dispatch time
   * with an internal contract mismatch. The shapes we use — status, headers,
   * `json()`, and a web `ReadableStream` body — are identical.
   */
  response: UndiciResponse;
  release: () => void;
}

export async function safeFetch(
  url: URL,
  init: Parameters<typeof undiciFetch>[1],
  options: { policy: HostPolicy; resolver?: Resolver; connectTimeoutMs?: number }
): Promise<SafeResponse> {
  const { policy, resolver = systemResolver, connectTimeoutMs = 10_000 } = options;

  validateProviderUrl(url.toString(), policy);
  const addresses = await resolveAllowedAddresses(url.hostname, policy, resolver);

  const dispatcher = pinnedDispatcher(addresses, connectTimeoutMs);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    void dispatcher.close().catch(() => undefined);
  };

  try {
    const response = await undiciFetch(url, {
      ...init,
      redirect: 'error',
      // This is what pins the socket to the validated address.
      dispatcher,
    });

    return { response, release };
  } catch (err) {
    release();
    throw err;
  }
}

/** Maps an SSRF rejection to the canonical error contract, leaking no detail. */
export function toAppError(err: unknown): AppError {
  if (err instanceof SsrfError) {
    return new AppError('ENDPOINT_NOT_ALLOWED', 'That provider endpoint is not permitted.');
  }
  return AppError.internal('Provider request failed.');
}
