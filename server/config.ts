import { resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  DATA_DIR: z.string().min(1).default('./data'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Absolute path. The persistent boundary (contracts §1). Nothing writes to it in Phase 1. */
  dataDir: string;
  logLevel: LogLevel;
  isProduction: boolean;
}

/**
 * Validates the environment once and fails fast with a readable message.
 * Never logs values, so a malformed secret can't leak through a boot error.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const { NODE_ENV, PORT, DATA_DIR, LOG_LEVEL } = parsed.data;

  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    dataDir: resolve(DATA_DIR),
    logLevel: LOG_LEVEL,
    isProduction: NODE_ENV === 'production',
  };
}

/** Maximum accepted JSON body size. Anything larger becomes `PAYLOAD_TOO_LARGE`. */
export const JSON_BODY_LIMIT = '100kb';
