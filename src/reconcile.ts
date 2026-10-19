import { requireVastApiKey } from "./config.js"
import {
  activeBlacklistedMachineIds,
  addPendingLaunch,
  blacklistMachine,
  countPending,
  deleteInstance,
  deleteInstancesExcept,
  deletePendingExcept,
  listInstances,
  listTemplates,
  setProbe,
  sweepPending,
  upsertInstance,
  upsertTemplateSeen,
  type InstanceRow,
  type TemplateRow,
} from "./db.js"
import { probeUrl } from "./probe.js"
import {
  buildSearchBody,
  detectContainerPort,
  bestProbe,
  burstStillWaiting,
  hostPortFor,
  instanceRoot,
  compareMetrics,
  isBetter,
  isServing,
  metricsFrom,
  occupiesSlot,
  optimizationPlan,
  priceSearchPlan,
  probePaths,
  shouldDestroy,
  stillStarting,
  stopRank,
  type MetricMap,
  type OptimizeGoal,
  type ProbeStatus,
  type Criteria,
} from "./policy.js"
import {
  createInstance,
  destroyInstance,
  VastError,
  listInstances as listVastInstances,
  listOwnTemplates,
  searchOffers,
  stopInstance,
  type VastInstance,
} from "./vast.js"

const log = (message: string) => console.log(`[pool] ${message}`)

/** Read Vast instances into the database. Does not rent, stop, or destroy, and does not refresh templates. */
export async function refreshSnapshot(apiKey: string): Promise<void> {
  const templates = await listTemplates()
  await syncInstances(apiKey, templates)
}

export async function reconcile(): Promise<void> {
  const apiKey = requireVastApiKey()
  const templates = await listTemplates()
  const instances = await syncInstances(apiKey, templates)
  await destroyStuck(apiKey, instances, templates)
  const fresh = await listInstances()
  await pingRunning(fresh, templates)
  const afterPing = await listInstances()
  await stopExtras(apiKey, templates, afterPing)
  await rentShortfalls(apiKey, templates, afterPing)
}

export async function syncTemplates(apiKey: string): Promise<TemplateRow[]> {
  const remote = await listOwnTemplates(apiKey)
  for (const template of remote) {
    await upsertTemplateSeen({
      hashId: template.hashId,
      vastId: template.vastId,
      name: template.name,
      image: template.image,
      recommendedDisk: template.recommendedDisk,
      detectedPort: detectContainerPort(template.env),
      extraFilters: template.extraFilters,
    })
  }
  log(`synced ${remote.length} template(s)`)
  return listTemplates()
}

async function syncInstances(apiKey: string, templates: TemplateRow[]): Promise<InstanceRow[]> {
  const active = templates.filter(template => template.active)
  await deletePendingExcept(active.map(template => template.hashId))
  if (active.length === 0) {
    await deleteInstancesExcept([])
    log(`no active templates, skipped instance sync`)
    return []
  }
  const known = new Set(active.map(template => template.hashId))
  const byHash = new Map(active.map(template => [template.hashId, template]))
  const remote = await listVastInstances(apiKey)
  const kept: number[] = []
  for (const instance of remote) {
    if (!instance.templateHashId || !known.has(instance.templateHashId)) continue
    const template = byHash.get(instance.templateHashId) ?? null
    const endpoint = endpointFor(instance, template)
    const starting = instance.actualStatus == null || instance.actualStatus === "loading" || instance.actualStatus === "rebooting"
    await upsertInstance({
      vastInstanceId: instance.id,
      templateHashId: instance.templateHashId,
      publicIp: endpoint?.ip ?? instance.publicIp,
      hostPort: endpoint?.port ?? null,
      baseUrl: endpoint?.baseUrl ?? null,
      actualStatus: instance.actualStatus,
      intendedStatus: instance.intendedStatus,
      statusMsg: instance.statusMsg,
      gpuName: instance.gpuName,
      dphTotal: instance.dphTotal,
      label: instance.label,
      startDate: instance.startDate,
      machineId: instance.machineId,
      metrics: instance.metrics,
      probeStatus: starting ? "starting" : null,
    })
    kept.push(instance.id)
  }
  await deleteInstancesExcept(kept)
  await sweepPending()
  log(`synced ${kept.length} instance(s)`)
  return listInstances()
}

