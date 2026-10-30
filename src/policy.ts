export const TAGS = ["text_regular", "text_premium", "audio", "image"] as const
export type Tag = (typeof TAGS)[number]

export type ProbeStatus = "ready" | "busy" | "down" | "starting"

export type Criteria = {
  gpuFracMin?: number | null
  staticIp?: boolean | null
  gpuMemBwMin?: number | null
  reliabilityMin?: number | null
  gpuRamMin?: number | null
  numGpus?: number | null
  gpuNames?: string[] | null
  inetDownMin?: number | null
  inetUpMin?: number | null
  directPortCountMin?: number | null
  cudaMaxGoodMin?: number | null
  cpuRamMin?: number | null
  geolocation?: string[] | null
  datacenter?: boolean | null
  /** Require Vast verification. Default true. */
  verified?: boolean | null
  /** text_regular and text_premium only. Measured after the model is ready, not on the Vast offer. */
  tokensPerSecMin?: number | null
}

export type PriceSearch = {
  min: number
  step: number
  loops: number
  max: number
}

export const OPTIMIZE_FIELDS = [
  "dph_total",
  "gpu_mem_bw",
  "gpu_ram",
  "reliability",
  "inet_down",
  "inet_up",
  "cuda_max_good",
  "cpu_ram",
  "gpu_frac",
  "direct_port_count",
  "bw_per_dollar",
  "tokens_per_sec",
] as const

export type OptimizeField = (typeof OPTIMIZE_FIELDS)[number]
export type OptimizeDirection = "lower" | "higher"

export type OptimizeGoal = {
  field: OptimizeField
  direction: OptimizeDirection
  /** Smallest improvement that decides this row. Null means any strict difference. */
  minGain: number | null
}

export type MetricMap = Partial<Record<OptimizeField, number>>

export const OPTIMIZE_FIELD_LABELS: Record<OptimizeField, string> = {
  dph_total: "Price $/hr",
  gpu_mem_bw: "GPU mem GB/s",
  gpu_ram: "GPU RAM MB",
  reliability: "Reliability",
  inet_down: "Download MB/s",
  inet_up: "Upload MB/s",
  cuda_max_good: "CUDA",
  cpu_ram: "CPU RAM MB",
  gpu_frac: "GPU fraction",
  direct_port_count: "Direct ports",
  bw_per_dollar: "GPU bandwidth / $",
  tokens_per_sec: "tok/s",
}

export const OPTIMIZE_SLOTS = 3

const LOADING_DEADLINE_MS = 40 * 60 * 1000
const REBOOT_DEADLINE_MS = 10 * 60 * 1000
const BLACKLIST_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** True while the ban time is still in the future. An expired ban is off the list. */
export function banIsActive(bannedUntilMs: number, nowMs: number): boolean {
  return Number.isFinite(bannedUntilMs) && bannedUntilMs > nowMs
}

/** Next global ban after a machine fails to load. Strikes stay stored after the ban leaves the list. */
export function blacklistBan(previousStrikes: number, nowMs: number): { strikes: number; bannedUntilMs: number } {
  const strikes = Math.max(0, Math.floor(previousStrikes)) + 1
  return { strikes, bannedUntilMs: nowMs + strikes * BLACKLIST_WEEK_MS }
}

export function isTag(value: string | null | undefined): value is Tag {
  return TAGS.includes(value as Tag)
}

export function isTextTag(tag: Tag): boolean {
  return tag === "text_regular" || tag === "text_premium"
}

const SPEED_RETRY_MS = 60 * 1000
const SPEED_OK_INTERVAL_MS = 10 * 60 * 1000

/** True when a text instance should be timed again. A failure retries after a minute. A successful sample waits ten minutes. */
export function textSpeedDue(lastAttemptMs: number | null, nowMs: number, lastOk: boolean): boolean {
  if (lastAttemptMs == null || !Number.isFinite(lastAttemptMs)) return true
  const wait = lastOk ? SPEED_OK_INTERVAL_MS : SPEED_RETRY_MS
  return nowMs - lastAttemptMs >= wait
}

