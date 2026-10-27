import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { clearSessionCookie, ensureOperator, login, logout, operatorIdFromRequest, sessionCookie } from "./auth.js"
import { resolveToken, port, vastApiKey } from "./config.js"
import { blacklistMachine, deleteInstance, getTemplate, listBlacklist, listInstanceEvents, listInstances, listMachineEvents, listTemplates, recordInstanceEvent, saveTemplateSettings, unbanMachine } from "./db.js"
import { upstashUsage } from "./upstash-usage.js"
import { optionalNumber, parseCriteria, parseOptimize, renderApp, renderLogin, snapshotParts, usageText } from "./operator/page.js"
import { isTag } from "./policy.js"
import { refreshSnapshot, syncTemplates } from "./reconcile.js"
import { resolveAll, resolveTag } from "./resolve.js"
import { destroyInstance } from "./vast.js"

const server = createServer((req, res) => {
  void handle(req, res).catch(err => {
    console.error(err)
    send(res, 500, "text/plain", "Internal error")
  })
})

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (req.method === "GET" && url.pathname === "/healthz") {
    send(res, 200, "text/plain", "ok")
    return
  }
  if (req.method === "GET" && url.pathname === "/resolve") {
    await handleResolve(req, res, url)
    return
  }
  if (req.method === "GET" && url.pathname === "/login") {
    send(res, 200, "text/html; charset=utf-8", renderLogin(""))
    return
  }
  if (req.method === "POST" && url.pathname === "/login") {
    const form = await readForm(req)
    const token = await login(form.get("username") ?? "", form.get("password") ?? "")
    if (!token) {
      send(res, 401, "text/html; charset=utf-8", renderLogin("Unknown username or password."))
      return
    }
    res.setHeader("Set-Cookie", sessionCookie(token))
    redirect(res, "/")
    return
  }
  if (req.method === "POST" && url.pathname === "/logout") {
    await logout(req.headers.cookie)
    res.setHeader("Set-Cookie", clearSessionCookie())
    redirect(res, "/login")
    return
  }

  const operatorId = await operatorIdFromRequest(req.headers.cookie)
  if (!operatorId) {
    redirect(res, "/login")
    return
  }

  if (req.method === "GET" && url.pathname === "/") {
    const [templates, instances, blacklist] = await Promise.all([listTemplates(), listInstances(), listBlacklist()])
    const unbanned = url.searchParams.get("unbanned")
    const banned = url.searchParams.get("banned")
    const ban = url.searchParams.get("ban")
    const sync = url.searchParams.get("sync")
    const notice = unbanned
      ? `Unbanned machine ${unbanned}.`
      : banned
        ? `Banned machine ${banned}.`
        : ban === "failed"
          ? "Could not destroy the instance, so it was not banned."
          : ban === "keep"
            ? "Destroyed the instance, but the machine was not banned."
            : ban === "missing"
              ? "VAST_API_KEY is not set."
              : ban === "unknown"
                ? "That instance is no longer rented."
                : sync === "ok"
                  ? "Synced templates."
                  : sync === "missing"
                    ? "VAST_API_KEY is not set."
                    : sync === "failed"
                      ? "Template sync failed."
                      : url.searchParams.get("saved")
                        ? "Saved."
                        : ""
    send(res, 200, "text/html; charset=utf-8", renderApp(templates, instances, blacklist, notice))
    return
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const usage = await upstashUsage()
    send(res, 200, "application/json", JSON.stringify({ text: usageText(usage) }))
    return
  }

  if (req.method === "GET" && url.pathname === "/api/sync") {
    const key = vastApiKey()
    if (key) {
      try {
        await refreshSnapshot(key)
      } catch (err) {
        console.error("[web] vast sync failed", err)
        send(res, 200, "application/json", JSON.stringify({ ok: false, error: "Vast check failed." }))
        return
      }
    }
    const [templates, instances, blacklist] = await Promise.all([listTemplates(), listInstances(), listBlacklist()])
    send(res, 200, "application/json", JSON.stringify({ ok: true, ...snapshotParts(templates, instances, blacklist) }))
    return
  }

  if (req.method === "POST" && url.pathname === "/templates/sync") {
    const key = vastApiKey()
    if (!key) {
      redirect(res, "/?sync=missing")
      return
    }
    try {
      await syncTemplates(key)
    } catch (err) {
      console.error("[web] template sync failed", err)
      redirect(res, "/?sync=failed")
      return
    }
    redirect(res, "/?sync=ok")
    return
  }

  const logMatch = /^\/api\/instances\/(\d+)\/log$/.exec(url.pathname)
  if (req.method === "GET" && logMatch) {
    const vastInstanceId = Number(logMatch[1])
    const instance = (await listInstances()).find(row => row.vastInstanceId === vastInstanceId)
    if (!instance) {
      send(res, 404, "application/json", JSON.stringify({ error: "instance not found" }))
      return
    }
    const events = await listInstanceEvents(instance.vastInstanceId, instance.machineId)
    send(res, 200, "application/json", JSON.stringify({
      vastInstanceId: instance.vastInstanceId,
      machineId: instance.machineId,
      probes: instance.probes,
      events,
    }))
    return
  }

  const machineLogMatch = /^\/api\/machines\/(\d+)\/log$/.exec(url.pathname)
  if (req.method === "GET" && machineLogMatch) {
    const machineId = Number(machineLogMatch[1])
    const instance = (await listInstances()).find(row => row.machineId === machineId) ?? null
    const events = await listMachineEvents(machineId)
    send(res, 200, "application/json", JSON.stringify({
      vastInstanceId: instance?.vastInstanceId ?? null,
      machineId,
      probes: instance?.probes ?? [],
      events,
    }))
    return
  }

  const banMatch = /^\/instances\/(\d+)\/ban$/.exec(url.pathname)
  if (req.method === "POST" && banMatch) {
    await handleBan(res, Number(banMatch[1]))
    return
  }

  const unbanMatch = /^\/blacklist\/(\d+)\/unban$/.exec(url.pathname)
  if (req.method === "POST" && unbanMatch) {
    const machineId = Number(unbanMatch[1])
    await unbanMachine(machineId)
    try {
      await recordInstanceEvent({
        action: "unban",
        vastInstanceId: null,
        machineId,
        templateHashId: null,
        templateName: null,
        reason: "operator unban",
      })
    } catch (err) {
      console.error("[web] record unban failed", err)
    }
    redirect(res, `/?unbanned=${unbanMatch[1]}`)
    return
  }

  const templateMatch = /^\/templates\/([^/]+)$/.exec(url.pathname)
  if (req.method === "POST" && templateMatch) {
    const hashId = decodeURIComponent(templateMatch[1] ?? "")
    const form = await readForm(req)
    const tags = form.getAll("tag").filter(isTag)
    const count = optionalNumber(form.get("desired_count"))
    const loops = optionalNumber(form.get("price_loops"))
    const containerPort = optionalNumber(form.get("container_port"))
    await saveTemplateSettings(hashId, {
      desiredCount: count == null ? 0 : Math.max(0, Math.round(count)),
      tags,
      priceMin: optionalNumber(form.get("price_min")),
      priceStep: optionalNumber(form.get("price_step")),
      priceLoops: loops == null ? null : Math.max(1, Math.round(loops)),
      priceMax: optionalNumber(form.get("price_max")),
      diskGb: optionalNumber(form.get("disk_gb")),
      criteria: parseCriteria(form),
      containerPort: containerPort == null ? null : Math.round(containerPort),
      healthPath: form.get("health_path")?.trim() || null,
      optimize: parseOptimize(form),
      optimizeTrials: Math.max(0, Math.round(optionalNumber(form.get("optimize_trials")) ?? 0)),
      burst: Math.max(0, Math.round(optionalNumber(form.get("burst")) ?? 0)),
      active: form.get("active") === "1",
    })
    redirect(res, "/?saved=1")
    return
  }

  send(res, 404, "text/plain", "Not found")
}