async function destroyStuck(apiKey: string, instances: InstanceRow[], templates: TemplateRow[]): Promise<void> {
  const now = Date.now()
  const byHash = new Map(templates.map(template => [template.hashId, template]))
  for (const instance of instances) {
    if (instance.intendedStatus === "stopped") {
      try {
        await destroyInstance(apiKey, instance.vastInstanceId)
        await deleteInstance(instance.vastInstanceId)
        log(`removed stopped ${instance.vastInstanceId} without blacklist`)
      } catch (err) {
        console.error(`[worker] remove stopped ${instance.vastInstanceId} failed`, err)
      }
      continue
    }
    if (!shouldDestroy(instance.actualStatus, ageMs(instance, now), instance.intendedStatus)) continue
    try {
      await destroyInstance(apiKey, instance.vastInstanceId)
      await deleteInstance(instance.vastInstanceId)
      const reason = instance.actualStatus ?? "provisioning"
      log(`destroyed ${instance.vastInstanceId} (${reason})`)
      if (instance.machineId == null) {
        log(`instance ${instance.vastInstanceId} had no machine id, so it was not blacklisted`)
      } else {
        try {
          const template = instance.templateHashId ? byHash.get(instance.templateHashId) : undefined
          const ban = await blacklistMachine(instance.machineId, reason, {
            templateHashId: instance.templateHashId,
            templateName: template?.name ?? null,
            tags: template?.tags ?? [],
            gpuName: instance.gpuName,
            dphTotal: instance.dphTotal,
            metrics: instance.metrics,
          })
          log(`blacklisted machine ${instance.machineId} for ${ban.strikes} week(s), until ${ban.bannedUntil.toISOString()}`)
        } catch (err) {
          console.error(`[worker] blacklist machine ${instance.machineId} failed`, err)
        }
      }
    } catch (err) {
      console.error(`[worker] destroy ${instance.vastInstanceId} failed`, err)
    }
  }
}

async function pingRunning(instances: InstanceRow[], templates: TemplateRow[]): Promise<void> {
  const byHash = new Map(templates.map(template => [template.hashId, template]))
  for (const instance of instances) {
    if (instance.actualStatus !== "running") continue
    const template = instance.templateHashId ? byHash.get(instance.templateHashId) ?? null : null
    if (!instance.publicIp || instance.hostPort == null || !template?.active) continue
    const root = instanceRoot(instance.publicIp, instance.hostPort)
    const statuses: ProbeStatus[] = []
    for (const path of probePaths(template.tags, template.healthPath)) {
      statuses.push(await probeUrl(root + path))
    }
    const status = bestProbe(statuses)
    await setProbe(instance.vastInstanceId, status, null)
    log(`probe ${instance.vastInstanceId} ${status}`)
  }
}

async function stopExtras(apiKey: string, templates: TemplateRow[], instances: InstanceRow[]): Promise<void> {
  for (const template of templates) {
    if (!template.active) continue
    const mine = instances.filter(instance => instance.templateHashId === template.hashId)
    const held = mine.filter(instance => occupiesSlot(instance.actualStatus))
    const pending = await countPending(template.hashId, mine.map(instance => instance.vastInstanceId))
    const excess = held.length + pending - template.desiredCount
    if (excess <= 0) continue
    const now = Date.now()
    if (template.burst > template.desiredCount) {
      const waiting = pending > 0 || held.some(instance => burstStillWaiting(instance.actualStatus, instance.probeStatus, ageMs(instance, now)))
      if (waiting) continue
      const keep = new Set(
        held
          .filter(instance => instance.actualStatus === "running" && isServing(instance.probeStatus))
          .sort((a, b) => burstKeepOrder(a, b, template.optimize))
          .slice(0, template.desiredCount)
          .map(instance => instance.vastInstanceId),
      )
      for (const instance of held.filter(instance => instance.actualStatus === "running" && !keep.has(instance.vastInstanceId))) {
        try {
          await stopInstance(apiKey, instance.vastInstanceId)
          log(`stopped burst extra ${instance.vastInstanceId}`)
        } catch (err) {
          console.error(`[worker] stop ${instance.vastInstanceId} failed`, err)
        }
      }
      continue
    }
    const overlap = template.desiredCount > 0 && template.optimize.length > 0 && template.optimizeTrials > 0
    if (overlap && (pending > 0 || held.some(instance => stillStarting(instance.actualStatus, instance.probeStatus)))) {
      continue
    }
    const running = held
      .filter(instance => instance.actualStatus === "running")
      .sort((a, b) => overlap
        ? worseFirst(a, b, template.optimize)
        : stopRank(a.probeStatus) - stopRank(b.probeStatus) || b.vastInstanceId - a.vastInstanceId)
    for (const instance of running.slice(0, excess)) {
      try {
        await stopInstance(apiKey, instance.vastInstanceId)
        log(`stopped extra ${instance.vastInstanceId}`)
      } catch (err) {
        console.error(`[worker] stop ${instance.vastInstanceId} failed`, err)
      }
    }
  }
}