/** Completion tokens divided by the full request time. Missing or empty timings are not a sample. */
export function tokensPerSecond(completionTokens: number, elapsedMs: number): number | null {
  if (!Number.isFinite(completionTokens) || completionTokens < 0) return null
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null
  return completionTokens / (elapsedMs / 1000)
}

/** Measured tok/s on a running text instance. Vast offers do not carry this number. */
export function withSpeed(metrics: MetricMap, tokensPerSec: number | null): MetricMap {
  if (tokensPerSec == null || !Number.isFinite(tokensPerSec)) return metrics
  return { ...metrics, tokens_per_sec: tokensPerSec }
}

/** A finished sample under the template minimum. No sample is not a failure. */
export function belowTokensPerSecMin(tokensPerSec: number | null, min: number | null | undefined): boolean {
  if (min == null || !Number.isFinite(min)) return false
  if (tokensPerSec == null || !Number.isFinite(tokensPerSec)) return false
  return tokensPerSec < min
}

export function isOptimizeField(value: string | null | undefined): value is OptimizeField {
  return (OPTIMIZE_FIELDS as readonly string[]).includes(value ?? "")
}

const METRIC_ALIASES: Partial<Record<OptimizeField, string[]>> = {
  gpu_ram: ["gpu_total_ram", "gpu_totalram"],
  reliability: ["reliability2"],
}

export function metricsFrom(row: Record<string, unknown>): MetricMap {
  const out: MetricMap = {}
  for (const field of OPTIMIZE_FIELDS) {
    if (field === "bw_per_dollar" || field === "tokens_per_sec") continue
    const n = metricNumber(row[field]) ?? aliasNumber(row, METRIC_ALIASES[field])
    if (n != null) out[field] = n
  }
  return applyDerivedMetrics(out)
}

/** GPU mem bandwidth ÷ $/hr. Vast does not send this value. */
export function applyDerivedMetrics(metrics: MetricMap): MetricMap {
  const bandwidth = metrics.gpu_mem_bw
  const price = metrics.dph_total
  const rest = { ...metrics }
  delete rest.bw_per_dollar
  delete (rest as MetricMap & { bw_frac_per_dollar?: number }).bw_frac_per_dollar
  if (bandwidth == null || price == null || price <= 0) return rest
  return { ...rest, bw_per_dollar: bandwidth / price }
}

function metricNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

function aliasNumber(row: Record<string, unknown>, aliases: string[] | undefined): number | null {
  for (const alias of aliases ?? []) {
    const n = metricNumber(row[alias])
    if (n != null) return n
  }
  return null
}

function goalDelta(candidate: number, incumbent: number, direction: OptimizeDirection): number {
  return direction === "lower" ? incumbent - candidate : candidate - incumbent
}

/**
 * True when an earlier goal beats the incumbent by at least its gain.
 * A difference inside the gain falls through. A difference worse than the gain rejects the offer.
 */
export function isBetter(candidate: MetricMap, incumbent: MetricMap, goals: OptimizeGoal[]): boolean {
  if (goals.length === 0) return false
  for (const goal of goals) {
    const left = candidate[goal.field]
    const right = incumbent[goal.field]
    if (left == null || right == null) continue
    const delta = goalDelta(left, right, goal.direction)
    const gain = goal.minGain != null && goal.minGain > 0 ? goal.minGain : 0
    if (gain === 0) {
      if (delta > 0) return true
      if (delta < 0) return false
      continue
    }
    if (delta + 1e-9 >= gain) return true
    if (delta <= -gain + 1e-9) return false
  }
  return false
}

