import type { BlacklistRow, InstanceRow, TemplateRow } from "../db.js"
import type { UpstashUsage } from "../upstash-usage.js"
import {
  OPTIMIZE_FIELD_LABELS,
  OPTIMIZE_FIELDS,
  OPTIMIZE_SLOTS,
  TAGS,
  isOptimizeField,
  type Criteria,
  type OptimizeGoal,
  type Tag,
} from "../policy.js"

export function renderLogin(error: string): string {
  return layout("Sign in", `
    <form method="post" action="/login" class="card narrow">
      <h1>GPU pool</h1>
      <p class="muted">Developer sign-in. This is not the Danielle moderator admin.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <label>Username <input name="username" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
  `)
}

export function renderApp(
  templates: TemplateRow[],
  instances: InstanceRow[],
  blacklist: BlacklistRow[],
  notice: string,
): string {
  const parts = snapshotParts(templates, instances, blacklist)
  return layout("GPU pool", `
    <header class="top">
      <div>
        <h1>GPU pool</h1>
        <p class="muted">Templates from this Vast account. The worker rents and pings. This page only saves settings.</p>
        <p class="muted status" id="usage"><span class="spin"></span> Checking Upstash…</p>
        <p class="muted status" id="vast"><span class="spin"></span> Checking Vast…</p>
      </div>
      <form method="post" action="/logout"><button type="submit" class="ghost">Sign out</button></form>
    </header>
    ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
    <section id="templates">${parts.templates}</section>
    <section id="rented">${parts.rented}</section>
    <section id="blacklist">${parts.blacklist}</section>
  `, liveChecksScript())
}

export function snapshotParts(
  templates: TemplateRow[],
  instances: InstanceRow[],
  blacklist: BlacklistRow[],
): { templates: string; rented: string; blacklist: string } {
  const byHash = new Map(templates.map(template => [template.hashId, template]))
  return {
    templates: `
      <div class="title">
        <h2>Templates</h2>
        <form method="post" action="/templates/sync"><button type="submit" class="ghost">Sync templates</button></form>
      </div>
      <p class="muted">Templates change rarely, so they are read from Vast only when you sync.</p>
      ${templates.length === 0 ? `<p class="muted">No templates yet.</p>` : ""}
      ${templates.map(template => templateCard(template)).join("")}
    `,
    rented: `
      <h2>Rented</h2>
      ${instances.length === 0 ? `<p class="muted">No instances for these templates.</p>` : rentedTable(instances, byHash)}
    `,
    blacklist: `
      <h2>Blacklist</h2>
      <p class="muted">Global. A machine that fails to load is skipped for every template. The first failure lasts one week, the next two weeks, then three, and the count stays after the ban ends.</p>
      ${blacklist.length === 0 ? `<p class="muted">No machines are blacklisted.</p>` : blacklistTable(blacklist)}
    `,
  }
}

export function usageText(usage: UpstashUsage): string {
  if (usage.requests == null) return usage.note ?? "Upstash usage is unavailable."
  const used = usage.requests.toLocaleString("en-US")
  const cap = usage.quota == null ? "no monthly command cap" : usage.quota.toLocaleString("en-US")
  const plan = usage.plan ? ` · ${usage.plan}` : ""
  return `Upstash this month: ${used} / ${cap} commands${plan}`
}

function liveChecksScript(): string {
  return `<script>
    let dirty = false
    document.addEventListener("focusin", (event) => {
      const target = event.target
      if (target && target.closest && target.closest("form.card")) dirty = true
    }, true)
    const usage = document.getElementById("usage")
    const vast = document.getElementById("vast")
    fetch("/api/usage").then(response => response.json()).then(body => {
      usage.textContent = body.text || "Upstash usage is unavailable."
    }).catch(() => { usage.textContent = "Upstash usage is unavailable." })
    fetch("/api/sync").then(response => response.json()).then(body => {
      if (!body.ok) { vast.textContent = body.error || "Vast check failed."; return }
      if (dirty) { vast.textContent = "Vast updated. Reload to see the latest."; return }
      document.getElementById("templates").innerHTML = body.templates
      document.getElementById("rented").innerHTML = body.rented
      document.getElementById("blacklist").innerHTML = body.blacklist
      vast.textContent = "Vast is up to date."
    }).catch(() => { vast.textContent = "Vast check failed." })
  </script>`
}

