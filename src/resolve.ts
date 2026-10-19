import { vastApiKey } from "./config.js"
import { getTemplate, listInstancesForTag, setProbe } from "./db.js"
import { probeUrl } from "./probe.js"
import { TAGS, effectiveHealthPath, hostPortFor, instanceRoot, isServing, isTag, urlSuffix, type Tag } from "./policy.js"
import { showInstance } from "./vast.js"

export type ResolvedEndpoint = {
  tag: Tag
  ip: string
  port: number
  baseUrl: string
}

/** One ready endpoint for every tag that has one. Tags with nothing ready are omitted. */
export async function resolveAll(): Promise<ResolvedEndpoint[]> {
  const found: ResolvedEndpoint[] = []
  for (const tag of TAGS) {
    const hit = await resolveTag(tag)
    if (hit) found.push(hit)
  }
  return found
}

export async function resolveTag(rawTag: string): Promise<ResolvedEndpoint | null> {
  if (!isTag(rawTag)) return null
  const instances = await listInstancesForTag(rawTag)
  const ready = instances
    .filter(instance => isServing(instance.probeStatus) && instance.publicIp && instance.hostPort != null)
    .sort((a, b) => Number(b.probeStatus === "ready") - Number(a.probeStatus === "ready"))
  for (const instance of ready) {
    const template = instance.templateHashId ? await getTemplate(instance.templateHashId) : null
    if (!template || !instance.publicIp || instance.hostPort == null) continue
    const hit = await confirm(instance.vastInstanceId, instance.publicIp, instance.hostPort, rawTag, template.healthPath)
    if (hit) return { tag: rawTag, ...hit }
    const refreshed = await refreshFromVast(instance.vastInstanceId, template.containerPort ?? template.detectedPort, rawTag)
    if (!refreshed) continue
    const again = await confirm(instance.vastInstanceId, refreshed.ip, refreshed.port, rawTag, template.healthPath)
    if (again) return { tag: rawTag, ...again }
  }
  return null
}

async function confirm(
  id: number,
  ip: string,
  port: number,
  tag: Tag | null,
  healthOverride: string | null,
): Promise<{ ip: string; port: number; baseUrl: string } | null> {
  const root = instanceRoot(ip, port)
  const status = await probeUrl(root + effectiveHealthPath(tag, healthOverride))
  const baseUrl = root + urlSuffix(tag)
  await setProbe(id, status, { publicIp: ip, hostPort: port, baseUrl })
  return isServing(status) ? { ip, port, baseUrl } : null
}

async function refreshFromVast(
  id: number,
  containerPort: number | null,
  tag: Tag | null,
): Promise<{ ip: string; port: number } | null> {
  const apiKey = vastApiKey()
  if (!apiKey || containerPort == null) return null
  try {
    const remote = await showInstance(apiKey, id)
    if (!remote?.publicIp) return null
    const port = hostPortFor(remote.ports, containerPort)
    if (port == null) return null
    return { ip: remote.publicIp, port }
  } catch (err) {
    console.error(`[resolve] refresh ${id} (${tag ?? "untagged"}) failed`, err)
    return null
  }
}
