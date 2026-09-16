import { describe, expect, it } from 'vitest';
import { checkAddress, isAlwaysBlocked, isPrivateAddress } from './ssrf.ts';

/**
 * An IPv4 address wearing an IPv6 costume.
 *
 * `::ffff:169.254.169.254` is the cloud metadata service — the single most
 * valuable SSRF target there is, which is why it is permanently blocked in
 * every form the filter knew about. The form it did not know about is the one
 * the platform actually produces: WHATWG URL parsing rewrites the dotted tail
 * into hex, so `http://[::ffff:169.254.169.254]/` arrives at the filter as
 * `::ffff:a9fe:a9fe` and matched nothing at all.
 *
 * Same address, same host, same request — spelled the way the URL parser
 * spells it rather than the way the test suite did.
 */

const METADATA = '::ffff:a9fe:a9fe'; // 169.254.169.254
const LOOPBACK = '::ffff:7f00:1'; // 127.0.0.1
const RFC1918 = '::ffff:c0a8:1'; // 192.168.0.1

describe('IPv4-mapped IPv6, as the URL parser writes it', () => {
  it('blocks the metadata address in hex form', () => {
    expect(isAlwaysBlocked(METADATA)).toBe(true);
  });

  it('blocks it with the brackets a URL hostname keeps', () => {
    expect(isAlwaysBlocked(`[${METADATA}]`)).toBe(true);
  });

  it('still blocks the dotted form', () => {
    expect(isAlwaysBlocked('::ffff:169.254.169.254')).toBe(true);
  });

  it('recognises mapped loopback and RFC1918 as private', () => {
    expect(isPrivateAddress(LOOPBACK)).toBe(true);
    expect(isPrivateAddress(RFC1918)).toBe(true);
  });

  it('refuses a mapped private address when private hosts are disallowed', () => {
    const policy = { allowPrivateHosts: false, hostAllowlist: [] };
    expect(() => checkAddress(LOOPBACK, policy)).toThrow();
    expect(() => checkAddress(RFC1918, policy)).toThrow();
  });

  it('refuses mapped metadata even when private hosts are allowed', () => {
    expect(() => checkAddress(METADATA, { allowPrivateHosts: true, hostAllowlist: [] })).toThrow();
  });

  /**
   * The deprecated IPv4-compatible form is the same trick without the `ffff`,
   * and reaches the same host.
   */
  it('blocks the IPv4-compatible form too', () => {
    expect(isAlwaysBlocked('::a9fe:a9fe')).toBe(true);
    expect(isPrivateAddress('::7f00:1')).toBe(true);
  });

  /** A genuine public address must still be reachable. */
  it('leaves an ordinary address alone', () => {
    expect(isAlwaysBlocked('::ffff:5db8:d822')).toBe(false); // 93.184.216.34
    expect(isPrivateAddress('::ffff:5db8:d822')).toBe(false);
    expect(isAlwaysBlocked('2606:2800:220:1::')).toBe(false);
  });
});
