import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  acceptsUnmeasuredSpeed,
  banIsActive,
  belowTokensPerSecMin,
  blacklistBan,
  buildSearchBody,
  compareHeld,
  compareMetrics,
  isBetter,
  applyDerivedMetrics,
  metricsFrom,
  type MetricMap,
  optimizationPlan,
  detectContainerPort,
  hostPortFor,
  blacklistFailedLoad,
  burstRentCount,
  burstStillWaiting,
  countsAsWorking,
  fillsDesiredSlot,
  isServing,
  occupiesSlot,
  priceCeilings,
  priceSearchPlan,
  probePaths,
  shouldDestroy,
  isTextTag,
  textSpeedDue,
  tokensPerSecond,
  withSpeed,
} from "./policy.ts"

describe("priceCeilings", () => {
  it("walks from the minimum to the maximum by the step", () => {
    assert.deepEqual(priceCeilings({ min: 0.01, step: 0.005, loops: 10, max: 0.05 }), [
      0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.05,
    ])
  })

  it("includes the maximum when the step does not land on it", () => {
    assert.deepEqual(priceCeilings({ min: 0.01, step: 0.03, loops: 1, max: 0.05 }), [
      0.01, 0.04, 0.05,
    ])
  })

  it("returns nothing when the minimum is above the maximum", () => {
    assert.deepEqual(priceCeilings({ min: 1, step: 0.1, loops: 3, max: 0.5 }), [])
  })
})

describe("priceSearchPlan", () => {
  it("repeats each price for the loop count before stepping up", () => {
    const plan = priceSearchPlan({ min: 0.01, step: 0.005, loops: 10, max: 0.05 })
    assert.equal(plan.length, 90)
    assert.deepEqual(plan.slice(0, 10), Array.from({ length: 10 }, () => 0.01))
    assert.deepEqual(plan.slice(10, 20), Array.from({ length: 10 }, () => 0.015))
    assert.deepEqual(plan.slice(-10), Array.from({ length: 10 }, () => 0.05))
  })
})

describe("optimize", () => {
  const search = { min: 0.01, step: 0.005, loops: 2, max: 0.05 }

  it("accepts a cheaper machine and ignores a gain that is too small", () => {
    const goal = [{ field: "dph_total" as const, direction: "lower" as const, minGain: 0.005 }]
    assert.equal(isBetter({ dph_total: 0.04 }, { dph_total: 0.05 }, goal), true)
    assert.equal(isBetter({ dph_total: 0.048 }, { dph_total: 0.05 }, goal), false)
    assert.equal(isBetter({ dph_total: 0.04 }, { dph_total: 0.05 }, []), false)
  })

  it("uses the next goal only inside the first margin", () => {
    const goals = [
      { field: "dph_total" as const, direction: "lower" as const, minGain: 0.005 },
      { field: "gpu_mem_bw" as const, direction: "higher" as const, minGain: 50 },
    ]
    assert.equal(isBetter({ dph_total: 0.048, gpu_mem_bw: 900 }, { dph_total: 0.05, gpu_mem_bw: 400 }, goals), true)
    assert.equal(isBetter({ dph_total: 0.08, gpu_mem_bw: 900 }, { dph_total: 0.05, gpu_mem_bw: 400 }, goals), false)
  })

  it("can pay more for a higher metric inside the budget", () => {
    const goals = [{ field: "gpu_ram" as const, direction: "higher" as const, minGain: null }]
    assert.equal(isBetter({ dph_total: 0.05, gpu_ram: 24000 }, { dph_total: 0.02, gpu_ram: 8000 }, goals), true)
    assert.ok(compareMetrics({ gpu_ram: 24000 }, { gpu_ram: 8000 }, goals) < 0)
    assert.deepEqual(optimizationPlan(search, { gpu_ram: 8000 }, goals), [0.05])
  })

  it("scores GPU bandwidth per dollar without the GPU fraction", () => {
    const offer = metricsFrom({ gpu_mem_bw: 1000, gpu_frac: 0.5, dph_total: 0.05 })
    assert.equal(offer.bw_per_dollar, 20000)
    assert.equal(offer.gpu_frac, 0.5)
    const goals = [{ field: "bw_per_dollar" as const, direction: "higher" as const, minGain: null }]
    const full = metricsFrom({ gpu_mem_bw: 1000, gpu_frac: 1, dph_total: 0.05 })
    const slice = metricsFrom({ gpu_mem_bw: 1000, gpu_frac: 0.5, dph_total: 0.05 })
    assert.equal(isBetter(full, slice, goals), false)
    assert.equal(isBetter(metricsFrom({ gpu_mem_bw: 1000, dph_total: 0.04 }), full, goals), true)
    assert.equal(metricsFrom({ gpu_mem_bw: 1000 }).bw_per_dollar, undefined)
    const stored = applyDerivedMetrics({ gpu_mem_bw: 1000, dph_total: 0.05, bw_frac_per_dollar: 1 } as MetricMap)
    assert.equal(stored.bw_per_dollar, 20000)
    assert.equal("bw_frac_per_dollar" in stored, false)
    assert.deepEqual(optimizationPlan(search, full, goals), [0.05])
  })

  it("searches only below the current price when the first goal is lower price", () => {
    const goals = [{ field: "dph_total" as const, direction: "lower" as const, minGain: 0.005 }]
    const plan = optimizationPlan(search, { dph_total: 0.05 }, goals)
    assert.equal(plan[0], 0.01)
    assert.equal(plan[plan.length - 1], 0.045)
    assert.equal(plan.filter(price => price === 0.01).length, 2)
    assert.equal(plan.some(price => price >= 0.05), false)
  })
})

