/**
 * Application version reported by `GET /api/health`.
 *
 * Kept as a literal so the bundled server needs no runtime access to
 * `package.json`. A test asserts the two stay in sync.
 */
export const APP_VERSION = '0.1.0';
