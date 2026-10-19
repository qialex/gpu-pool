export function redisRest(): { url: string; token: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/$/, "")
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required")
  return { url, token }
}

/** Account-level read token for monthly command stats. Empty when the UI should skip usage. */
export function upstashReadToken(): string | null {
  return process.env.UPSTASH_GLOBAL_READ_ONLY_TOKEN?.trim() || null
}

/** Account email. The Upstash developer API signs in as this email plus the read-only key. */
export function upstashEmail(): string | null {
  return process.env.UPSTASH_EMAIL?.trim() || null
}

/** Free-plan command cap, used when the account API does not report a limit. */
export function monthlyCommandQuota(): number {
  const n = Number(process.env.UPSTASH_MONTHLY_COMMAND_QUOTA)
  return Number.isFinite(n) && n > 0 ? n : 500_000
}

export function vastApiKey(): string | null {
  const key = process.env.VAST_API_KEY?.trim()
  return key || null
}

export function requireVastApiKey(): string {
  const key = vastApiKey()
  if (!key) throw new Error("VAST_API_KEY is not set")
  return key
}

export function resolveToken(): string | null {
  const token = process.env.GPU_RESOLVE_TOKEN?.trim()
  return token || null
}

export function port(): number {
  const raw = Number(process.env.PORT ?? 8080)
  return Number.isFinite(raw) && raw > 0 ? raw : 8080
}
