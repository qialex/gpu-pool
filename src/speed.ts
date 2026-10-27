import { tokensPerSecond } from "./policy.js"

const LIST_TIMEOUT_MS = 10_000
const CHAT_TIMEOUT_MS = 45_000
const SPEED_PROMPT = "Write about one hundred tokens, as ordinary sentences and not as a list. Explain how a public library lends books to someone who has just moved to town. Start with how a person joins and gets a card. Then describe walking the shelves, reading a few opening pages, and choosing one book to take home. Explain the usual loan period, where the book is returned, and what the library does when a book is late. Add a short note on renewing a loan before it is due, placing a hold when every copy is out, and asking a librarian for a suggestion. Mention that the same card can be used for another visit the following week, and that a returned book is checked in before it goes back on the shelf. Stay on that subject. Keep the whole answer close to one hundred tokens so each speed check produces a similar amount of text. Do not greet the reader, do not add a title, and do not stop after a single sentence. Use plain words. Picture one ordinary first visit, from the front doors to the main lending desk."

export type SpeedResult =
  | { kind: "loading" }
  | { kind: "sample"; tokensPerSec: number | null; model: string | null; error: string | null }

/** Time one completion. An empty model list means the weights are not loaded yet. */
export async function measureTextSpeed(root: string): Promise<SpeedResult> {
  const listed = await readModels(root)
  if (listed.kind === "loading") return listed
  if (listed.kind === "failed") return sample(listed.model, listed.error)

  const model = listed.model
  const started = Date.now()
  try {
    const res = await fetch(endpoint(root, "/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: SPEED_PROMPT }],
        max_tokens: 100,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    })
    const elapsedMs = Date.now() - started
    const payload = await res.json().catch(() => null)
    if (!res.ok) return sample(model, `chat HTTP ${res.status}`)
    const tokens = completionTokens(payload)
    const rate = tokens == null ? null : tokensPerSecond(tokens, elapsedMs)
    if (rate == null) return sample(model, "chat response has no completion tokens")
    return { kind: "sample", tokensPerSec: rate, model, error: null }
  } catch (err) {
    return sample(model, errorText(err))
  }
}

type Listed = { kind: "loading" } | { kind: "ready"; model: string } | { kind: "failed"; model: string | null; error: string }

async function readModels(root: string): Promise<Listed> {
  let res: Response
  try {
    res = await fetch(endpoint(root, "/v1/models"), { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
  } catch (err) {
    return { kind: "failed", model: null, error: errorText(err) }
  }
  const body = await res.json().catch(() => null)
  const listed = modelIds(body)
  if (listed == null) return { kind: "failed", model: null, error: res.ok ? "models response has no list" : `models HTTP ${res.status}` }
  if (listed.length === 0) return { kind: "loading" }
  const model = listed[0]
  if (!model) return { kind: "failed", model: null, error: "models response has no id" }
  if (!res.ok) return { kind: "failed", model, error: `models HTTP ${res.status}` }
  return { kind: "ready", model }
}

/** Empty array means the server listed no models. Null means the body is not a model list. */
function modelIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  if (data.length === 0) return []
  const ids: string[] = []
  for (const item of data) {
    if (!item || typeof item !== "object") continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== "string") continue
    const trimmed = id.trim()
    if (trimmed) ids.push(trimmed)
  }
  return ids.length > 0 ? ids : null
}

function completionTokens(body: unknown): number | null {
  if (!body || typeof body !== "object") return null
  const usage = (body as { usage?: unknown }).usage
  if (!usage || typeof usage !== "object") return null
  const raw = (usage as { completion_tokens?: unknown }).completion_tokens
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null
}

function sample(model: string | null, error: string): SpeedResult {
  return { kind: "sample", tokensPerSec: null, model, error }
}

function endpoint(root: string, path: string): string {
  return root.replace(/\/+$/, "") + path
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return "speed check failed"
}
