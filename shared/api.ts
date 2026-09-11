/**
 * Response DTOs shared by client and server.
 *
 * Every API response is built from an explicit DTO; internal records are never
 * spread into responses (INV-03).
 */

/** `GET /api/health`. Public: no environment values, paths, or dependency versions. */
export interface HealthDto {
  status: 'ok';
  version: string;
}
