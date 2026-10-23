import type { BinaryLike, CipherKey } from 'node:crypto'

export function randomSecret(): string
export function digest(value: BinaryLike): string
export function equal(left: unknown, right: unknown): boolean
export function hashPassword(password: BinaryLike): Promise<string>
export function checkPassword(password: BinaryLike, encoded: string): Promise<boolean>
export function encrypt(value: string, key: CipherKey): string
export function decrypt(value: string, key: CipherKey): string
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string)
}
export function requireText(value: unknown, label: string, max?: number): string
export class RateLimiter {
  limit: number
  windowMs: number
  entries: Map<string, { count: number; until: number }>
  constructor(limit: number, windowMs: number)
  take(key: string): void
}
