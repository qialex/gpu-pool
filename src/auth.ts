import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { createSession, deleteOperators, deleteSession, sessionExists } from "./db.js"

const COOKIE = "gpu_pool_session"
const SESSION_MS = 7 * 24 * 60 * 60 * 1000

/** Drops any operator record left in Redis. The login hash lives only in the environment. */
export async function ensureOperator(): Promise<void> {
  await deleteOperators()
  const username = process.env.OPERATOR_USER?.trim()
  const password = process.env.OPERATOR_PASSWORD ?? ""
  if (!username || !password) console.warn("[auth] set OPERATOR_USER and OPERATOR_PASSWORD")
}

export async function login(username: string, password: string): Promise<string | null> {
  const expectedUser = process.env.OPERATOR_USER?.trim() ?? ""
  const expectedHash = process.env.OPERATOR_PASSWORD ?? ""
  if (!expectedUser || !expectedHash || username !== expectedUser || !verifyPassword(password, expectedHash)) return null
  const token = randomBytes(32).toString("hex")
  await createSession(token, SESSION_MS / 1000)
  return token
}

export async function operatorIdFromRequest(cookieHeader: string | undefined): Promise<number | null> {
  const token = readCookie(cookieHeader, COOKIE)
  if (!token || !(await sessionExists(token))) return null
  return 1
}

export async function logout(cookieHeader: string | undefined): Promise<void> {
  const token = readCookie(cookieHeader, COOKIE)
  if (token) await deleteSession(token)
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const actual = scryptSync(password, salt, 32)
  const expected = Buffer.from(hash, "hex")
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=") || null
  }
  return null
}