describe("isServing", () => {
  it("counts a loaded machine as in service", () => {
    assert.equal(isServing("ready"), true)
    assert.equal(isServing("busy"), true)
    assert.equal(isServing("down"), false)
    assert.equal(isServing("starting"), false)
  })
})

describe("countsAsWorking", () => {
  it("counts a machine only after it has come ready, including through a later outage", () => {
    assert.equal(countsAsWorking(null), false)
    assert.equal(countsAsWorking(new Date()), true)
  })
})

describe("fillsDesiredSlot", () => {
  it("leaves a machine that has never been healthy out of the running slots", () => {
    const ready = new Date()
    assert.equal(fillsDesiredSlot("running", null), false)
    assert.equal(fillsDesiredSlot("loading", null), false)
    assert.equal(fillsDesiredSlot("running", ready), true)
    assert.equal(fillsDesiredSlot("loading", ready), true)
    assert.equal(fillsDesiredSlot("exited", ready), false)
  })
})

describe("burstRentCount", () => {
  it("rents the burst set while no machine has come ready", () => {
    assert.equal(burstRentCount(0, 1, 3, 0), 3)
    assert.equal(burstRentCount(0, 1, 3, 1), 2)
    assert.equal(burstRentCount(0, 1, 3, 3), 0)
  })

  it("leaves a machine that already worked on the normal path", () => {
    assert.equal(burstRentCount(1, 1, 3, 1), null)
    assert.equal(burstRentCount(1, 1, 3, 2), null)
  })

  it("stays off when burst is not above the desired count", () => {
    assert.equal(burstRentCount(0, 1, 0, 0), null)
    assert.equal(burstRentCount(0, 1, 1, 0), null)
  })
})

describe("burstStillWaiting", () => {
  it("waits only while an unproven machine is still loading inside the deadline", () => {
    assert.equal(burstStillWaiting("loading", "starting", 10 * 60 * 1000), true)
    assert.equal(burstStillWaiting("running", "down", 10 * 60 * 1000), true)
    assert.equal(burstStillWaiting("running", "ready", 10 * 60 * 1000), false)
    assert.equal(burstStillWaiting("running", "busy", 10 * 60 * 1000), false)
    assert.equal(burstStillWaiting("loading", "starting", 41 * 60 * 1000), false)
    assert.equal(burstStillWaiting("exited", null, 1000), false)
    assert.equal(burstStillWaiting("running", "down", 10 * 60 * 1000, true), false)
  })
})