async function rentShortfalls(apiKey: string, templates: TemplateRow[], instances: InstanceRow[]): Promise<void> {
  for (const template of templates) {
    if (!template.active) continue
    if (template.desiredCount <= 0 || template.diskGb == null || template.diskGb <= 0) continue
    if (template.priceMin == null || template.priceStep == null || template.priceLoops == null || template.priceMax == null) {
      continue
    }
    const mine = instances.filter(instance => instance.templateHashId === template.hashId)
    const occupying = mine.filter(instance => occupiesSlot(instance.actualStatus)).length + await countPending(template.hashId, mine.map(instance => instance.vastInstanceId))
    const search = {
      min: template.priceMin,
      step: template.priceStep,
      loops: template.priceLoops,
      max: template.priceMax,
    }
    const banned = await activeBlacklistedMachineIds()
    const named = template.name ?? template.hashId
    const ready = mine.filter(instance => occupiesSlot(instance.actualStatus) && isServing(instance.probeStatus)).length
    const burstCap = Math.max(template.desiredCount, template.burst)
    const now = Date.now()
    const burstWaiting = template.burst > template.desiredCount && (
      occupying > template.desiredCount
      || mine.some(instance => burstStillWaiting(instance.actualStatus, instance.probeStatus, ageMs(instance, now)))
    )
    if (template.burst > 0 && ready < template.desiredCount && occupying < burstCap) {
      const plan = priceSearchPlan(search)
      if (plan.length === 0) continue
      const taken = new Set<number>()
      let rented = false
      for (let n = occupying; n < burstCap; n++) {
        const hit = await rentFirstOffer(apiKey, template, plan, banned, null, taken)
        if (!hit) break
        rented = true
      }
      if (!rented) log(`left ${named} short of ${template.desiredCount} healthy`)
      continue
    }
    if (burstWaiting) continue
    if (ready < template.desiredCount && template.burst > 0) continue
    if (occupying < template.desiredCount) {
      const plan = priceSearchPlan(search)
      if (plan.length === 0) continue
      const rented = await rentFirstOffer(apiKey, template, plan, banned, null)
      if (!rented) log(`left ${named} short`)
      continue
    }
    const trialSlots = template.optimizeTrials
    if (template.optimize.length === 0 || trialSlots <= 0 || occupying >= template.desiredCount + trialSlots) continue
    const worst = worstHeld(mine, template.optimize)
    if (!worst) continue
    const plan = optimizationPlan(search, worst.metrics, template.optimize)
    if (plan.length === 0) continue
    log(`optimizing ${named} against instance ${worst.vastInstanceId}`)
    const rented = await rentFirstOffer(apiKey, template, plan, banned, worst.metrics)
    if (!rented) log(`no better offer for ${named}`)
  }
}