/** Negative when `a` should be chosen before `b`. An empty goal list sorts by lower price. */
export function compareMetrics(a: MetricMap, b: MetricMap, goals: OptimizeGoal[]): number {
  const ranked = goals.length > 0 ? goals : [{ field: "dph_total" as const, direction: "lower" as const, minGain: null }]
  for (const goal of ranked) {
    const left = a[goal.field]
    const right = b[goal.field]
    if (left == null && right == null) continue
    if (left == null) return 1
    if (right == null) return -1
    const delta = goalDelta(left, right, goal.direction)
    if (delta > 0) return -1
    if (delta < 0) return 1
  }
  return 0
}

/**
 * Rank two running instances. A missing tok/s sample is unknown, not slow.
 * A tok/s difference inside its gain is a tie.
 */
export function compareHeld(a: MetricMap, b: MetricMap, goals: OptimizeGoal[]): number {
  const ranked = goals.length > 0 ? goals : [{ field: "dph_total" as const, direction: "lower" as const, minGain: null }]
  for (const goal of ranked) {
    const left = a[goal.field]
    const right = b[goal.field]
    if (goal.field === "tokens_per_sec" && (left == null || right == null)) continue
    if (left == null && right == null) continue
    if (left == null) return 1
    if (right == null) return -1
    const delta = goalDelta(left, right, goal.direction)
    if (goal.field === "tokens_per_sec") {
      const gain = goal.minGain != null && goal.minGain > 0 ? goal.minGain : 0
      if (gain > 0) {
        if (delta + 1e-9 >= gain) return -1
        if (delta <= -gain + 1e-9) return 1
        continue
      }
    }
    if (delta > 0) return -1
    if (delta < 0) return 1
  }
  return 0
}

/**
 * Rent a text trial when tok/s is a goal, the current machine has a sample, and the offer does not.
 * An earlier goal that is already worse still rejects the offer.
 */
export function acceptsUnmeasuredSpeed(candidate: MetricMap, incumbent: MetricMap, goals: OptimizeGoal[]): boolean {
  if (incumbent.tokens_per_sec == null || candidate.tokens_per_sec != null) return false
  if (!goals.some(goal => goal.field === "tokens_per_sec")) return false
  for (const goal of goals) {
    if (goal.field === "tokens_per_sec") continue
    const left = candidate[goal.field]
    const right = incumbent[goal.field]
    if (left == null || right == null) continue
    const delta = goalDelta(left, right, goal.direction)
    const gain = goal.minGain != null && goal.minGain > 0 ? goal.minGain : 0
    if (gain === 0) {
      if (delta < 0) return false
      continue
    }
    if (delta <= -gain + 1e-9) return false
  }
  return true
}

/**
 * Ceilings to search while a slot is already full.
 * A lower price goal stays below the current price. Any other goal searches once at the budget.
 */
export function optimizationPlan(search: PriceSearch, incumbent: MetricMap, goals: OptimizeGoal[]): number[] {
  const primary = goals[0]
  if (!primary) return []
  if (primary.field === "dph_total" && primary.direction === "lower") {
    const price = incumbent.dph_total
    if (price == null) return []
    const gain = primary.minGain != null && primary.minGain > 0 ? primary.minGain : 0.0001
    const cap = roundMoney(Math.min(search.max, price - gain))
    if (cap < search.min) return []
    return priceSearchPlan({ ...search, max: cap })
  }
  return [roundMoney(search.max)]
}

/** A machine that answered, including one that is loaded and slow. */
export function isServing(probeStatus: ProbeStatus | null): boolean {
  return probeStatus === "ready" || probeStatus === "busy"
}

/** Counts toward Instances only after the first successful probe. A later outage still counts. */
export function countsAsWorking(readyAt: Date | null): boolean {
  return readyAt != null
}

/** A desired-count slot. A machine that has never been healthy does not hold one. */
export function fillsDesiredSlot(actualStatus: string | null, readyAt: Date | null): boolean {
  return occupiesSlot(actualStatus) && countsAsWorking(readyAt)
}