describe("instance policy", () => {
  it("counts a long load as still occupying its slot", () => {
    assert.equal(occupiesSlot("loading"), true)
    assert.equal(occupiesSlot(null), true)
    assert.equal(shouldDestroy("loading", 30 * 60 * 1000), false)
    assert.equal(shouldDestroy("loading", 41 * 60 * 1000), true)
  })

  it("destroys statuses that never become running", () => {
    assert.equal(shouldDestroy("exited", 0), true)
    assert.equal(shouldDestroy("exited", 0, "running"), true)
    assert.equal(shouldDestroy("exited", 0, "stopped"), false)
    assert.equal(shouldDestroy("unknown", 0), true)
    assert.equal(shouldDestroy("offline", 0), true)
    assert.equal(shouldDestroy("rebooting", 11 * 60 * 1000), true)
    assert.equal(shouldDestroy("running", 50 * 60 * 1000), false)
  })

  it("blacklists a machine that never became healthy once the load deadline passed", () => {
    assert.equal(blacklistFailedLoad("running", "down", 41 * 60 * 1000, false, "running"), true)
    assert.equal(blacklistFailedLoad("running", "down", 10 * 60 * 1000, false, "running"), false)
    assert.equal(blacklistFailedLoad("running", "down", 41 * 60 * 1000, true, "running"), false)
    assert.equal(blacklistFailedLoad("running", "ready", 41 * 60 * 1000, false, "running"), false)
    assert.equal(blacklistFailedLoad("exited", "down", 50 * 60 * 1000, false, "stopped"), true)
    assert.equal(blacklistFailedLoad("exited", "ready", 50 * 60 * 1000, true, "stopped"), false)
  })
})

describe("blacklistBan", () => {
  it("adds one week for each failure and keeps growing", () => {
    const now = Date.parse("2026-10-19T00:00:00.000Z")
    const week = 7 * 24 * 60 * 60 * 1000
    assert.deepEqual(blacklistBan(0, now), { strikes: 1, bannedUntilMs: now + week })
    assert.deepEqual(blacklistBan(1, now), { strikes: 2, bannedUntilMs: now + 2 * week })
    assert.deepEqual(blacklistBan(2, now), { strikes: 3, bannedUntilMs: now + 3 * week })
  })

  it("drops a machine from the ban once the time has passed", () => {
    const until = Date.parse("2026-10-26T00:00:00.000Z")
    assert.equal(banIsActive(until, until - 1), true)
    assert.equal(banIsActive(until, until), false)
    assert.equal(banIsActive(until, until + 1), false)
  })
})

describe("search body", () => {
  it("overrides template filters with the operator ceiling and disk", () => {
    const body = buildSearchBody({
      ceiling: 0.2,
      diskGb: 40,
      criteria: { gpuFracMin: 1, verified: true },
      extraFilters: { dph_total: { lte: 9 }, gpu_name: { eq: "RTX_4090" } },
    })
    assert.deepEqual(body.dph_total, { lte: 0.2 })
    assert.equal(body.allocated_storage, 40)
    assert.deepEqual(body.disk_space, { gte: 40 })
    assert.deepEqual(body.gpu_name, { eq: "RTX_4090" })
    assert.deepEqual(body.verification, { eq: "verified" })
    assert.equal("tokens_per_sec" in body, false)
  })

  it("does not send tok/s to Vast", () => {
    const body = buildSearchBody({
      ceiling: 0.2,
      diskGb: 40,
      criteria: { tokensPerSecMin: 40, verified: true },
      extraFilters: null,
    })
    assert.equal(body.tokens_per_sec, undefined)
  })
})

describe("isTextTag", () => {
  it("is only the text pools", () => {
    assert.equal(isTextTag("text_regular"), true)
    assert.equal(isTextTag("text_premium"), true)
    assert.equal(isTextTag("audio"), false)
    assert.equal(isTextTag("image"), false)
  })
})

describe("textSpeedDue", () => {
  const minute = 60 * 1000
  const tenMinutes = 10 * minute

  it("is due when there has been no attempt", () => {
    assert.equal(textSpeedDue(null, 1_000, false), true)
    assert.equal(textSpeedDue(null, 1_000, true), true)
  })

  it("retries a failure after a minute", () => {
    const now = 20 * minute
    assert.equal(textSpeedDue(now - minute + 1, now, false), false)
    assert.equal(textSpeedDue(now - minute, now, false), true)
  })

  it("waits ten minutes after a successful sample", () => {
    const now = 20 * minute
    assert.equal(textSpeedDue(now - tenMinutes + 1, now, true), false)
    assert.equal(textSpeedDue(now - tenMinutes, now, true), true)
  })
})

