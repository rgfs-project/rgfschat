import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_POLICY,
  isAlwaysBlocked,
  isPrivateAddress,
  resolveAllowedAddresses,
  safeFetch,
  SsrfError,
  validateProviderUrl,
  type HostPolicy,
  type Resolver,
} from './ssrf.ts';

const OPEN: HostPolicy = { allowPrivateHosts: true, hostAllowlist: [] };
const STRICT: HostPolicy = { allowPrivateHosts: false, hostAllowlist: [] };

let servers: Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers = [];
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SsrfError) return err.reason;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('address classification', () => {
  it('always blocks cloud metadata and link-local, whatever the policy', () => {
    for (const address of [
      '169.254.169.254', // AWS/GCP/Azure/DO/Oracle metadata
      '169.254.0.1',
      '0.0.0.0',
      '0.1.2.3',
      'fd00:ec2::254', // AWS IPv6 metadata
      'fe80::1', // IPv6 link-local
      '::',
      '::ffff:169.254.169.254', // IPv4-mapped must not slip through
    ]) {
      expect(isAlwaysBlocked(address), address).toBe(true);
    }
  });

  it('recognises private ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('does not treat ordinary public addresses as private or blocked', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
      expect(isAlwaysBlocked(address), address).toBe(false);
    }
  });

  it('does not mistake 172.15 or 172.32 for RFC1918', () => {
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });
});

describe('URL shape validation', () => {
  it('accepts a plain http or https URL', () => {
    expect(validateProviderUrl('http://127.0.0.1:8080', OPEN).hostname).toBe('127.0.0.1');
    expect(validateProviderUrl('https://api.example.com/v1', OPEN).protocol).toBe('https:');
  });

  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['ftp://example.com', 'scheme'],
    ['gopher://example.com', 'scheme'],
    ['data:text/plain,hello', 'scheme'],
    ['http://user:pass@example.com', 'credentials'],
    ['http://user@example.com', 'credentials'],
    ['http://example.com/#frag', 'fragment'],
    ['not a url', 'hostname'],
  ])('rejects %s as %s', (raw, expected) => {
    expect(reason(() => validateProviderUrl(raw, OPEN))).toBe(expected);
  });

  it('rejects a literal metadata address immediately, even with private hosts allowed', () => {
    expect(
      reason(() => validateProviderUrl('http://169.254.169.254/latest/meta-data/', OPEN))
    ).toBe('blocked-address');
  });

  it('rejects private literals only when the policy forbids them', () => {
    expect(() => validateProviderUrl('http://127.0.0.1:8080', OPEN)).not.toThrow();
    expect(reason(() => validateProviderUrl('http://127.0.0.1:8080', STRICT))).toBe(
      'blocked-address'
    );
  });

  it('enforces a host allowlist when one is configured', () => {
    const policy: HostPolicy = { allowPrivateHosts: true, hostAllowlist: ['llama.internal'] };

    expect(() => validateProviderUrl('http://llama.internal:8080', policy)).not.toThrow();
    expect(() => validateProviderUrl('http://LLAMA.INTERNAL:8080', policy)).not.toThrow();
    expect(reason(() => validateProviderUrl('http://evil.example', policy))).toBe('allowlist');
  });

  it('the default policy allows private hosts, since local llama.cpp is the point', () => {
    expect(DEFAULT_HOST_POLICY.allowPrivateHosts).toBe(true);
    expect(() =>
      validateProviderUrl('http://192.168.1.50:8081', DEFAULT_HOST_POLICY)
    ).not.toThrow();
  });
});

