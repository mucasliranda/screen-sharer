import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

// Sem 0/1/l/o para o slug ser ditável por telefone sem ambiguidade.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newSlug(len = 10): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]{6,32}$/.test(slug);
}

function roomSecret(): string {
  const s = process.env.ROOM_SECRET;
  if (!s || s.length < 8) {
    throw new Error('ROOM_SECRET ausente ou curto demais. Veja o .env.example.');
  }
  return s;
}

/**
 * A "posse" da sala é derivada, não armazenada: hostKey = HMAC(slug).
 * Isso mantém o MVP sem banco de dados e funciona em serverless com
 * múltiplas instâncias. A troco de não podermos revogar uma chave
 * individual sem trocar o ROOM_SECRET inteiro.
 */
export function hostKeyFor(slug: string): string {
  return createHmac('sha256', roomSecret()).update(`host:${slug}`).digest('hex').slice(0, 32);
}

export function isValidHostKey(slug: string, key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  const expected = Buffer.from(hostKeyFor(slug), 'utf8');
  const given = Buffer.from(key, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** O nome é rótulo de exibição, nunca identidade. Trate como hostil. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Anônimo';
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/g, '')
    .trim()
    .slice(0, 32);
  return clean.length > 0 ? clean : 'Anônimo';
}