async function handleBan(res: ServerResponse, vastInstanceId: number): Promise<void> {
  const instance = (await listInstances()).find(row => row.vastInstanceId === vastInstanceId)
  if (!instance || instance.machineId == null) {
    redirect(res, "/?ban=unknown")
    return
  }
  const key = vastApiKey()
  if (!key) {
    redirect(res, "/?ban=missing")
    return
  }
  try {
    await destroyInstance(key, vastInstanceId)
  } catch (err) {
    console.error(`[web] destroy ${vastInstanceId} for ban failed`, err)
    redirect(res, "/?ban=failed")
    return
  }
  await deleteInstance(vastInstanceId)
  const template = instance.templateHashId ? await getTemplate(instance.templateHashId) : null
  const machineId = instance.machineId
  try {
    await recordInstanceEvent({
      action: "release",
      vastInstanceId,
      machineId,
      templateHashId: instance.templateHashId,
      templateName: template?.name ?? null,
      reason: "destroyed (operator ban)",
    })
  } catch (err) {
    console.error("[web] record operator release failed", err)
  }
  try {
    const ban = await blacklistMachine(machineId, "operator ban", {
      templateHashId: instance.templateHashId,
      templateName: template?.name ?? null,
      tags: template?.tags ?? [],
      gpuName: instance.gpuName,
      dphTotal: instance.dphTotal,
      metrics: instance.metrics,
    })
    await recordInstanceEvent({
      action: "ban",
      vastInstanceId,
      machineId,
      templateHashId: instance.templateHashId,
      templateName: template?.name ?? null,
      reason: `operator ban, ${ban.strikes} week ban until ${ban.bannedUntil.toISOString()}`,
    })
  } catch (err) {
    console.error(`[web] blacklist machine ${machineId} failed`, err)
    redirect(res, "/?ban=keep")
    return
  }
  redirect(res, `/?banned=${machineId}`)
}

async function handleResolve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authorized(req)) {
    send(res, 401, "application/json", JSON.stringify({ error: "unauthorized" }))
    return
  }
  const tag = url.searchParams.get("tag") ?? url.searchParams.get("role") ?? ""
  if (!tag) {
    const endpoints = await resolveAll()
    send(res, 200, "application/json", JSON.stringify(endpoints))
    return
  }
  if (!isTag(tag)) {
    send(res, 400, "application/json", JSON.stringify({ error: "unknown tag" }))
    return
  }
  const endpoint = await resolveTag(tag)
  if (!endpoint) {
    send(res, 503, "application/json", JSON.stringify({ error: "no ready instance", tag }))
    return
  }
  send(res, 200, "application/json", JSON.stringify(endpoint))
}

function authorized(req: IncomingMessage): boolean {
  const expected = resolveToken()
  if (!expected) return false
  const header = req.headers.authorization ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(Buffer.from(chunk)))
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))))
    req.on("error", reject)
  })
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type })
  res.end(body)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location })
  res.end()
}

await ensureOperator()
server.listen(port(), "0.0.0.0", () => {
  console.log(`[web] listening on :${port()}`)
})