/**
 * How many more machines to rent while proven machines are still short of Instances.
 * Null means burst does not apply. Zero means the burst slots are full and the caller should wait.
 * An unproven machine occupies one of these slots and does not count as working.
 */
export function burstRentCount(working: number, desired: number, burst: number, occupying: number): number | null {
  if (burst <= desired || working >= desired) return null
  const cap = Math.max(desired, burst)
  if (occupying >= cap) return 0
  return cap - occupying
}

/** An unproven machine that is neither loaded, gone, nor past the load deadline. */
export function burstStillWaiting(
  actualStatus: string | null,
  probeStatus: ProbeStatus | null,
  ageMs: number,
  hasWorked = false,
): boolean {
  if (hasWorked || isServing(probeStatus) || !occupiesSlot(actualStatus)) return false
  return ageMs <= LOADING_DEADLINE_MS
}

export function stillStarting(actualStatus: string | null, probeStatus: ProbeStatus | null): boolean {
  if (actualStatus == null || actualStatus === "" || actualStatus === "loading" || actualStatus === "rebooting") return true
  return probeStatus === "starting"
}

/** Price ceilings from min to max, one step apart. Loops do not change the ladder. */
export function priceCeilings(search: PriceSearch): number[] {
  if (search.step < 0 || search.min > search.max) return []
  if (search.step === 0) return [roundMoney(search.min)]
  const steps = Math.floor((search.max - search.min) / search.step + 1e-9)
  const out: number[] = []
  for (let i = 0; i <= steps; i++) out.push(roundMoney(search.min + i * search.step))
  const max = roundMoney(search.max)
  if (out[out.length - 1] !== max) out.push(max)
  return out
}

/** Each ceiling is searched `loops` times before the next higher ceiling. */
export function priceSearchPlan(search: PriceSearch): number[] {
  const loops = Math.max(0, Math.floor(search.loops))
  if (loops === 0) return []
  return priceCeilings(search).flatMap(ceiling => Array.from({ length: loops }, () => ceiling))
}

function roundMoney(n: number): number {
  return Math.round(n * 10000) / 10000
}

export function occupiesSlot(actualStatus: string | null): boolean {
  return (
    actualStatus == null ||
    actualStatus === "" ||
    actualStatus === "loading" ||
    actualStatus === "running" ||
    actualStatus === "rebooting"
  )
}

export function shouldDestroy(actualStatus: string | null, ageMs: number, intendedStatus?: string | null): boolean {
  if (intendedStatus === "stopped") return false
  if (actualStatus === "exited" || actualStatus === "unknown" || actualStatus === "offline") {
    return true
  }
  if ((actualStatus == null || actualStatus === "" || actualStatus === "loading") && ageMs > LOADING_DEADLINE_MS) {
    return true
  }
  if (actualStatus === "rebooting" && ageMs > REBOOT_DEADLINE_MS) return true
  return false
}

/**
 * A machine that never became healthy. Releasing it has to blacklist the host,
 * including a burst extra we already stopped after the load deadline.
 * A machine that did become healthy and was then stopped stays off this path.
 */
export function blacklistFailedLoad(
  actualStatus: string | null,
  probeStatus: ProbeStatus | null,
  ageMs: number,
  hasBeenReady: boolean,
  intendedStatus: string | null,
): boolean {
  if (hasBeenReady || isServing(probeStatus)) return false
  if (intendedStatus === "stopped") return true
  return occupiesSlot(actualStatus) && ageMs > LOADING_DEADLINE_MS
}

export function urlSuffix(tag: Tag | null): string {
  if (tag === "text_regular" || tag === "text_premium") return "/v1"
  return ""
}

export function defaultHealthPath(tag: Tag | null): string {
  if (tag === "text_regular" || tag === "text_premium") return "/v1/models"
  return "/health"
}

