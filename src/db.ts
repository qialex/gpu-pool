import { blacklistBan, isServing, type Criteria, type MetricMap, type OptimizeGoal, type ProbeStatus, type Tag } from "./policy.js"
import { readDoc, redis, updateDoc } from "./redis.js"

export type TemplateRow = {
  hashId: string
  vastId: number | null
  name: string | null
  image: string | null
  recommendedDisk: number | null
  desiredCount: number
  tags: Tag[]
  priceMin: number | null
  priceStep: number | null
  priceLoops: number | null
  priceMax: number | null
  diskGb: number | null
  criteria: Criteria
  containerPort: number | null
  detectedPort: number | null
  healthPath: string | null
  extraFilters: Record<string, unknown>
  optimize: OptimizeGoal[]
  optimizeTrials: number
  burst: number
  active: boolean
}

export type InstanceRow = {
  vastInstanceId: number
  templateHashId: string | null
  publicIp: string | null
  hostPort: number | null
  baseUrl: string | null
  actualStatus: string | null
  intendedStatus: string | null
  statusMsg: string | null
  probeStatus: ProbeStatus | null
  gpuName: string | null
  dphTotal: number | null
  label: string | null
  startDate: number | null
  machineId: number | null
  metrics: MetricMap
  firstSeenAt: Date
  lastVastSyncAt: Date | null
  lastProbeAt: Date | null
  readyAt: Date | null
  probes: ProbeSample[]
}

export type ProbeSample = {
  at: string
  status: ProbeStatus
}

export type InstanceAction = "rent" | "release" | "ban" | "unban"

export type InstanceEvent = {
  at: string
  action: InstanceAction
  vastInstanceId: number | null
  machineId: number | null
  templateHashId: string | null
  templateName: string | null
  reason: string
}

export type TemplatePatch = {
  desiredCount: number
  tags: Tag[]
  priceMin: number | null
  priceStep: number | null
  priceLoops: number | null
  priceMax: number | null
  diskGb: number | null
  criteria: Criteria
  containerPort: number | null
  healthPath: string | null
  optimize: OptimizeGoal[]
  optimizeTrials: number
  burst: number
  active: boolean
}

export type BlacklistSnapshot = {
  templateHashId: string | null
  templateName: string | null
  tags: string[]
  gpuName: string | null
  dphTotal: number | null
  metrics: MetricMap
}

export type BlacklistRow = {
  machineId: number
  strikes: number
  bannedUntil: Date
  reason: string | null
  templateHashId: string | null
  templateName: string | null
  tags: string[]
  gpuName: string | null
  dphTotal: number | null
  metrics: MetricMap
  updatedAt: Date
}

type InstanceDoc = Omit<InstanceRow, "firstSeenAt" | "lastVastSyncAt" | "lastProbeAt" | "readyAt" | "probes"> & {
  firstSeenAt: string
  lastVastSyncAt: string | null
  lastProbeAt: string | null
  readyAt: string | null
  probes?: ProbeSample[]
}

type PendingDoc = { offerId: number; templateHashId: string; createdAt: string }

type BlacklistDoc = Omit<BlacklistRow, "bannedUntil" | "updatedAt"> & { bannedUntil: string; updatedAt: string }

const KEYS = {
  templates: "doc:templates",
  instances: "doc:instances",
  pending: "doc:pending",
  blacklist: "doc:blacklist",
  events: "doc:events",
}

const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PROBE_HISTORY = 3

export async function listTemplates(): Promise<TemplateRow[]> {
  const rows = await readDoc<TemplateRow[]>(KEYS.templates, [])
  return rows.sort((a, b) => (a.name ?? a.hashId).localeCompare(b.name ?? b.hashId))
}

export async function getTemplate(hashId: string): Promise<TemplateRow | null> {
  return (await listTemplates()).find(row => row.hashId === hashId) ?? null
}

export async function upsertTemplateSeen(input: {
  hashId: string
  vastId: number | null
  name: string | null
  image: string | null
  recommendedDisk: number | null
  detectedPort: number | null
  extraFilters: Record<string, unknown>
}): Promise<void> {
  await updateDoc<TemplateRow[]>(KEYS.templates, [], rows => {
    const current = rows.find(row => row.hashId === input.hashId)
    const next: TemplateRow = current
      ? {
          ...current,
          vastId: input.vastId,
          name: input.name,
          image: input.image,
          recommendedDisk: input.recommendedDisk,
          detectedPort: input.detectedPort,
          extraFilters: input.extraFilters,
        }
      : {
          hashId: input.hashId,
          vastId: input.vastId,
          name: input.name,
          image: input.image,
          recommendedDisk: input.recommendedDisk,
          desiredCount: 0,
          tags: [],
          priceMin: null,
          priceStep: null,
          priceLoops: null,
          priceMax: null,
          diskGb: null,
          criteria: {},
          containerPort: null,
          detectedPort: input.detectedPort,
          healthPath: null,
          extraFilters: input.extraFilters,
          optimize: [],
          optimizeTrials: 0,
          burst: 0,
          active: false,
        }
    return [...rows.filter(row => row.hashId !== input.hashId), next]
  })
}

