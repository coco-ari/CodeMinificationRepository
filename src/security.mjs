import { randomBytes, scrypt as derive, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
export const randomSecret = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password, encoded) {
  const [salt, expected] = encoded.split(':');
  const actual = await scrypt(password, salt, 64);
  return equal(actual.toString('hex'), expected);
}
export function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
}
export function decrypt(value, key) {
  const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new HttpError(400, `${label}不能为空、超长或包含控制字符`);
  }
  return value.trim();
}
export class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.entries = new Map(); }
  take(key) {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
    const entry = this.entries.get(key) || { count: 0, until: now + this.windowMs };
    if (entry.count >= this.limit || (!this.entries.has(key) && this.entries.size >= 10000)) {
      throw new HttpError(429, '请求过于频繁，请稍后重试');
    }
    entry.count++;
    this.entries.set(key, entry);
  }
}
