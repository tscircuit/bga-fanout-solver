import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import capturedData from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import { simplifiedAm62lDdrRamReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-ram-repro-fixed-layer-distribution"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { buildFanoutModel } from "../lib/model/buildFanoutModel"
import { containsPoint } from "../lib/model/powerPlanePlanning"
import {
  expectBothCopperPours,
  expectFixedLayerDistribution,
  expectedLayerCounts,
} from "./fixed-layer-distribution-helpers"

test("fixed RAM layer distribution solves all 33 traces from the RAM BGA", () => {
  const input = structuredClone(
    simplifiedAm62lDdrRamReproFixedLayerDistribution,
  )
  const inputBeforeSolve = structuredClone(input)
  const capturedInput = capturedData as unknown as SimpleRouteJson
  const model = buildFanoutModel(input)

  expect(model.componentId).toBe("pcb_component_1")
  expect(model.axisSign).toBe(-1)
  expect(input.obstacles).toEqual(capturedInput.obstacles)
  expectBothCopperPours(input, capturedInput)
  expectFixedLayerDistribution(input)

  const solver = new FixedTargetBgaFanoutSolver(input)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.error).toBeNull()
  const output = solver.getOutput()
  expect(output.traces).toHaveLength(33)
  expect(input).toEqual(inputBeforeSolve)
  expect(
    Object.fromEntries(
      Object.entries(
        Object.groupBy(
          output.traces,
          (trace) =>
            trace.route.findLast((point) => point.route_type === "wire")
              ?.layer ?? "missing",
        ),
      ).map(([layer, traces]) => [layer, traces?.length]),
    ),
  ).toEqual(expectedLayerCounts)

  const plan = output.powerPlanePlan
  expect(plan).toBeDefined()
  expect(plan!.pads).toHaveLength(58)
  expect(new Set(plan!.pads.map((pad) => pad.id)).size).toBe(58)
  expect(plan!.clusters.flatMap((cluster) => cluster.padIds).sort()).toEqual(
    plan!.pads.map((pad) => pad.id).sort(),
  )
  expect(plan!.links).toHaveLength(19)
  expect(plan!.viaDrops).toHaveLength(31)
  expect(plan!.unresolvedViaDrops).toHaveLength(8)
  expect(plan!.legalViaCandidateCount).toBeGreaterThan(0)

  const clusterById = new Map(
    plan!.clusters.map((cluster) => [cluster.id, cluster]),
  )
  const linkById = new Map(plan!.links.map((link) => [link.id, link]))
  const pourById = new Map(plan!.pours.map((pour) => [pour.id, pour]))
  for (const drop of plan!.viaDrops) {
    const cluster = clusterById.get(drop.clusterId)!
    const pour = pourById.get(drop.pourId)!
    expect(cluster).toBeDefined()
    expect(cluster.netKey).toBe(drop.netKey)
    expect(pour.netKey).toBe(drop.netKey)
    expect(pour.layers).toContain(drop.terminationLayer)
    expect(containsPoint(pour, drop.via)).toBe(true)

    const reached = new Set([drop.sourcePadId])
    let changed = true
    while (changed) {
      changed = false
      for (const linkId of cluster.linkIds) {
        const link = linkById.get(linkId)!
        if (reached.has(link.firstPadId) && !reached.has(link.secondPadId)) {
          reached.add(link.secondPadId)
          changed = true
        }
        if (reached.has(link.secondPadId) && !reached.has(link.firstPadId)) {
          reached.add(link.firstPadId)
          changed = true
        }
      }
    }
    expect([...cluster.padIds].every((padId) => reached.has(padId))).toBe(true)
  }

  const unresolvedPadIds = plan!.unresolvedViaDrops.flatMap(
    (item) => item.padIds,
  )
  expect(new Set(unresolvedPadIds).size).toBe(8)
  const droppedClusterIds = new Set(
    plan!.viaDrops.map((drop) => drop.clusterId),
  )
  expect(
    plan!.clusters
      .filter((cluster) => droppedClusterIds.has(cluster.id))
      .flatMap((cluster) => cluster.padIds),
  ).toHaveLength(50)
  expect(
    plan!.unresolvedViaDrops.every(
      (item) => item.reasonCode === "no_legal_candidate",
    ),
  ).toBe(true)
  expect(
    plan!.viaDrops.every(
      (drop) =>
        !plan!.unresolvedViaDrops.some(
          (item) => item.clusterId === drop.clusterId,
        ),
    ),
  ).toBe(true)

  expect(output.powerTraces).toHaveLength(
    plan!.links.length + plan!.viaDrops.length,
  )
  expect(
    output.powerTraces?.filter((trace) =>
      trace.route.some((point) => point.route_type === "via"),
    ),
  ).toHaveLength(plan!.viaDrops.length)
  expect(
    output.outputSimpleRouteJson.traces?.filter((trace) =>
      trace.pcb_trace_id.startsWith("bga-power-plane:"),
    ),
  ).toEqual(output.powerTraces)
  expect(
    Object.values(solver.getStageStats()).every((stage) => stage.completed),
  ).toBe(true)

  const finalVisualization = solver.finalVisualize()
  expect(finalVisualization).not.toBeNull()
  expect(
    finalVisualization!.circles?.filter((circle) =>
      circle.label?.startsWith("plane via ·"),
    ),
  ).toHaveLength(plan!.viaDrops.length)
  expect(
    finalVisualization!.circles?.filter((circle) =>
      circle.label?.includes("skipped plane drop"),
    ),
  ).toHaveLength(unresolvedPadIds.length)
  expect(
    finalVisualization!.lines?.some((line) =>
      line.label?.includes("dogbone →"),
    ),
  ).toBe(true)
  expect(
    finalVisualization!.lines?.some((line) => line.label?.includes(" ↔ ")),
  ).toBe(true)
  expect(
    finalVisualization!.texts?.some(
      (text) => text.text === "copper_pour_via_drops",
    ),
  ).toBe(true)
}, 120_000)