export async function saveTemplateSettings(hashId: string, patch: TemplatePatch): Promise<void> {
  await updateDoc<TemplateRow[]>(KEYS.templates, [], rows =>
    rows.map(row => (row.hashId === hashId ? { ...row, ...patch } : row)),
  )
}

export async function listInstances(): Promise<InstanceRow[]> {
  const docs = await readDoc<InstanceDoc[]>(KEYS.instances, [])
  return docs.map(hydrateInstance).sort((a, b) => a.vastInstanceId - b.vastInstanceId)
}

export async function listInstancesForTag(tag: Tag): Promise<InstanceRow[]> {
  const active = new Set((await listTemplates()).filter(row => row.active && row.tags.includes(tag)).map(row => row.hashId))
  return (await listInstances()).filter(row => row.templateHashId != null && active.has(row.templateHashId))
}

export async function upsertInstance(row: Omit<InstanceRow, "firstSeenAt" | "lastVastSyncAt" | "lastProbeAt" | "readyAt" | "probeStatus" | "probes"> & { probeStatus?: ProbeStatus | null }): Promise<void> {
  const now = new Date().toISOString()
  await updateDoc<InstanceDoc[]>(KEYS.instances, [], docs => {
    const current = docs.find(doc => doc.vastInstanceId === row.vastInstanceId)
    const next: InstanceDoc = current
      ? {
          ...current,
          ...row,
          probeStatus: row.probeStatus ?? current.probeStatus,
          machineId: row.machineId ?? current.machineId,
          metrics: { ...current.metrics, ...row.metrics },
          firstSeenAt: current.firstSeenAt,
          lastVastSyncAt: now,
          lastProbeAt: current.lastProbeAt,
          readyAt: current.readyAt ?? null,
          probes: current.probes ?? [],
        }
      : {
          ...row,
          probeStatus: row.probeStatus ?? null,
          metrics: row.metrics,
          firstSeenAt: now,
          lastVastSyncAt: now,
          lastProbeAt: null,
          readyAt: null,
          probes: [],
        }
    return [...docs.filter(doc => doc.vastInstanceId !== row.vastInstanceId), next]
  })
}

export async function deleteInstance(vastInstanceId: number): Promise<void> {
  await updateDoc<InstanceDoc[]>(KEYS.instances, [], docs => docs.filter(doc => doc.vastInstanceId !== vastInstanceId))
}

export async function setProbe(
  vastInstanceId: number,
  status: ProbeStatus,
  endpoint?: { publicIp: string; hostPort: number; baseUrl: string } | null,
): Promise<void> {
  const now = new Date().toISOString()
  await updateDoc<InstanceDoc[]>(KEYS.instances, [], docs =>
    docs.map(doc => {
      if (doc.vastInstanceId !== vastInstanceId) return doc
      const probes = [...(doc.probes ?? []), { at: now, status }].slice(-PROBE_HISTORY)
      return {
        ...doc,
        probeStatus: status,
        lastProbeAt: now,
        readyAt: doc.readyAt ?? (isServing(status) ? now : null),
        probes,
        ...(endpoint ?? {}),
      }
    }),
  )
}

export async function deleteInstancesExcept(ids: number[]): Promise<void> {
  const keep = new Set(ids)
  await updateDoc<InstanceDoc[]>(KEYS.instances, [], docs => docs.filter(doc => keep.has(doc.vastInstanceId)))
}

export async function addPendingLaunch(templateHashId: string, contractId: number): Promise<void> {
  await insertPending(contractId, templateHashId)
}

export async function insertPending(offerId: number, templateHashId: string): Promise<void> {
  const now = new Date().toISOString()
  await updateDoc<PendingDoc[]>(KEYS.pending, [], docs => [
    ...docs.filter(doc => doc.offerId !== offerId),
    { offerId, templateHashId, createdAt: now },
  ])
}

export async function deletePending(offerId: number): Promise<void> {
  await updateDoc<PendingDoc[]>(KEYS.pending, [], docs => docs.filter(doc => doc.offerId !== offerId))
}

export async function deletePendingExcept(templateHashIds: string[]): Promise<void> {
  const keep = new Set(templateHashIds)
  await updateDoc<PendingDoc[]>(KEYS.pending, [], docs => docs.filter(doc => keep.has(doc.templateHashId)))
}

export async function countPending(templateHashId: string, seenIds: number[] = []): Promise<number> {
  const cutoff = Date.now() - 15 * 60 * 1000
  const seen = new Set(seenIds)
  const docs = await readDoc<PendingDoc[]>(KEYS.pending, [])
  return docs.filter(doc => doc.templateHashId === templateHashId && Date.parse(doc.createdAt) > cutoff && !seen.has(doc.offerId)).length
}

