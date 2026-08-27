import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import { FixedTargetBgaFanoutSolver } from "../lib"
import type { IncrementalReferenceFanoutSession } from "../lib/private/reference/solve-am62l-free-space-fanout"
import { normalizeActivePowerPourConnectivity } from "../scripts/sweep-breakout-target-spacing"

const consumerDebugInput = new URL(
  "../fixtures/expanded-breakpoint-spacing-1.25-ram.srj.json",
  import.meta.url,
)

test("common source_net normalization detects all 58 U2 VSS pads", async () => {
  const input = (await Bun.file(consumerDebugInput).json()) as SimpleRouteJson
  const normalized = normalizeActivePowerPourConnectivity(input)
  const solver = new FixedTargetBgaFanoutSolver(normalized)
  solver.solveUntilStage("resolvePowerSignalConflicts")
  expect(solver.failed).toBe(false)
  const session = solver.getStageOutput<IncrementalReferenceFanoutSession>(
    "planCopperPourViaDrops",
  )
  expect(session).toBeDefined()
  const plan = session!.getVisualizationContext().model.powerPlanePlan
  expect(plan?.pads).toHaveLength(58)
  expect(session!.routeCount).toBe(33)
}, 60_000)
