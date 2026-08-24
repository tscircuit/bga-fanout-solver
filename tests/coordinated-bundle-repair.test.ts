import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import fixtureData from "../fixtures/am62l-soc-fanout.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"
import type { ViaFirstRouteCandidate } from "../lib/model/types"
import { isOctilinearSegment, pathSegments } from "../lib/routing/routeGeometry"

test("coordinated bundle repair changes related templates together without weakening hard geometry", () => {
  const solver = new FixedTargetBgaFanoutSolver(
    structuredClone(fixtureData) as unknown as SimpleRouteJson,
  )
  solver.solveUntilStage("proposeBundleRepairs")
  const before = solver.getStageOutput<ViaFirstRouteCandidate>(
    "detectInitialConflicts",
  )!
  solver.solveUntilStage("detectRepairedConflicts")
  const after = solver.getStageOutput<ViaFirstRouteCandidate>(
    "commitBundleRepairs",
  )!
  const repairStats = solver.getSolver("commitBundleRepairs")!.stats

  expect(repairStats.acceptedProposals).toBeGreaterThan(0)
  expect(after.violations.length).toBeLessThan(before.violations.length)
  expect(after.routes.map((route) => route.net.connectionName)).toEqual(
    before.routes.map((route) => route.net.connectionName),
  )
  for (const route of after.routes) {
    expect(route.topPath[0]).toEqual({
      x: route.net.source.x,
      y: route.net.source.y,
    })
    expect(route.topPath.at(-1)).toEqual(route.via)
    expect(route.innerPath[0]).toEqual(route.via)
    expect(route.innerPath.at(-1)).toEqual({
      x: route.net.target.x,
      y: route.net.target.y,
    })
    expect(
      [...pathSegments(route.topPath), ...pathSegments(route.innerPath)].every(
        (segment) => isOctilinearSegment(segment.a, segment.b),
      ),
    ).toBeTrue()
  }
})