describe('DNS resolution', () => {
  const resolverFor = (addresses: string[]): Resolver => {
    return () => Promise.resolve(addresses.map((address) => ({ address, family: 4 })));
  };

  it('rejects when any resolved address is blocked, not just the first', async () => {
    // Mixing one good address in must not unblock the bad one.
    await expect(
      resolveAllowedAddresses('mixed.example', OPEN, resolverFor(['8.8.8.8', '169.254.169.254']))
    ).rejects.toMatchObject({ reason: 'blocked-address' });

    await expect(
      resolveAllowedAddresses('mixed.example', OPEN, resolverFor(['169.254.169.254', '8.8.8.8']))
    ).rejects.toMatchObject({ reason: 'blocked-address' });
  });

  it('rejects a hostname that resolves to nothing', async () => {
    await expect(
      resolveAllowedAddresses('empty.example', OPEN, resolverFor([]))
    ).rejects.toMatchObject({ reason: 'unresolvable' });
  });

  it('rejects when the resolver fails', async () => {
    const failing: Resolver = () => Promise.reject(new Error('ENOTFOUND'));

    await expect(resolveAllowedAddresses('nope.example', OPEN, failing)).rejects.toMatchObject({
      reason: 'unresolvable',
    });
  });

  it('passes through a literal IP without consulting DNS', async () => {
    let called = false;
    const resolver: Resolver = () => {
      called = true;
      return Promise.resolve([]);
    };

    const addresses = await resolveAllowedAddresses('127.0.0.1', OPEN, resolver);

    expect(addresses).toEqual([{ address: '127.0.0.1', family: 4 }]);
    expect(called).toBe(false);
  });
});

describe('INV-19: request-time protection', () => {
  it('reaches a permitted host and returns its response', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });

    const { response, release } = await safeFetch(
      new URL(`http://127.0.0.1:${port}/v1/models`),
      {},
      { policy: OPEN }
    );
    const body = (await response.json()) as { ok: boolean };
    release();

    expect(body.ok).toBe(true);
  });

  it('defeats DNS rebinding by pinning the connection to the checked address', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      res.end('reached');
    });

    // A resolver that answers safely once, then flips to the metadata address —
    // exactly the rebinding attack. The pin means the second answer is never used.
    let call = 0;
    const rebinding: Resolver = () => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }]
      );
    };

    const { response, release } = await safeFetch(
      new URL(`http://pinned.example:${port}/`),
      {},
      { policy: OPEN, resolver: rebinding }
    );
    const text = await response.text();
    release();

    expect(text).toBe('reached');
    // The socket used the validated address; DNS was consulted only by us.
    expect(call).toBe(1);
  });

  it('refuses a hostname that resolves to a metadata address', async () => {
    const resolver: Resolver = () => Promise.resolve([{ address: '169.254.169.254', family: 4 }]);

    await expect(
      safeFetch(new URL('http://metadata.example/'), {}, { policy: OPEN, resolver })
    ).rejects.toMatchObject({ reason: 'blocked-address' });
  });

  it('does not follow a redirect, even to a permitted host', async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${target}/` });
      res.end();
    });

    // A 302 to 169.254.169.254 would otherwise bypass every check above, so
    // redirects are refused outright rather than re-validated.
    await expect(
      safeFetch(new URL(`http://127.0.0.1:${redirector}/`), {}, { policy: OPEN })
    ).rejects.toThrow();
  });

  it('refuses a URL carrying credentials before any connection is made', async () => {
    let connected = false;
    const port = await listen((_req, res) => {
      connected = true;
      res.writeHead(200);
      res.end('ok');
    });

    await expect(
      safeFetch(new URL(`http://user:pass@127.0.0.1:${port}/`), {}, { policy: OPEN })
    ).rejects.toMatchObject({ reason: 'credentials' });
    expect(connected).toBe(false);
  });

  it('refuses a private address when the policy forbids it, without connecting', async () => {
    let connected = false;
    const port = await listen((_req, res) => {
      connected = true;
      res.writeHead(200);
      res.end('ok');
    });

    await expect(
      safeFetch(new URL(`http://127.0.0.1:${port}/`), {}, { policy: STRICT })
    ).rejects.toMatchObject({ reason: 'blocked-address' });
    expect(connected).toBe(false);
  });

  it('keeps a streamed body readable after safeFetch resolves', async () => {
    // The dispatcher owns the socket; releasing it too eagerly would truncate
    // an SSE stream the moment fetch() returned.
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 40);
    });

    const { response, release } = await safeFetch(
      new URL(`http://127.0.0.1:${port}/stream`),
      {},
      { policy: OPEN }
    );

    let received = '';
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    release();

    expect(received).toContain('data: one');
    expect(received).toContain('data: two');
  });
});