export async function sweepPending(): Promise<void> {
  const cutoff = Date.now() - 15 * 60 * 1000
  await updateDoc<PendingDoc[]>(KEYS.pending, [], docs => docs.filter(doc => Date.parse(doc.createdAt) > cutoff))
}

export async function blacklistMachine(
  machineId: number,
  reason: string,
  snapshot: BlacklistSnapshot,
  now = new Date(),
): Promise<{ strikes: number; bannedUntil: Date }> {
  let result = { strikes: 1, bannedUntil: now }
  await updateDoc<BlacklistDoc[]>(KEYS.blacklist, [], docs => {
    const current = docs.find(doc => doc.machineId === machineId)
    const ban = blacklistBan(current?.strikes ?? 0, now.getTime())
    result = { strikes: ban.strikes, bannedUntil: new Date(ban.bannedUntilMs) }
    const next: BlacklistDoc = {
      machineId,
      strikes: ban.strikes,
      bannedUntil: result.bannedUntil.toISOString(),
      reason,
      templateHashId: snapshot.templateHashId,
      templateName: snapshot.templateName,
      tags: snapshot.tags,
      gpuName: snapshot.gpuName,
      dphTotal: snapshot.dphTotal,
      metrics: snapshot.metrics,
      updatedAt: now.toISOString(),
    }
    return [...docs.filter(doc => doc.machineId !== machineId), next]
  })
  return result
}

export async function unbanMachine(machineId: number): Promise<void> {
  await updateDoc<BlacklistDoc[]>(KEYS.blacklist, [], docs => docs.filter(doc => doc.machineId !== machineId))
}

export async function recordInstanceEvent(event: Omit<InstanceEvent, "at">, now = new Date()): Promise<void> {
  const cutoff = now.getTime() - EVENT_TTL_MS
  await updateDoc<InstanceEvent[]>(KEYS.events, [], docs => [
    ...docs.filter(doc => Date.parse(doc.at) > cutoff),
    { ...event, at: now.toISOString() },
  ])
}

export async function listInstanceEvents(vastInstanceId: number, machineId: number | null, now = new Date()): Promise<InstanceEvent[]> {
  const cutoff = now.getTime() - EVENT_TTL_MS
  const docs = await readDoc<InstanceEvent[]>(KEYS.events, [])
  return docs
    .filter(doc => Date.parse(doc.at) > cutoff)
    .filter(doc => doc.vastInstanceId === vastInstanceId || (machineId != null && doc.machineId === machineId))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

export async function listMachineEvents(machineId: number, now = new Date()): Promise<InstanceEvent[]> {
  const cutoff = now.getTime() - EVENT_TTL_MS
  const docs = await readDoc<InstanceEvent[]>(KEYS.events, [])
  return docs
    .filter(doc => Date.parse(doc.at) > cutoff && doc.machineId === machineId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

export async function listBlacklist(): Promise<BlacklistRow[]> {
  const docs = await readDoc<BlacklistDoc[]>(KEYS.blacklist, [])
  return docs
    .map(doc => ({ ...doc, bannedUntil: new Date(doc.bannedUntil), updatedAt: new Date(doc.updatedAt) }))
    .sort((a, b) => b.bannedUntil.getTime() - a.bannedUntil.getTime())
}

export async function activeBlacklistedMachineIds(now = new Date()): Promise<Set<number>> {
  return bannedMachineIds(now)
}

export async function bannedMachineIds(now = new Date()): Promise<Set<number>> {
  return new Set((await listBlacklist()).filter(row => row.bannedUntil > now).map(row => row.machineId))
}

export async function deleteOperators(): Promise<void> {
  await redis([["DEL", "doc:operators"]])
}

export async function createSession(token: string, seconds: number): Promise<void> {
  await redis([["SET", `session:${token}`, "1", "EX", String(seconds)]])
}

export async function sessionExists(token: string): Promise<boolean> {
  const [raw] = await redis([["GET", `session:${token}`]])
  return typeof raw === "string" && raw.length > 0
}

export async function deleteSession(token: string): Promise<void> {
  await redis([["DEL", `session:${token}`]])
}

function hydrateInstance(doc: InstanceDoc): InstanceRow {
  return {
    ...doc,
    firstSeenAt: new Date(doc.firstSeenAt),
    lastVastSyncAt: doc.lastVastSyncAt ? new Date(doc.lastVastSyncAt) : null,
    lastProbeAt: doc.lastProbeAt ? new Date(doc.lastProbeAt) : null,
    readyAt: doc.readyAt ? new Date(doc.readyAt) : null,
    probes: Array.isArray(doc.probes) ? doc.probes.slice(-PROBE_HISTORY) : [],
  }
}