function templateCard(template: TemplateRow): string {
  const c = template.criteria ?? {}
  return `
    <form method="post" action="/templates/${esc(template.hashId)}" class="card">
      <div class="title">
        <strong>${esc(template.name ?? "Untitled template")}</strong>
        <label class="check"><input type="checkbox" name="active" value="1"${template.active ? " checked" : ""}> Active</label>
      </div>
      <p class="muted">${esc(template.hashId)}</p>
      <p class="muted">Unchecked templates are left on Vast. The worker does not sync, probe, rent, stop, or destroy them.</p>
      <p class="muted">Vast id ${esc(template.vastId ?? "—")} · image ${esc(template.image ?? "—")} · recommended disk ${esc(template.recommendedDisk ?? "—")} GB · detected port ${esc(template.detectedPort ?? "—")}</p>
      <div class="grid">
        ${numField("desired_count", "Instances", template.desiredCount, "0")}
        ${numField("optimize_trials", "Optimize trials", template.optimizeTrials > 0 ? template.optimizeTrials : null, "")}
        ${numField("burst", "Burst", template.burst > 0 ? template.burst : null, "")}
        <div class="tags">
          <span>Tags</span>
          ${TAGS.map(tag => `<label class="check"><input type="checkbox" name="tag" value="${tag}"${template.tags.includes(tag) ? " checked" : ""}> ${tag}</label>`).join("")}
        </div>
        ${numField("price_min", "Price min $/hr", template.priceMin, "0.10")}
        ${numField("price_step", "Price step $/hr", template.priceStep, "0.05")}
        ${numField("price_loops", "Loops per price", template.priceLoops, "10")}
        ${numField("price_max", "Price max $/hr", template.priceMax, "0.50")}
        ${optimizeFields(template.optimize)}
        ${numField("disk_gb", "Disk GB exact", template.diskGb, "40")}
        ${numField("container_port", "Port override", template.containerPort, String(template.detectedPort ?? ""))}
        <label>Health path
          <input name="health_path" value="${esc(template.healthPath ?? "")}" placeholder="/health or /v1/models">
        </label>
        ${numField("gpu_frac_min", "Min GPU fraction", c.gpuFracMin, "1")}
        ${numField("gpu_mem_bw_min", "Min GPU mem GB/s", c.gpuMemBwMin, "")}
        ${numField("reliability_min", "Min reliability", c.reliabilityMin, "0.99")}
        ${numField("gpu_ram_min", "Min GPU RAM MB", c.gpuRamMin, "")}
        ${numField("num_gpus", "GPU count", c.numGpus, "1")}
        <label>GPU names
          <input name="gpu_names" value="${esc((c.gpuNames ?? []).join(", "))}" placeholder="RTX 4090, RTX 3090">
        </label>
        ${numField("inet_down_min", "Min download MB/s", c.inetDownMin, "")}
        ${numField("inet_up_min", "Min upload MB/s", c.inetUpMin, "")}
        ${numField("direct_port_count_min", "Min direct ports", c.directPortCountMin, "")}
        ${numField("cuda_max_good_min", "Min CUDA", c.cudaMaxGoodMin, "")}
        ${numField("cpu_ram_min", "Min CPU RAM MB", c.cpuRamMin, "")}
        <label>Countries
          <input name="geolocation" value="${esc((c.geolocation ?? []).join(", "))}" placeholder="US, CA">
        </label>
        ${tri("static_ip", "Static IP", c.staticIp)}
        ${tri("datacenter", "Datacenter", c.datacenter)}
        <label class="check">
          <input type="checkbox" name="verified" value="1" ${c.verified === false ? "" : "checked"}>
          Require verified
        </label>
      </div>
      <button type="submit">Save ${esc(template.name ?? "template")}</button>
    </form>
  `
}

