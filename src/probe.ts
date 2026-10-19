import { connect as connectTcp } from "node:net"
import type { ProbeStatus } from "./policy.js"

const PROBE_TIMEOUT_MS = 5_000
const TCP_TIMEOUT_MS = 2_000

export async function probeUrl(url: string): Promise<ProbeStatus> {
  const first = await fetchProbe(url)
  if (first.kind === "http") return first.status === 503 ? "down" : "ready"
  if (first.kind === "timeout") {
    const open = await tcpPortOpen(url)
    return open ? "busy" : "down"
  }
  return "down"
}

type FetchProbe = { kind: "http"; status: number } | { kind: "timeout" } | { kind: "network" }

async function fetchProbe(url: string): Promise<FetchProbe> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    await res.arrayBuffer().catch(() => undefined)
    return { kind: "http", status: res.status }
  } catch (err) {
    return isTimeout(err) ? { kind: "timeout" } : { kind: "network" }
  }
}

function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return err.name === "TimeoutError" || err.name === "AbortError" || msg.includes("timeout") || msg.includes("aborted")
}

function tcpPortOpen(root: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(root)
  } catch {
    return Promise.resolve(false)
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  return new Promise(resolve => {
    const socket = connectTcp({ host: url.hostname, port })
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(TCP_TIMEOUT_MS)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}
