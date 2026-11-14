import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getImpersonatedClientIdFromToken,
  mintImpersonationToken,
} from '@/lib/impersonation';

describe('impersonation token staff binding', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', 'test-impersonation-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a token only for the staff user who minted it', () => {
    const token = mintImpersonationToken(42, 7);

    expect(getImpersonatedClientIdFromToken(token, 'admin', 7)).toBe(42);
    expect(getImpersonatedClientIdFromToken(token, 'employee', 8)).toBeNull();
  });

  it('does not let a different staff role reuse another staff member token', () => {
    const token = mintImpersonationToken(42, 7);

    expect(getImpersonatedClientIdFromToken(token, 'employee', 7)).toBe(42);
    expect(getImpersonatedClientIdFromToken(token, 'admin', 8)).toBeNull();
    expect(getImpersonatedClientIdFromToken(token, 'editor', 8)).toBeNull();
  });

  it('rejects non-staff callers even when the token owner id matches', () => {
    const token = mintImpersonationToken(42, 7);

    expect(getImpersonatedClientIdFromToken(token, 'client', 7)).toBeNull();
    expect(getImpersonatedClientIdFromToken(token, null, 7)).toBeNull();
  });

  it('rejects missing, invalid, or non-positive staff identities', () => {
    const token = mintImpersonationToken(42, 7);

    expect(getImpersonatedClientIdFromToken(null, 'admin', 7)).toBeNull();
    expect(getImpersonatedClientIdFromToken(token, 'admin', 0)).toBeNull();
    expect(getImpersonatedClientIdFromToken(token, 'admin', Number.NaN)).toBeNull();
  });
});
