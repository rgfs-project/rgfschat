import { resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  DATA_DIR: z.string().min(1).default('./data'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // Temporary identity (Phase 3). Replaced by real sessions in Phase 4. This is
  // the ONLY source of the user-directory segment until then (INV-14); it is
  // never read from a header, query, body, or route param.
  LOCAL_USER_ID: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'must be a canonical lowercase UUID'
    )
    .default('0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'),

  // Auth (Phase 4).
  REGISTRATION_MODE: z.enum(['closed', 'open']).default('closed'),
  SESSION_ABSOLUTE_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(30 * 24 * 60 * 60 * 1000),
  SESSION_IDLE_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(7 * 24 * 60 * 60 * 1000),

  // Streaming lifecycle (Phase 6).
  //
  // A checkpoint is written on every state transition and at most this often
  // while streaming, so a long generation costs a bounded number of writes
  // rather than one per token.
  GENERATION_CHECKPOINT_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  // Replay window. 2000 events is roughly a long reply's worth of tokens at one
  // event per chunk, so an ordinary reconnect replays rather than resyncs,
  // while the memory held per generation stays bounded and small.
  SSE_REPLAY_EVENTS: z.coerce.number().int().min(1).max(100_000).default(2_000),
  GENERATION_RETENTION_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(10 * 60 * 1000),

  // SSRF host policy (Phase 5). Private hosts are allowed by default because a
  // local llama.cpp is the primary use case; metadata ranges are blocked
  // regardless of this setting.
  ALLOW_PRIVATE_PROVIDER_HOSTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PROVIDER_HOST_ALLOWLIST: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim())
        .filter((host) => host !== '')
    ),

  // Provider (Phase 2). A single llama.cpp endpoint; multi-provider is Phase 5.
  LLAMA_BASE_URL: z.url().default('http://127.0.0.1:8080'),
  LLAMA_API_KEY: z.string().min(1).optional(),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  DEFAULT_CONTEXT_TOKENS: z.coerce.number().int().min(512).max(2_000_000).default(8_192),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(1_000_000).default(2_048),

  /*
   * Attachments (Phase 11).
   *
   * The per-file limit is deliberately well under what a model can actually be
   * sent: an image is re-encoded as base64 into the prompt, so the bytes cost
   * roughly a third more again, and the context budget runs out long before a
   * disk does.
   */
  ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  ATTACHMENT_MAX_TOTAL_BYTES_PER_USER: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024 * 1024)
    .default(512 * 1024 * 1024),
  /** How long an upload nobody referenced survives before it is collected. */
  ATTACHMENT_PENDING_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1000)
    .default(24 * 60 * 60 * 1000),
  /** Characters of a text attachment inlined into a prompt before truncation. */
  ATTACHMENT_MAX_INLINE_CHARS: z.coerce.number().int().min(1_000).max(2_000_000).default(100_000),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Absolute path. The persistent boundary (contracts §1). Nothing writes to it in Phase 1. */
  dataDir: string;
  logLevel: LogLevel;
  isProduction: boolean;
  /** Canonical lowercase UUID. Used only by `user:create --adopt-local-data`. */
  localUserId: string;
  auth: AuthConfig;
  /** Outbound SSRF policy, applied on config load and every request (INV-19). */
  hostPolicy: HostPolicy;
  streaming: StreamingConfig;
  provider: ProviderConfig;
  attachments: AttachmentConfig;
}

/** Phase 11. Grouped like the others, so one thing owns the whole subject. */
export interface AttachmentConfig {
  maxBytes: number;
  maxTotalBytesPerUser: number;
  pendingTtlMs: number;
  /** Characters, not bytes: what is counted is what goes into a prompt. */
  maxInlineChars: number;
}

export interface StreamingConfig {
  checkpointMs: number;
  replayEvents: number;
  retentionMs: number;
}

export interface HostPolicy {
  allowPrivateHosts: boolean;
  hostAllowlist: string[];
}

export interface AuthConfig {
  /** `closed` (default) rejects `POST /api/auth/register` with REGISTRATION_CLOSED. */
  registrationMode: 'closed' | 'open';
  /** Never extended; a session dies this long after login whatever happens. */
  absoluteTtlMs: number;
  /** Slides forward on each authenticated request. */
  idleTtlMs: number;
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
    LOCAL_USER_ID,
    REGISTRATION_MODE,
    SESSION_ABSOLUTE_TTL_MS,
    SESSION_IDLE_TTL_MS,
    GENERATION_CHECKPOINT_MS,
    SSE_REPLAY_EVENTS,
    GENERATION_RETENTION_MS,
    ALLOW_PRIVATE_PROVIDER_HOSTS,
    PROVIDER_HOST_ALLOWLIST,
    LLAMA_BASE_URL,
    LLAMA_API_KEY,
    PROVIDER_TIMEOUT_MS,
    DEFAULT_CONTEXT_TOKENS,
    MAX_OUTPUT_TOKENS,
    ATTACHMENT_MAX_BYTES,
    ATTACHMENT_MAX_TOTAL_BYTES_PER_USER,
    ATTACHMENT_PENDING_TTL_MS,
    ATTACHMENT_MAX_INLINE_CHARS,
  } = parsed.data;

  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    dataDir: resolve(DATA_DIR),
    logLevel: LOG_LEVEL,
    isProduction: NODE_ENV === 'production',
    localUserId: LOCAL_USER_ID,
    auth: {
      registrationMode: REGISTRATION_MODE,
      absoluteTtlMs: SESSION_ABSOLUTE_TTL_MS,
      idleTtlMs: SESSION_IDLE_TTL_MS,
    },
    attachments: {
      maxBytes: ATTACHMENT_MAX_BYTES,
      maxTotalBytesPerUser: ATTACHMENT_MAX_TOTAL_BYTES_PER_USER,
      pendingTtlMs: ATTACHMENT_PENDING_TTL_MS,
      maxInlineChars: ATTACHMENT_MAX_INLINE_CHARS,
    },
    streaming: {
      checkpointMs: GENERATION_CHECKPOINT_MS,
      replayEvents: SSE_REPLAY_EVENTS,
      retentionMs: GENERATION_RETENTION_MS,
    },
    hostPolicy: {
      allowPrivateHosts: ALLOW_PRIVATE_PROVIDER_HOSTS,
      hostAllowlist: PROVIDER_HOST_ALLOWLIST,
    },
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