describe("text tok/s", () => {
  const faster = [{ field: "tokens_per_sec" as const, direction: "higher" as const, minGain: 5 }]

  it("keeps a measured rate on the instance and ignores a Vast offer", () => {
    assert.equal(withSpeed({ dph_total: 0.2 }, 55).tokens_per_sec, 55)
    assert.equal(withSpeed({ dph_total: 0.2 }, null).tokens_per_sec, undefined)
    assert.equal(metricsFrom({ tokens_per_sec: 99, dph_total: 0.1 }).tokens_per_sec, undefined)
  })

  it("fails only a finished sample under the minimum", () => {
    assert.equal(belowTokensPerSecMin(30, 40), true)
    assert.equal(belowTokensPerSecMin(40, 40), false)
    assert.equal(belowTokensPerSecMin(null, 40), false)
    assert.equal(belowTokensPerSecMin(30, null), false)
  })

  it("rents a trial when the offer has no tok/s and the machine does", () => {
    assert.equal(acceptsUnmeasuredSpeed({ dph_total: 0.2 }, { tokens_per_sec: 40 }, faster), true)
    assert.equal(acceptsUnmeasuredSpeed({ tokens_per_sec: 50 }, { tokens_per_sec: 40 }, faster), false)
    assert.equal(acceptsUnmeasuredSpeed({ dph_total: 0.2 }, {}, faster), false)
    assert.equal(isBetter({ tokens_per_sec: 50 }, { tokens_per_sec: 40 }, faster), true)
    assert.equal(isBetter({ tokens_per_sec: 42 }, { tokens_per_sec: 40 }, faster), false)
    assert.deepEqual(optimizationPlan({ min: 0.01, step: 0.005, loops: 2, max: 0.05 }, { tokens_per_sec: 40 }, faster), [0.05])
  })

  it("rejects a trial that already loses an earlier goal", () => {
    const goals = [
      { field: "dph_total" as const, direction: "lower" as const, minGain: null },
      { field: "tokens_per_sec" as const, direction: "higher" as const, minGain: null },
    ]
    assert.equal(acceptsUnmeasuredSpeed({ dph_total: 0.3 }, { dph_total: 0.2, tokens_per_sec: 40 }, goals), false)
    assert.equal(acceptsUnmeasuredSpeed({ dph_total: 0.2 }, { dph_total: 0.2, tokens_per_sec: 40 }, goals), true)
  })

  it("does not treat a missing sample as slow, and ignores a gain that is too small", () => {
    assert.equal(compareHeld({ dph_total: 0.2 }, { tokens_per_sec: 40 }, faster), 0)
    assert.equal(compareHeld({ tokens_per_sec: 42 }, { tokens_per_sec: 40 }, faster), 0)
    assert.ok(compareHeld({ tokens_per_sec: 45 }, { tokens_per_sec: 40 }, faster) < 0)
  })
})

describe("tokensPerSecond", () => {
  it("divides completion tokens by the full request time", () => {
    assert.equal(tokensPerSecond(32, 500), 64)
    assert.equal(tokensPerSecond(0, 500), 0)
    assert.equal(tokensPerSecond(-1, 500), null)
    assert.equal(tokensPerSecond(32, 0), null)
  })
})

describe("probePaths", () => {
  it("probes each kind of tag, and an override replaces them", () => {
    assert.deepEqual(probePaths(["audio", "text_regular"], null), ["/health", "/v1/models"])
    assert.deepEqual(probePaths(["audio", "text_regular"], "/health"), ["/health"])
  })
})

describe("ports", () => {
  it("reads the container side of a template -p mapping", () => {
    assert.equal(detectContainerPort({ "-p 18000:8080": "1" }), 8080)
  })

  it("reads the published host port", () => {
    assert.equal(hostPortFor({ "8080/tcp": [{ HostPort: "41234" }] }, 8080), 41234)
  })
})
