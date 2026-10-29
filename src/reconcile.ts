import { requireVastApiKey } from "./config.js"
import {
  activeBlacklistedMachineIds,
  addPendingLaunch,
  blacklistMachine,
  countPending,
  deleteInstance,
  recordInstanceEvent,
  deleteInstancesExcept,
  deletePendingExcept,
  listInstances,
  listTemplates,
  setProbe,
  setSpeed,
  sweepPending,
  upsertInstance,
  upsertTemplateSeen,
  type InstanceAction,
  type InstanceRow,
  type TemplateRow,
} from "./db.js"
import { probeUrl } from "./probe.js"
import { measureTextSpeed } from "./speed.js"
import {
  buildSearchBody,
  detectContainerPort,
  bestProbe,
  blacklistFailedLoad,
  burstRentCount,
  burstStillWaiting,
  countsAsWorking,
  fillsDesiredSlot,
  hostPortFor,
  instanceRoot,
  compareMetrics,
  isBetter,
  isServing,
  isTextTag,
  metricsFrom,
  occupiesSlot,
  optimizationPlan,
  priceSearchPlan,
  probePaths,
  shouldDestroy,
  stillStarting,
  stopRank,
  textSpeedDue,
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
  await measureReadyText(afterPing, templates)
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
    const age = ageMs(instance, now)
    const failedLoad = blacklistFailedLoad(
      instance.actualStatus,
      instance.probeStatus,
      age,
      instance.readyAt != null,
      instance.intendedStatus,
    )
    if (instance.intendedStatus === "stopped" && !failedLoad) {
      try {
        await destroyInstance(apiKey, instance.vastInstanceId)
        await deleteInstance(instance.vastInstanceId)
        log(`removed stopped ${instance.vastInstanceId} without blacklist`)
        await note(instance, byHash, "release", "removed stopped contract")
      } catch (err) {
        console.error(`[worker] remove stopped ${instance.vastInstanceId} failed`, err)
      }
      continue
    }
    if (!failedLoad && !shouldDestroy(instance.actualStatus, age, instance.intendedStatus)) continue
    try {
      await destroyInstance(apiKey, instance.vastInstanceId)
      await deleteInstance(instance.vastInstanceId)
      const reason = failedLoad && !shouldDestroy(instance.actualStatus, age, instance.intendedStatus)
        ? "unhealthy"
        : instance.actualStatus ?? "provisioning"
      log(`destroyed ${instance.vastInstanceId} (${reason})`)
      await note(instance, byHash, "release", `destroyed (${reason})`)
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
          await note(instance, byHash, "ban", `${reason}, ${ban.strikes} week ban until ${ban.bannedUntil.toISOString()}`)
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

async function measureReadyText(instances: InstanceRow[], templates: TemplateRow[]): Promise<void> {
  const byHash = new Map(templates.map(template => [template.hashId, template]))
  const now = Date.now()
  for (const instance of instances) {
    if (instance.actualStatus !== "running" || instance.probeStatus !== "ready") continue
    if (!instance.publicIp || instance.hostPort == null) continue
    const template = instance.templateHashId ? byHash.get(instance.templateHashId) : undefined
    if (!template?.active || !template.tags.some(isTextTag)) continue
    if (!textSpeedDue(instance.speedAt?.getTime() ?? null, now)) continue
    const root = instanceRoot(instance.publicIp, instance.hostPort)
    try {
      const result = await measureTextSpeed(root)
      if (result.kind === "loading") {
        log(`speed ${instance.vastInstanceId} waiting for models`)
        continue
      }
      await setSpeed(instance.vastInstanceId, {
        tokensPerSec: result.tokensPerSec,
        model: result.model,
        error: result.error,
      })
      log(result.error
        ? `speed ${instance.vastInstanceId} failed (${result.error})`
        : `speed ${instance.vastInstanceId} ${result.tokensPerSec?.toFixed(1)} tok/s${result.model ? ` ${result.model}` : ""}`)
    } catch (err) {
      console.error(`[worker] speed ${instance.vastInstanceId} failed`, err)
      try {
        await setSpeed(instance.vastInstanceId, {
          tokensPerSec: null,
          model: null,
          error: err instanceof Error && err.message ? err.message : "speed check failed",
        })
      } catch (storeErr) {
        console.error(`[worker] store speed ${instance.vastInstanceId} failed`, storeErr)
      }
    }
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
      const waiting = pending > 0 || held.some(instance => burstStillWaiting(instance.actualStatus, instance.probeStatus, ageMs(instance, now), countsAsWorking(instance.readyAt)))
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
          await note(instance, new Map([[template.hashId, template]]), "release", "stopped burst extra")
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
        await note(instance, new Map([[template.hashId, template]]), "release", "stopped extra")
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
    const pending = await countPending(template.hashId, mine.map(instance => instance.vastInstanceId))
    const occupying = mine.filter(instance => occupiesSlot(instance.actualStatus)).length + pending
    const runningSlots = mine.filter(instance => fillsDesiredSlot(instance.actualStatus, instance.readyAt)).length + pending
    const search = {
      min: template.priceMin,
      step: template.priceStep,
      loops: template.priceLoops,
      max: template.priceMax,
    }
    const banned = await activeBlacklistedMachineIds()
    const named = template.name ?? template.hashId
    const working = mine.filter(instance => occupiesSlot(instance.actualStatus) && countsAsWorking(instance.readyAt)).length
    const now = Date.now()
    const burstWaiting = template.burst > template.desiredCount && (
      occupying > template.desiredCount
      || mine.some(instance => burstStillWaiting(instance.actualStatus, instance.probeStatus, ageMs(instance, now), countsAsWorking(instance.readyAt)))
    )
    const burstRent = burstRentCount(working, template.desiredCount, template.burst, occupying)
    if (burstRent != null) {
      if (burstRent > 0) {
        const plan = priceSearchPlan(search)
        if (plan.length === 0) continue
        const taken = new Set<number>()
        let rented = false
        for (let n = 0; n < burstRent; n++) {
          const hit = await rentFirstOffer(apiKey, template, plan, banned, null, taken, "burst until one comes ready")
          if (!hit) break
          rented = true
        }
        if (!rented) log(`left ${named} short of ${template.desiredCount} healthy`)
      }
      continue
    }
    if (burstWaiting) continue
    if (runningSlots < template.desiredCount) {
      const plan = priceSearchPlan(search)
      if (plan.length === 0) continue
      const rented = await rentFirstOffer(apiKey, template, plan, banned, null, new Set(), "below desired count")
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
    const rented = await rentFirstOffer(apiKey, template, plan, banned, worst.metrics, new Set(), `optimize against ${worst.vastInstanceId}`)
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
  reason = "rent",
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
        await note(
          { vastInstanceId: contractId, machineId: machine, templateHashId: template.hashId },
          new Map([[template.hashId, template]]),
          "rent",
          `${reason}, offer ${id} at <= $${ceiling}`,
        )
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

async function note(
  instance: { vastInstanceId: number | null; machineId: number | null; templateHashId: string | null },
  byHash: Map<string, TemplateRow>,
  action: InstanceAction,
  reason: string,
): Promise<void> {
  const template = instance.templateHashId ? byHash.get(instance.templateHashId) : undefined
  try {
    await recordInstanceEvent({
      action,
      vastInstanceId: instance.vastInstanceId,
      machineId: instance.machineId,
      templateHashId: instance.templateHashId,
      templateName: template?.name ?? null,
      reason,
    })
  } catch (err) {
    console.error(`[worker] record ${action} failed`, err)
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
