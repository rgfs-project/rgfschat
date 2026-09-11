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

  it('never echoes the offending value in the error message', () => {
    // A bad value could be a mistyped secret; only the key is safe to print.
    expect(() => loadConfig({ NODE_ENV: 'sk-live-supersecret' })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('sk-live-supersecret') as unknown as string,
      })
    );
  });
});