function rentedTable(instances: InstanceRow[], byHash: Map<string, TemplateRow>): string {
  const now = Date.now()
  const rows = instances.map(instance => {
    const template = instance.templateHashId ? byHash.get(instance.templateHashId) : undefined
    const age = instance.startDate != null ? now - instance.startDate * 1000 : now - instance.firstSeenAt.getTime()
    return `<tr>
      <td>${instance.vastInstanceId}</td>
      <td>${esc(instance.machineId ?? "—")}</td>
      <td>${esc(template?.name ?? instance.templateHashId ?? "—")}</td>
      <td>${esc(template && template.tags.length > 0 ? template.tags.join(", ") : "—")}</td>
      <td>${esc(instance.gpuName ?? "—")}</td>
      <td>${money(instance.dphTotal, 3)}</td>
      <td>${money(monthlyPrice(instance.dphTotal), 2)}</td>
      <td>${vram(instance.metrics.gpu_ram)}</td>
      <td>${metric(instance.metrics.gpu_frac, 2)}</td>
      <td>${metric(instance.metrics.gpu_mem_bw, 0)}</td>
      <td>${metric(instance.metrics.bw_frac_per_dollar, 0)}</td>
      <td>${esc(instance.publicIp ?? "—")}:${esc(instance.hostPort ?? "—")}</td>
      <td>${esc(instance.actualStatus ?? "provisioning")}</td>
      <td>${esc(instance.intendedStatus ?? "—")}</td>
      <td>${esc(instance.probeStatus ?? "—")}</td>
      <td>${esc(formatAge(age))}</td>
      <td>${esc(instance.lastProbeAt ? instance.lastProbeAt.toISOString() : "—")}</td>
      <td>${esc(instance.statusMsg ?? "")}</td>
    </tr>`
  }).join("")
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Id</th><th>Machine</th><th>Template</th><th>Tag</th><th>GPU</th><th>$/hr</th><th>$/mo</th>
      <th>VRAM</th><th>GPU frac</th><th>Mem GB/s</th><th>BW×frac/$</th><th>Endpoint</th>
      <th>Vast</th><th>Intended</th><th>Probe</th><th>Age</th><th>Last probe</th><th>Message</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function blacklistTable(rows: BlacklistRow[]): string {
  const now = Date.now()
  const body = rows.map(row => {
    const active = row.bannedUntil.getTime() > now
    return `<tr>
      <td>${row.machineId}</td>
      <td>${esc(row.templateName ?? row.templateHashId ?? "—")}</td>
      <td>${esc(row.tags.length > 0 ? row.tags.join(", ") : "—")}</td>
      <td>${esc(row.gpuName ?? "—")}</td>
      <td>${money(row.dphTotal, 3)}</td>
      <td>${money(monthlyPrice(row.dphTotal), 2)}</td>
      <td>${vram(row.metrics.gpu_ram)}</td>
      <td>${metric(row.metrics.gpu_frac, 2)}</td>
      <td>${metric(row.metrics.gpu_mem_bw, 0)}</td>
      <td>${metric(row.metrics.bw_frac_per_dollar, 0)}</td>
      <td>${row.strikes}</td>
      <td>${active ? "banned" : "expired"}</td>
      <td>${esc(row.bannedUntil.toISOString())}</td>
      <td>${esc(row.reason ?? "—")}</td>
      <td>
        <form method="post" action="/blacklist/${row.machineId}/unban">
          <button type="submit" class="ghost">Unban</button>
        </form>
      </td>
    </tr>`
  }).join("")
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Machine</th><th>Template</th><th>Tag</th><th>GPU</th><th>$/hr</th><th>$/mo</th>
      <th>VRAM</th><th>GPU frac</th><th>Mem GB/s</th><th>BW×frac/$</th>
      <th>Failures</th><th>Status</th><th>Until</th><th>Last reason</th><th></th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

function optimizeFields(goals: OptimizeGoal[]): string {
  const rows = Array.from({ length: OPTIMIZE_SLOTS }, (_, index) => {
    const goal = goals[index]
    const field = goal?.field ?? ""
    const direction = goal?.direction ?? "higher"
    return `<div class="opt-row">
      <select name="opt_field_${index}">
        <option value="">none</option>
        ${OPTIMIZE_FIELDS.map(item => `<option value="${item}"${field === item ? " selected" : ""}>${OPTIMIZE_FIELD_LABELS[item]}</option>`).join("")}
      </select>
      <select name="opt_dir_${index}">
        <option value="higher"${direction === "higher" ? " selected" : ""}>higher</option>
        <option value="lower"${direction === "lower" ? " selected" : ""}>lower</option>
      </select>
      <input name="opt_gain_${index}" inputmode="decimal" value="${goal?.minGain == null ? "" : esc(goal.minGain)}" placeholder="min gain">
    </div>`
  }).join("")
  return `<div class="optimize">
    <span>Optimize</span>
    <p class="hint">First row that clears its gain wins. Blank gain means any improvement. Leave all rows on none to only fill missing instances. Leave optimize trials empty to keep it off. Instances is how many must be healthy. Burst is how many may load at once while that healthy count is short.</p>
    ${rows}
  </div>`
}

function numField(name: string, label: string, value: number | null | undefined, placeholder: string): string {
  return `<label>${esc(label)} <input name="${name}" inputmode="decimal" value="${value == null ? "" : esc(value)}" placeholder="${esc(placeholder)}"></label>`
}

function tri(name: string, label: string, value: boolean | null | undefined): string {
  const current = value == null ? "" : value ? "yes" : "no"
  return `<label>${esc(label)}
    <select name="${name}">
      <option value=""${current === "" ? " selected" : ""}>any</option>
      <option value="yes"${current === "yes" ? " selected" : ""}>yes</option>
      <option value="no"${current === "no" ? " selected" : ""}>no</option>
    </select>
  </label>`
}

function money(value: number | null | undefined, digits: number): string {
  if (value == null) return "—"
  return `$${value.toFixed(digits)}`
}

function monthlyPrice(hourly: number | null): number | null {
  if (hourly == null) return null
  return hourly * 24 * 30
}

function vram(mb: number | null | undefined): string {
  if (mb == null) return "—"
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`
  return `${mb.toFixed(0)} MB`
}

function metric(value: number | null | undefined, digits: number): string {
  if (value == null) return "—"
  return value.toFixed(digits)
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function layout(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light; --bg: #f4f1ea; --ink: #1c1915; --card: #fffdf8; --line: #ddd4c4; --muted: #6d6458; --accent: #8a3d12; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.45 "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
    main { max-width: 1100px; margin: 0 auto; padding: 28px 20px 64px; }
    h1 { font-size: 28px; margin: 0 0 4px; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .card { background: var(--card); border: 1px solid var(--line); padding: 16px; margin: 0 0 14px; }
    .narrow { max-width: 420px; }
    .title { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .title h2 { margin: 0; }
    .muted { color: var(--muted); }
    .status { display: flex; align-items: center; gap: 8px; min-height: 1.3em; }
    .spin { width: 0.8em; height: 0.8em; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { color: #8d1d1d; }
    .notice { background: #efe4cc; padding: 8px 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin: 12px 0; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
    input, select { font: inherit; color: var(--ink); background: white; border: 1px solid var(--line); padding: 7px 8px; }
    button { font: inherit; background: var(--accent); color: white; border: 0; padding: 8px 14px; cursor: pointer; }
    button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    .check { flex-direction: row; align-items: center; color: var(--ink); }
    .tags { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; grid-column: 1 / -1; color: var(--ink); }
    .tags > span { color: var(--muted); font-size: 13px; }
    .optimize { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px; }
    .optimize > span, .optimize .hint { color: var(--muted); font-size: 13px; }
    .opt-row { display: grid; grid-template-columns: 1.4fr 110px 120px; gap: 8px; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--card); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
    th { color: var(--muted); font-weight: 600; }
    td form { margin: 0; }
    td button { padding: 4px 8px; }
  </style>
</head>
<body><main>${body}</main>${script}</body>
</html>`
}

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function isKnownTag(value: string): value is Tag {
  return (TAGS as readonly string[]).includes(value)
}

export function parseTri(value: string | undefined): boolean | null {
  if (value === "yes") return true
  if (value === "no") return false
  return null
}

export function parseOptimize(form: URLSearchParams): OptimizeGoal[] {
  const goals: OptimizeGoal[] = []
  for (let index = 0; index < OPTIMIZE_SLOTS; index++) {
    const field = form.get(`opt_field_${index}`)
    if (!isOptimizeField(field)) continue
    const gain = optionalNumber(form.get(`opt_gain_${index}`))
    goals.push({
      field,
      direction: form.get(`opt_dir_${index}`) === "lower" ? "lower" : "higher",
      minGain: gain != null && gain > 0 ? gain : null,
    })
  }
  return goals
}

export function parseCriteria(form: URLSearchParams): Criteria {
  const list = (name: string) => {
    const raw = form.get(name)?.trim() ?? ""
    if (!raw) return null
    return raw.split(",").map(part => part.trim()).filter(Boolean)
  }
  return {
    gpuFracMin: optionalNumber(form.get("gpu_frac_min")),
    staticIp: parseTri(form.get("static_ip") ?? undefined),
    gpuMemBwMin: optionalNumber(form.get("gpu_mem_bw_min")),
    reliabilityMin: optionalNumber(form.get("reliability_min")),
    gpuRamMin: optionalNumber(form.get("gpu_ram_min")),
    numGpus: optionalNumber(form.get("num_gpus")),
    gpuNames: list("gpu_names"),
    inetDownMin: optionalNumber(form.get("inet_down_min")),
    inetUpMin: optionalNumber(form.get("inet_up_min")),
    directPortCountMin: optionalNumber(form.get("direct_port_count_min")),
    cudaMaxGoodMin: optionalNumber(form.get("cuda_max_good_min")),
    cpuRamMin: optionalNumber(form.get("cpu_ram_min")),
    geolocation: list("geolocation")?.map(code => code.toUpperCase()) ?? null,
    datacenter: parseTri(form.get("datacenter") ?? undefined),
    verified: form.get("verified") === "1",
  }
}

export function optionalNumber(value: string | null): number | null {
  if (value == null || value.trim() === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