async function rentFirstOffer(
  apiKey: string,
  template: TemplateRow,
  plan: number[],
  banned: Set<number>,
  incumbent: MetricMap | null,
  taken: Set<number> = new Set(),
): Promise<boolean> {
  const named = template.name ?? template.hashId
  let attempt = 0
  let previousCeiling: number | null = null
  for (const ceiling of plan) {
    attempt = ceiling === previousCeiling ? attempt + 1 : 1
    previousCeiling = ceiling
    const query = buildSearchBody({
      ceiling,
      diskGb: template.diskGb ?? 0,
      criteria: template.criteria ?? {},
      extraFilters: template.extraFilters,
    })
    let offers: Array<Record<string, unknown>> = []
    try {
      offers = await searchOffers(apiKey, query)
    } catch (err) {
      console.error(`[worker] search ${template.hashId} at $${ceiling} failed`, err)
      return false
    }
    const candidates = offers.filter(row => offerId(row) != null)
    const blocked = candidates.filter(row => {
      const machine = offerMachineId(row)
      return machine != null && banned.has(machine)
    }).length
    const ranked = candidates
      .filter(row => {
        const id = offerId(row)
        if (id != null && taken.has(id)) return false
        const machine = offerMachineId(row)
        return machine == null || !banned.has(machine)
      })
      .sort((a, b) => compareMetrics(metricsFrom(a), metricsFrom(b), template.optimize))
    for (const offer of ranked) {
      if (incumbent != null && !isBetter(metricsFrom(offer), incumbent, template.optimize)) continue
      const id = offerId(offer)!
      try {
        const contractId = await createInstance(apiKey, id, {
          templateHashId: template.hashId,
          diskGb: template.diskGb ?? 0,
          label: (template.tags.join(",") || template.name || template.hashId).slice(0, 1024),
        })
        if (contractId != null) await addPendingLaunch(template.hashId, contractId)
        taken.add(id)
        const machine = offerMachineId(offer)
        if (machine != null) banned.add(machine)
        log(`rented offer ${id} for ${named} at <= $${ceiling}`)
        return true
      } catch (err) {
        taken.add(id)
        const machine = offerMachineId(offer)
        if (machine != null) banned.add(machine)
        if (err instanceof VastError && err.status === 400) {
          log(`offer ${id} already gone, trying the next`)
          continue
        }
        console.error(`[worker] create from offer ${id} failed`, err)
        return false
      }
    }
    const why = incumbent ? "no better offer" : blocked > 0 ? "only blacklisted machines" : "no offer"
    log(`${why} for ${named} at <= $${ceiling} (${attempt}/${template.priceLoops})`)
  }
  return false
}

function endpointFor(instance: VastInstance, template: TemplateRow | null): { ip: string; port: number; baseUrl: string } | null {
  if (!instance.publicIp || !template) return null
  const containerPort = template.containerPort ?? template.detectedPort
  if (containerPort == null) return null
  const port = hostPortFor(instance.ports, containerPort)
  if (port == null) return null
  return {
    ip: instance.publicIp,
    port,
    baseUrl: instanceRoot(instance.publicIp, port),
  }
}

function ageMs(instance: InstanceRow, now: number): number {
  if (instance.startDate != null) return now - instance.startDate * 1000
  return now - instance.firstSeenAt.getTime()
}

function offerId(offer: Record<string, unknown>): number | null {
  const raw = offer.id ?? offer.ask_contract_id
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

function offerMachineId(offer: Record<string, unknown>): number | null {
  const raw = offer.machine_id
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

function worstHeld(instances: InstanceRow[], goals: OptimizeGoal[]): InstanceRow | null {
  const held = instances.filter(instance => occupiesSlot(instance.actualStatus))
  return [...held].sort((a, b) => worseFirst(a, b, goals))[0] ?? null
}

function burstKeepOrder(a: InstanceRow, b: InstanceRow, goals: OptimizeGoal[]): number {
  if (goals.length > 0) {
    const ranked = compareMetrics(a.metrics, b.metrics, goals)
    if (ranked !== 0) return ranked
  }
  const aLoaded = (a.readyAt ?? a.firstSeenAt).getTime()
  const bLoaded = (b.readyAt ?? b.firstSeenAt).getTime()
  return aLoaded - bLoaded || a.vastInstanceId - b.vastInstanceId
}

function worseFirst(a: InstanceRow, b: InstanceRow, goals: OptimizeGoal[]): number {
  const aReady = isServing(a.probeStatus) ? 1 : 0
  const bReady = isServing(b.probeStatus) ? 1 : 0
  if (aReady !== bReady) return aReady - bReady
  return compareMetrics(b.metrics, a.metrics, goals)
}

export function emptyCriteria(): Criteria {
  return { verified: true }
}