export function effectiveHealthPath(tag: Tag | null, override: string | null): string {
  const raw = (override ?? "").trim() || defaultHealthPath(tag)
  return raw.startsWith("/") ? raw : `/${raw}`
}

/** Distinct health paths for every tag on a template. An override replaces them. */
export function probePaths(tags: Tag[], override: string | null): string[] {
  const custom = (override ?? "").trim()
  if (custom) return [custom.startsWith("/") ? custom : `/${custom}`]
  const paths = [...new Set(tags.map(tag => defaultHealthPath(tag)))]
  return paths.length > 0 ? paths : ["/health"]
}

export function bestProbe(statuses: ProbeStatus[]): ProbeStatus {
  if (statuses.includes("ready")) return "ready"
  if (statuses.includes("busy")) return "busy"
  if (statuses.includes("starting")) return "starting"
  return "down"
}

export function instanceRoot(ip: string, port: number): string {
  return `http://${ip}:${port}`
}

export function detectContainerPort(env: unknown): number | null {
  const chunks: string[] = []
  collect(env, chunks)
  const re = /-p\s*(\d+):(\d+)/
  for (const chunk of chunks) {
    const match = re.exec(chunk)
    if (match) return Number(match[2])
  }
  return null
}

function collect(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out)
    return
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      collect(child, out)
    }
  }
}

export function hostPortFor(ports: unknown, containerPort: number): number | null {
  if (!ports || typeof ports !== "object") return null
  const entry = (ports as Record<string, Array<{ HostPort?: string | number }>>)[`${containerPort}/tcp`]
  const raw = entry?.[0]?.HostPort
  const port = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(port) && port > 0 ? port : null
}

export function buildSearchBody(opts: {
  ceiling: number
  diskGb: number
  criteria: Criteria
  extraFilters: Record<string, unknown> | null
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    limit: 20,
    ...(opts.extraFilters ?? {}),
  }
  body.type = "ondemand"
  body.rentable = { eq: true }
  body.rented = { eq: false }
  body.allocated_storage = opts.diskGb
  body.disk_space = { gte: opts.diskGb }
  body.dph_total = { lte: opts.ceiling }
  body.order = [["dph_total", "asc"]]

  const c = opts.criteria
  if (c.gpuFracMin != null) body.gpu_frac = { gte: c.gpuFracMin }
  if (c.staticIp != null) body.static_ip = { eq: c.staticIp }
  if (c.gpuMemBwMin != null) body.gpu_mem_bw = { gte: c.gpuMemBwMin }
  if (c.reliabilityMin != null) body.reliability = { gte: c.reliabilityMin }
  if (c.gpuRamMin != null) body.gpu_ram = { gte: c.gpuRamMin }
  if (c.numGpus != null) body.num_gpus = { eq: c.numGpus }
  if (c.gpuNames && c.gpuNames.length > 0) {
    body.gpu_name = { in: c.gpuNames.map(name => name.trim().replace(/ /g, "_")).filter(Boolean) }
  }
  if (c.inetDownMin != null) body.inet_down = { gte: c.inetDownMin }
  if (c.inetUpMin != null) body.inet_up = { gte: c.inetUpMin }
  if (c.directPortCountMin != null) body.direct_port_count = { gte: c.directPortCountMin }
  if (c.cudaMaxGoodMin != null) body.cuda_max_good = { gte: c.cudaMaxGoodMin }
  if (c.cpuRamMin != null) body.cpu_ram = { gte: c.cpuRamMin }
  if (c.geolocation && c.geolocation.length > 0) body.geolocation = { in: c.geolocation }
  if (c.datacenter != null) body.datacenter = { eq: c.datacenter }
  if (c.verified !== false) body.verification = { eq: "verified" }
  return body
}

/** Unhealthy running machines are stopped before healthy ones. */
export function stopRank(probe: ProbeStatus | null): number {
  if (probe === "down") return 0
  if (probe === "busy") return 1
  if (probe === "starting" || probe == null) return 2
  return 3
}
