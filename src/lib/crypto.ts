import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

export class SecretEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretEncryptionError';
  }
}

/** Safe for startup diagnostics: never includes the configured key. */
export function getTenantEncryptionKeyError(): string | null {
  const key = process.env.TENANT_ENCRYPTION_KEY;
  if (!key) return 'TENANT_ENCRYPTION_KEY is missing. Token-bearing Hugging Face launches require a persistent encryption key; public launches without tokens remain available.';
  if (!/^[a-fA-F0-9]{64}$/.test(key)) return 'TENANT_ENCRYPTION_KEY is invalid: expected exactly 64 hexadecimal digits (32 bytes). Token-bearing Hugging Face launches are unavailable.';
  return null;
}

function getKey(): Buffer {
  const error = getTenantEncryptionKeyError();
  if (error) throw new SecretEncryptionError(error);
  return Buffer.from(process.env.TENANT_ENCRYPTION_KEY!, 'hex');
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(ciphertext: string): string {
  // Buffer.from(hex) silently truncates malformed input; validate the complete envelope first.
  if (!/^[a-fA-F0-9]{32}:[a-fA-F0-9]{32}:(?:[a-fA-F0-9]{2})*$/.test(ciphertext)) {
    throw new SecretEncryptionError('Stored credential has an invalid encrypted format.');
  }
  const key = getKey();
  try {
    const [ivHex, tagHex, encryptedHex] = ciphertext.split(':');
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretEncryptionError('Stored credential could not be decrypted with the configured key.');
  }
}
