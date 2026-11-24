import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** Parses SECRETS_KEY: 32 random bytes, base64 or hex encoded. */
export function parseSecretsKey(value: string | undefined): Buffer | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (key.length !== 32) {
    throw new Error('SECRETS_KEY must be 32 random bytes, encoded as base64 or 64 hex characters.');
  }

  return key;
}

/** AES-256-GCM. The result is `v1:<iv>:<tag>:<ciphertext>`, each part base64. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split(':');

  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Unsupported secret format');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
