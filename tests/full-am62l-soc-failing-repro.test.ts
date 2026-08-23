import { expect, test } from "bun:test"
import problemData from "../fixtures/full-am62l-soc-failing-repro.problem.json"
import { FullAm62lSocFailingReproSolver } from "../pages/full-am62l-soc-failing-repro/FullAm62lSocFailingReproSolver"
import type { FullSocBreakoutProblem } from "../pages/full-am62l-soc-failing-repro/types"

test("full AM62L SoC power-first fixture preserves its measured failure", () => {
  const problem = problemData as unknown as FullSocBreakoutProblem

  expect(problem.geometry).toMatchObject({
    ballCount: 373,
    grid: { columns: 23, rows: 23, pitch: 0.5 },
    pad: {
      shape: "circle",
      diameter: 0.254,
      solderMaskMargin: 0.0254,
      landStyle: "NSMD",
    },
    via: { padDiameter: 0.4572, holeDiameter: 0.2032 },
    rules: { minPadEdgeToPadEdgeClearance: 0.1 },
  })
  expect(problem.geometry.layerStack).toHaveLength(8)
  expect(problem.inventory).toMatchObject({
    totalBalls: 373,
    connectedBalls: 211,
    noConnectBalls: 162,
    roles: {
      signals: 60,
      groundPlaneTerminals: 109,
      powerPlaneTerminals: 35,
      localRailTerminals: 7,
    },
    signals: {
      fixedBoundaryTargets: 33,
      missingBoundaryTargets: 27,
    },
  })
  expect(problem.terminals).toHaveLength(373)
  expect(problem.signalConnections).toHaveLength(60)
  expect(problem.planeTerminals).toHaveLength(144)
  expect(problem.localRailTerminals).toHaveLength(7)
  expect(problem.precommittedGroundCopper.vias).toHaveLength(35)
  expect(problem.precommittedGroundCopper.segments).toHaveLength(229)
  expect(problem.planeRegions.map((plane) => plane.layer).sort()).toEqual([
    "inner1",
    "inner6",
  ])
  expect(problem.solverInput.connections).toHaveLength(33)
  expect(problem.solverInput.obstacles).toHaveLength(373)
  expect(problem.solverInput.traces).toHaveLength(264)
  expect(
    problem.signalConnections.filter(
      (connection) => connection.fixedBoundaryTarget !== null,
    ),
  ).toHaveLength(33)
  expect(
    problem.signalConnections.filter(
      (connection) => connection.fixedBoundaryTarget === null,
    ),
  ).toHaveLength(27)
  expect(
    problem.planeTerminals.every(
      (terminal) => !("fixedBoundaryTarget" in terminal),
    ),
  ).toBeTrue()
  expect(JSON.stringify(problem)).not.toContain("/Users/")

  const solver = new FullAm62lSocFailingReproSolver(problem)
  expect(() => solver.solve()).toThrow(problem.expectedFailure.message)
  expect(solver.failed).toBeTrue()
  expect(solver.error).toContain(problem.expectedFailure.message)
  expect(solver.getCurrentStageName()).toBe("compatibilityRoute")

  const visuals = solver.visualize()
  expect(
    visuals.texts?.some((text) => text.text === "1.6064 mm short"),
  ).toBeTrue()
  expect(
    visuals.circles?.filter((circle) =>
      circle.label?.startsWith("ti-ground-via-"),
    ),
  ).toHaveLength(35)
}, 120_000)
