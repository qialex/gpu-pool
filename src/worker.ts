import { ensureOperator } from "./auth.js"
import { reconcile } from "./reconcile.js"

const INTERVAL_MS = 60_000

await ensureOperator()
console.log("[worker] reconcile loop started")

for (;;) {
  const started = Date.now()
  try {
    await reconcile()
  } catch (err) {
    console.error("[worker] pass failed", err)
  }
  const wait = Math.max(0, INTERVAL_MS - (Date.now() - started))
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
}
