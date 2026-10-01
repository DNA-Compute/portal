import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { encrypt, decrypt, getTenantEncryptionKeyError, SecretEncryptionError } from '@/lib/crypto';

beforeEach(() => vi.stubEnv('TENANT_ENCRYPTION_KEY', 'a'.repeat(64)));
afterEach(() => vi.unstubAllEnvs());

describe('crypto', () => {
  it('encrypts and decrypts a string', () => {
    const secret = 'sk_test_abc123';
    const encrypted = encrypt(secret);
    expect(encrypted).not.toBe(secret);
    expect(encrypted).toContain(':');
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('produces different ciphertexts for same input', () => {
    const secret = 'sk_test_abc123';
    const a = encrypt(secret);
    const b = encrypt(secret);
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encrypt('secret');
    const tampered = encrypted.slice(0, -2) + 'xx';
    expect(() => decrypt(tampered)).toThrow();
  });

  it.each(['', 'a'.repeat(63), 'g'.repeat(64)])('rejects unavailable keys without exposing their value', (key) => {
    vi.stubEnv('TENANT_ENCRYPTION_KEY', key);
    expect(getTenantEncryptionKeyError()).not.toBeNull();
    expect(() => encrypt('hf_privateToken')).toThrow(SecretEncryptionError);
  });

  it('rejects valid-format ciphertext encrypted with a different key', () => {
    const encrypted = encrypt('hf_privateToken');
    vi.stubEnv('TENANT_ENCRYPTION_KEY', 'b'.repeat(64));
    expect(() => decrypt(encrypted)).toThrow(SecretEncryptionError);
  });

  it.each(['hf_privateToken', '00:11:22', '0'.repeat(32) + ':' + '0'.repeat(32) + ':xx'])('rejects unrecognized ciphertext before decryption', (value) => {
    expect(() => decrypt(value)).toThrow(SecretEncryptionError);
  });
});
