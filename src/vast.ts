import { metricsFrom, type MetricMap } from "./policy.js"

const VAST_ORIGIN = "https://console.vast.ai"

export class VastError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export type VastTemplate = {
  hashId: string
  vastId: number | null
  name: string | null
  image: string | null
  recommendedDisk: number | null
  extraFilters: Record<string, unknown>
  env: unknown
}

export type VastInstance = {
  id: number
  templateHashId: string | null
  actualStatus: string | null
  intendedStatus: string | null
  statusMsg: string | null
  publicIp: string | null
  ports: unknown
  gpuName: string | null
  dphTotal: number | null
  label: string | null
  startDate: number | null
  machineId: number | null
  metrics: MetricMap
}

async function vastFetch(apiKey: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${VAST_ORIGIN}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const msg = typeof body === "object" && body && "msg" in body
      ? String((body as { msg: unknown }).msg)
      : text.slice(0, 300)
    throw new VastError(`Vast ${res.status} ${path}: ${msg || res.statusText}`, res.status)
  }
  return body
}

export async function currentUserId(apiKey: string): Promise<number> {
  const body = (await vastFetch(apiKey, "/api/v0/users/current/")) as Record<string, unknown>
  const id = numberFrom(body.id ?? (body.user as Record<string, unknown> | undefined)?.id)
  if (id == null) throw new Error("Vast current user response had no id")
  return id
}

export async function listOwnTemplates(apiKey: string): Promise<VastTemplate[]> {
  const userId = await currentUserId(apiKey)
  const params = new URLSearchParams()
  params.set("select_filters", JSON.stringify({ creator_id: { eq: userId } }))
  params.set("select_cols", JSON.stringify(["*"]))
  const body = (await vastFetch(apiKey, `/api/v0/template/?${params.toString()}`)) as Record<string, unknown>
  const rows = Array.isArray(body.templates) ? body.templates : []
  return rows.map(normalizeTemplate).filter((row): row is VastTemplate => row != null)
}

export async function listInstances(apiKey: string): Promise<VastInstance[]> {
  const out: VastInstance[] = []
  let token: string | null = null
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams()
    params.set("limit", "64")
    if (token) params.set("after_token", token)
    const body = (await vastFetch(apiKey, `/api/v1/instances/?${params.toString()}`)) as Record<string, unknown>
    const rows = Array.isArray(body.instances) ? body.instances : []
    for (const row of rows) {
      const instance = normalizeInstance(row)
      if (instance) out.push(instance)
    }
    token = typeof body.next_token === "string" && body.next_token ? body.next_token : null
    if (!token || rows.length === 0) break
  }
  return out
}

export async function showInstance(apiKey: string, id: number): Promise<VastInstance | null> {
  const body = (await vastFetch(apiKey, `/api/v0/instances/${id}/`)) as Record<string, unknown>
  const raw = body.instances ?? body.instance ?? body
  return normalizeInstance(raw)
}

export async function searchOffers(apiKey: string, query: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const body = (await vastFetch(apiKey, "/api/v0/bundles/", {
    method: "POST",
    body: JSON.stringify(query),
  })) as Record<string, unknown>
  const offers = Array.isArray(body.offers) ? body.offers : []
  return offers.filter((offer): offer is Record<string, unknown> => !!offer && typeof offer === "object")
}

export async function createInstance(
  apiKey: string,
  offerId: number,
  input: { templateHashId: string; diskGb: number; label: string },
): Promise<number | null> {
  const body = (await vastFetch(apiKey, `/api/v0/asks/${offerId}/`, {
    method: "PUT",
    body: JSON.stringify({
      template_hash_id: input.templateHashId,
      disk: input.diskGb,
      label: input.label,
      target_state: "running",
    }),
  })) as Record<string, unknown>
  return numberFrom(body.new_contract)
}

export async function stopInstance(apiKey: string, id: number): Promise<void> {
  await vastFetch(apiKey, `/api/v0/instances/${id}/`, {
    method: "PUT",
    body: JSON.stringify({ state: "stopped" }),
  })
}

export async function destroyInstance(apiKey: string, id: number): Promise<void> {
  await vastFetch(apiKey, `/api/v0/instances/${id}/`, { method: "DELETE" })
}

function normalizeTemplate(raw: unknown): VastTemplate | null {
  if (!raw || typeof raw !== "object") return null
  const row = raw as Record<string, unknown>
  const hashId = stringFrom(row.hash_id)
  if (!hashId) return null
  const extra = row.extra_filters
  return {
    hashId,
    vastId: numberFrom(row.id),
    name: stringFrom(row.name),
    image: stringFrom(row.image),
    recommendedDisk: numberFrom(row.recommended_disk_space),
    extraFilters: extra && typeof extra === "object" && !Array.isArray(extra)
      ? extra as Record<string, unknown>
      : {},
    env: row.env ?? row.extra_env ?? null,
  }
}

function normalizeInstance(raw: unknown): VastInstance | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const id = numberFrom(row.id)
  if (id == null) return null
  const status = row.actual_status
  return {
    id,
    templateHashId: stringFrom(row.template_hash_id),
    actualStatus: status == null || status === "" ? null : String(status),
    intendedStatus: stringFrom(row.intended_status),
    statusMsg: stringFrom(row.status_msg),
    publicIp: stringFrom(row.public_ipaddr),
    ports: row.ports ?? null,
    gpuName: stringFrom(row.gpu_name),
    dphTotal: numberFrom(row.dph_total),
    label: stringFrom(row.label),
    startDate: numberFrom(row.start_date),
    machineId: numberFrom(row.machine_id),
    metrics: metricsFrom(row),
  }
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function stringFrom(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
