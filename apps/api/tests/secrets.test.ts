import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseSecretsKey } from '../src/secrets.js';

describe('secrets', () => {
  const key = randomBytes(32);

  it('round-trips and never repeats a ciphertext', () => {
    const first = encryptSecret('hpk_secret', key);
    const second = encryptSecret('hpk_secret', key);

    expect(first).not.toContain('hpk_secret');
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe('hpk_secret');
  });

  it('rejects the wrong key and tampered data', () => {
    const encrypted = encryptSecret('hpk_secret', key);
    const parts = encrypted.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');

    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
    expect(() => decryptSecret(parts.join(':'), key)).toThrow();
    expect(() => decryptSecret('not-a-secret', key)).toThrow();
  });

  it('parses base64 and hex keys and rejects bad lengths', () => {
    expect(parseSecretsKey(undefined)).toBeNull();
    expect(parseSecretsKey(key.toString('base64'))?.equals(key)).toBe(true);
    expect(parseSecretsKey(key.toString('hex'))?.equals(key)).toBe(true);
    expect(() => parseSecretsKey('short')).toThrow(/32 random bytes/);
  });
});
