import { resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  DATA_DIR: z.string().min(1).default('./data'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // Provider (Phase 2). A single llama.cpp endpoint; multi-provider is Phase 5.
  LLAMA_BASE_URL: z.url().default('http://127.0.0.1:8080'),
  LLAMA_API_KEY: z.string().min(1).optional(),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  DEFAULT_CONTEXT_TOKENS: z.coerce.number().int().min(512).max(2_000_000).default(8_192),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(1_000_000).default(2_048),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Absolute path. The persistent boundary (contracts §1). Nothing writes to it in Phase 1. */
  dataDir: string;
  logLevel: LogLevel;
  isProduction: boolean;
  provider: ProviderConfig;
}

export interface ProviderConfig {
  /** Base URL with any trailing slash removed, so path joins are unambiguous. */
  baseUrl: string;
  /**
   * Bearer token for the upstream server. Secret: it is sent upstream only and
   * never reaches a response, a log, or the browser (INV-04).
   */
  apiKey: string | undefined;
  timeoutMs: number;
  /** Used when the provider does not disclose a model's context length. */
  defaultContextTokens: number;
  maxOutputTokens: number;
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

  const {
    NODE_ENV,
    PORT,
    DATA_DIR,
    LOG_LEVEL,
    LLAMA_BASE_URL,
    LLAMA_API_KEY,
    PROVIDER_TIMEOUT_MS,
    DEFAULT_CONTEXT_TOKENS,
    MAX_OUTPUT_TOKENS,
  } = parsed.data;

  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    dataDir: resolve(DATA_DIR),
    logLevel: LOG_LEVEL,
    isProduction: NODE_ENV === 'production',
    provider: {
      baseUrl: LLAMA_BASE_URL.replace(/\/+$/, ''),
      apiKey: LLAMA_API_KEY,
      timeoutMs: PROVIDER_TIMEOUT_MS,
      defaultContextTokens: DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}

/** Maximum accepted JSON body size. Anything larger becomes `PAYLOAD_TOO_LARGE`. */
export const JSON_BODY_LIMIT = '100kb';
