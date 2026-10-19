import { redisRest } from "./config.js"

type UpstashItem = { result?: unknown; error?: string }

/** Runs Redis commands through the Upstash REST pipeline. One array entry is one billed command. */
export async function redis(commands: string[][]): Promise<unknown[]> {
  if (commands.length === 0) return []
  const { url, token } = redisRest()
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${text.slice(0, 180)}`)
  const parsed = JSON.parse(text) as UpstashItem[] | { error?: string }
  if (!Array.isArray(parsed)) {
    throw new Error(parsed.error ?? "Unexpected Upstash response")
  }
  return parsed.map(item => {
    if (item.error) throw new Error(item.error)
    return item.result ?? null
  })
}

export async function readDoc<T>(key: string, fallback: T): Promise<T> {
  const [raw] = await redis([["GET", key]])
  if (typeof raw !== "string" || !raw) return fallback
  return JSON.parse(raw) as T
}

export async function updateDoc<T>(key: string, fallback: T, change: (doc: T) => T): Promise<T> {
  const lock = `lock:${key}`
  for (let attempt = 0; attempt < 25; attempt++) {
    const [locked] = await redis([["SET", lock, "1", "NX", "EX", "8"]])
    if (locked !== "OK") {
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
      continue
    }
    try {
      const current = await readDoc(key, fallback)
      const next = change(current)
      await redis([["SET", key, JSON.stringify(next)]])
      return next
    } finally {
      await redis([["DEL", lock]])
    }
  }
  throw new Error(`Could not lock ${key}`)
}
