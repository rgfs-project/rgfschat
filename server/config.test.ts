import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('config', () => {
  it('applies documented defaults when the environment is empty', () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3001);
    expect(config.logLevel).toBe('info');
    expect(config.isProduction).toBe(false);
  });

  it('resolves DATA_DIR to an absolute path', () => {
    const config = loadConfig({ DATA_DIR: './data' });

    expect(isAbsolute(config.dataDir)).toBe(true);
  });

  it('coerces PORT and rejects out-of-range values', () => {
    expect(loadConfig({ PORT: '8080' }).port).toBe(8080);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid environment configuration/);
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/Invalid environment configuration/);
  });

  it('fails fast on an unknown LOG_LEVEL and names the offending key', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('validates LOCAL_USER_ID as a canonical lowercase UUID', () => {
    // It is the sole source of the user-directory segment until Phase 4
    // (INV-14), so an invalid value must stop the process at boot rather than
    // reach path construction.
    expect(loadConfig({}).localUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadConfig({ LOCAL_USER_ID: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' }).localUserId).toBe(
      '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'
    );

    for (const invalid of [
      'not-a-uuid',
      '0A1B2C3D-4E5F-4A6B-8C9D-0E1F2A3B4C5D',
      '../../etc/passwd',
      '',
      '0a1b2c3d4e5f4a6b8c9d0e1f2a3b4c5d',
    ]) {
      expect(() => loadConfig({ LOCAL_USER_ID: invalid })).toThrow(/LOCAL_USER_ID/);
    }
  });

  it('never echoes the offending value in the error message', () => {
    // A bad value could be a mistyped secret; only the key is safe to print.
    expect(() => loadConfig({ NODE_ENV: 'sk-live-supersecret' })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('sk-live-supersecret') as unknown as string,
      })
    );
  });
});
