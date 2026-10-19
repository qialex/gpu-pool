import { monthlyCommandQuota, redisRest, upstashEmail, upstashReadToken } from "./config.js"

export type UpstashUsage = {
  requests: number | null
  quota: number | null
  plan: string | null
  note: string | null
}

const API = "https://api.upstash.com/v2"

/** Monthly commands from the account API, matched to this database by its REST host. */
export async function upstashUsage(): Promise<UpstashUsage> {
  const token = upstashReadToken()
  if (!token) return { requests: null, quota: null, plan: null, note: "Read-only account token is not set." }
  if (!accountLogin(token)) {
    return {
      requests: null,
      quota: null,
      plan: null,
      note: "Add UPSTASH_EMAIL, the email you use for the Upstash console. The read-only key signs in with that email.",
    }
  }
  try {
    const listed = await accountGet(token, "/redis/databases")
    const databases = Array.isArray(listed) ? listed : Array.isArray(listed.databases) ? listed.databases as Array<Record<string, unknown>> : null
    if (!databases) return { requests: null, quota: null, plan: null, note: "Upstash did not return a database list." }
    const host = new URL(redisRest().url).host
    const found = databases.find(row => databaseMatches(row, host))
    const id = found?.database_id == null ? null : String(found.database_id)
    if (!id) return { requests: null, quota: null, plan: null, note: "This Redis database was not in the account list." }
    const [stats, info] = await Promise.all([
      accountGet(token, `/redis/stats/${id}`),
      accountGet(token, `/redis/database/${id}?credentials=hide`),
    ])
    const statsRow = asRecord(stats)
    const infoRow = asRecord(info)
    const requests = numberField(statsRow, "total_monthly_requests")
    const plan = typeof infoRow?.type === "string" ? infoRow.type : null
    const limit = numberField(infoRow, "db_request_limit")
    const quota = limit != null && limit > 0 ? limit : plan === "free" ? monthlyCommandQuota() : null
    return { requests, quota, plan, note: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstash usage failed"
    return { requests: null, quota: null, plan: null, note: message }
  }
}

function databaseMatches(row: Record<string, unknown>, host: string): boolean {
  const endpoint = typeof row.endpoint === "string" ? row.endpoint : ""
  const rest = typeof row.rest_endpoint === "string" ? row.rest_endpoint : ""
  if (endpoint && (host === endpoint || host.startsWith(`${endpoint}.`) || endpoint.includes(host))) return true
  return rest.includes(host)
}

function accountLogin(token: string): { email: string; key: string } | null {
  const configured = upstashEmail()
  if (configured) return { email: configured, key: token }
  const split = token.indexOf(":")
  const email = split > 0 ? token.slice(0, split) : ""
  if (!email.includes("@")) return null
  return { email, key: token.slice(split + 1) }
}

async function accountGet(token: string, path: string): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
  const login = accountLogin(token)
  if (!login) throw new Error("Add UPSTASH_EMAIL, the email you use for the Upstash console.")
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${login.email}:${login.key}`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    throw new Error("Upstash rejected that account email and read-only key.")
  }
  if (!res.ok) throw new Error(`Upstash account API ${res.status}: ${text.slice(0, 160)}`)
  return JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>
}

function asRecord(body: Record<string, unknown> | Array<Record<string, unknown>>): Record<string, unknown> | null {
  return Array.isArray(body) ? null : body
}

function numberField(body: Record<string, unknown> | null, key: string): number | null {
  if (body == null) return null
  const value = body[key]
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : null
}
