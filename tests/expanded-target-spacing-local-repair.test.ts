import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import { simplifiedAm62lDdrRamReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-ram-repro-fixed-layer-distribution"
import { simplifiedAm62lDdrSocReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-soc-repro-fixed-layer-distribution"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { buildFanoutModel } from "../lib/model/buildFanoutModel"
import { distance } from "../lib/model/geometry"
import { generateBoundedSignalViaRelocationSites } from "../lib/model/signalViaRelocationCandidates"
import type { IncrementalReferenceFanoutSession } from "../lib/private/reference/solve-am62l-free-space-fanout"
import { scaleBreakoutTargetSpacing } from "../scripts/sweep-breakout-target-spacing"

const solveSignalsAndPower = (input: SimpleRouteJson) => {
  const solver = new FixedTargetBgaFanoutSolver(input)
  solver.solveUntilStage("resolvePowerSignalConflicts")
  expect(solver.failed, solver.error ?? "solver failed").toBe(false)
  const session = solver.getStageOutput<IncrementalReferenceFanoutSession>(
    "planCopperPourViaDrops",
  )
  expect(session).toBeDefined()
  expect(session!.routeCount).toBe(33)
  return session!
}

const assertViaRules = (
  input: SimpleRouteJson,
  session: IncrementalReferenceFanoutSession,
) => {
  const model = buildFanoutModel(input)
  const context = session.getVisualizationContext().model
  const plan = context.powerPlanePlan
  expect(plan).toBeDefined()
  const vias = [
    ...session.getRoutes().map((route) => route.via),
    ...plan!.viaDrops.map((drop) => drop.via),
  ]
  let minimumEdgeClearance = Number.POSITIVE_INFINITY
  for (const via of vias) {
    for (const pad of model.pads) {
      const centerDistance = distance(via, pad)
      expect(centerDistance + 1e-6).toBeGreaterThanOrEqual(pad.radius)
      minimumEdgeClearance = Math.min(
        minimumEdgeClearance,
        centerDistance - pad.radius - model.rules.viaDiameter / 2,
      )
    }
  }
  expect(minimumEdgeClearance + 1e-6).toBeGreaterThanOrEqual(
    model.rules.viaToPadClearance,
  )
  const signalVias = session
    .buildOutput()
    .traces.flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via")
  const powerVias = (context.input.traces ?? [])
    .filter((trace) => trace.pcb_trace_id.startsWith("bga-power-plane:drop:"))
    .flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via")
  for (const via of [...signalVias, ...powerVias]) {
    expect(via.from_layer).toBe("top")
    expect(via.to_layer).toBe("bottom")
  }
}

test("expanded targets repair a minimal tail set on both sides with rotation-invariant via relocation", () => {
  const baselineInput = structuredClone(
    simplifiedAm62lDdrSocReproFixedLayerDistribution,
  )
  const baseline = solveSignalsAndPower(baselineInput)
  expect(baseline.getTargetSpacingAdaptationSummary()).toBeUndefined()

  const expandedInput = scaleBreakoutTargetSpacing(baselineInput, 1.25)
  const expanded = solveSignalsAndPower(expandedInput)
  const summary = expanded.getTargetSpacingAdaptationSummary()
  expect(summary).toBeDefined()
  expect(summary).toMatchObject({
    applied: true,
    scale: 1.25,
    requiredSignalCount: 33,
  })
  expect(summary!.initiallyReusableRouteNames).toHaveLength(30)
  expect(summary!.repairedRouteNames).toHaveLength(3)
  expect(summary!.relocatedViaRouteNames).toHaveLength(1)

  const relocatedName = summary!.relocatedViaRouteNames[0]!
  const baselineVia = baseline
    .getRoutes()
    .find((route) => route.connectionName === relocatedName)!.via
  const expandedVia = expanded
    .getRoutes()
    .find((route) => route.connectionName === relocatedName)!.via
  // The historical fixed ViaLine assumption only moved outward (+X) and
  // seeded below the portal. This captured case requires the general +Y site.
  expect(Math.abs(expandedVia.x - baselineVia.x)).toBeLessThan(1e-6)
  expect(expandedVia.y).toBeGreaterThan(baselineVia.y)
  assertViaRules(expandedInput, expanded)

  const input = scaleBreakoutTargetSpacing(
    simplifiedAm62lDdrRamReproFixedLayerDistribution,
    1.25,
  )
  const session = solveSignalsAndPower(input)
  expect(session.getTargetSpacingAdaptationSummary()).toMatchObject({
    applied: true,
    scale: 1.25,
    requiredSignalCount: 33,
  })
  assertViaRules(input, session)

  const origin = { x: 1.25, y: -0.75 }
  const base = generateBoundedSignalViaRelocationSites({
    origin,
    step: 0.53848,
    maximumSteps: 6,
  })
  expect(base).toHaveLength(48)
  const rotate = (point: { x: number; y: number }, turns: number) => {
    let rotated = { ...point }
    for (let index = 0; index < turns; index++) {
      rotated = { x: -rotated.y, y: rotated.x }
    }
    return rotated
  }
  const key = (point: { x: number; y: number }) =>
    `${point.x.toFixed(5)},${point.y.toFixed(5)}`
  for (const turns of [1, 2, 3]) {
    const rotatedOrigin = rotate(origin, turns)
    const rotatedSites = new Set(
      generateBoundedSignalViaRelocationSites({
        origin: rotatedOrigin,
        step: 0.53848,
        maximumSteps: 6,
      }).map(key),
    )
    expect(new Set(base.map((site) => key(rotate(site, turns))))).toEqual(
      rotatedSites,
    )
  }
}, 240_000)
