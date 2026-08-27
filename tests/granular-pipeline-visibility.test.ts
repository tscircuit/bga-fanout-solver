import { expect, test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { loadFixture, loadGolden, assertParityOutput } from "./helpers"

test("RAM pipeline exposes real cell and route micro-steps before exact completion", async () => {
  const input = await loadFixture("lpddr4-ram-fanout")
  const golden = await loadGolden("lpddr4-ram-fanout")
  const solver = new FixedTargetBgaFanoutSolver(input)

  expect(solver.pipelineDef.map((stage) => stage.solverName)).toEqual([
    "buildFanoutModel",
    "sampleFreeSpaceCells",
    "discoverFreeSpaceRegions",
    "packFreeSpaceRegions",
    "rankFanoutNets",
    "initializeReferenceRouting",
    "placeIndependentEarlyDropVias",
    "completeTopLayerRoutes",
    "assignPrescribedLayers",
    "routePrescribedInnerLayers",
    "miterRouteCorners",
    "validateReconstructedGeometry",
    "planSameNetPadClusters",
    "planCopperPourViaDrops",
    "resolvePowerSignalConflicts",
    "buildOutput",
  ])

  solver.solveUntilStage("sampleFreeSpaceCells")
  solver.step()
  solver.step()
  const firstSample = solver.activeSubSolver?.stats
  solver.step()
  const secondSample = solver.activeSubSolver?.stats
  expect(firstSample?.sampled).toBe(1)
  expect(secondSample?.sampled).toBe(2)
  expect(secondSample?.activeCell).not.toBe(firstSample?.activeCell)

  solver.solveUntilStage("placeIndependentEarlyDropVias")
  solver.step()
  const earlyDropSolver = solver.activeSubSolver!
  expect(earlyDropSolver.solved).toBe(false)
  solver.step()
  expect(earlyDropSolver.solved).toBe(false)
  expect(earlyDropSolver.iterations).toBe(1)
  expect(earlyDropSolver.stats.action).toBe("prepare_early_drop_candidate_pool")
  const earlyCandidates = new Set<string>()
  for (let index = 0; index < 24; index++) {
    earlyCandidates.add(
      `${earlyDropSolver.stats.action}:${earlyDropSolver.stats.activeConnection}:${earlyDropSolver.stats.activeCandidate}`,
    )
    solver.step()
  }
  expect(earlyDropSolver.solved).toBe(false)
  expect(earlyDropSolver.iterations).toBe(25)
  expect(earlyCandidates.size).toBeGreaterThan(1)
  expect(
    solver
      .visualize()
      .circles?.some((circle) => circle.label === "active search candidate"),
  ).toBe(true)

  solver.solveUntilStage("completeTopLayerRoutes")
  expect(earlyDropSolver.solved).toBe(true)
  expect(earlyDropSolver.iterations).toBeGreaterThan(100)
  solver.step()
  const topRouteSolver = solver.activeSubSolver!
  solver.step()
  expect(topRouteSolver.solved).toBe(false)
  expect(topRouteSolver.iterations).toBe(1)
  const topRouteActions = new Set<string>()
  for (let index = 0; index < 24; index++) {
    topRouteActions.add(
      `${topRouteSolver.stats.action}:${topRouteSolver.stats.activeCandidate}`,
    )
    solver.step()
  }
  expect(topRouteSolver.solved).toBe(false)
  expect(topRouteSolver.iterations).toBe(25)
  expect(topRouteActions.size).toBeGreaterThan(1)
  let searchStateSteps = 0
  while (
    topRouteSolver.stats.action !== "pop_top_layer_grid_node" &&
    searchStateSteps < 100
  ) {
    solver.step()
    searchStateSteps++
  }
  expect(topRouteSolver.stats.action).toBe("pop_top_layer_grid_node")
  expect(topRouteSolver.stats.visitedCount).toBeGreaterThan(0)
  expect(topRouteSolver.stats.frontierSize).toBeGreaterThanOrEqual(0)
  const searchVisual = solver.visualize()
  // Search telemetry retains the visited count; the visualization may omit
  // historical visited-node dots to keep dense BGA views readable, so assert
  // the live search geometry below instead.
  expect(
    searchVisual.circles?.some(
      (circle) => circle.label === "search source endpoint",
    ),
  ).toBe(true)
  expect(
    searchVisual.circles?.some(
      (circle) => circle.label === "search target endpoint",
    ),
  ).toBe(true)
  expect(
    searchVisual.lines?.some(
      (line) => line.label === "direct connection intent guide",
    ),
  ).toBe(true)
  expect(searchVisual.texts?.some((text) => text.text === "S")).toBe(true)
  expect(searchVisual.texts?.some((text) => text.text === "T")).toBe(true)
  expect(
    searchVisual.lines?.some(
      (line) => line.label === "A* live best candidate path",
    ),
  ).toBe(true)
  expect(
    searchVisual.texts?.some(
      (text) =>
        text.text.includes("A*") &&
        text.text.includes(topRouteSolver.stats.status),
    ),
  ).toBe(true)
  expect(topRouteSolver.stats.searchStart).not.toBeNull()
  expect(topRouteSolver.stats.searchTarget).not.toBeNull()
  expect(topRouteSolver.stats.currentNode).not.toBeNull()

  solver.solveUntilStage("routePrescribedInnerLayers")
  solver.step()
  const innerRouteSolver = solver.activeSubSolver!
  solver.step()
  expect(innerRouteSolver.solved).toBe(false)

  let innerSearchSteps = 0
  while (
    innerRouteSolver.stats.action !== "pop_inner_layer_grid_node" &&
    innerRouteSolver.stats.action !== "evaluate_inner_layer_neighbor" &&
    innerSearchSteps < 10_000
  ) {
    solver.step()
    innerSearchSteps++
  }
  expect([
    "pop_inner_layer_grid_node",
    "evaluate_inner_layer_neighbor",
  ]).toContain(innerRouteSolver.stats.action)
  expect(innerRouteSolver.solved).toBe(false)

  let candidatePathSteps = 0
  while (
    innerRouteSolver.stats.candidatePathPoints < 2 &&
    candidatePathSteps < 10_000
  ) {
    solver.step()
    candidatePathSteps++
  }
  const firstInnerNode = JSON.stringify(innerRouteSolver.stats.currentNode)
  const firstInnerFrame = JSON.stringify(solver.visualize())
  let changedNodeSteps = 0
  while (
    JSON.stringify(innerRouteSolver.stats.currentNode) === firstInnerNode &&
    changedNodeSteps < 32
  ) {
    solver.step()
    changedNodeSteps++
  }
  expect(innerRouteSolver.iterations).toBeGreaterThan(1)
  const innerSearchVisual = solver.visualize()
  expect(JSON.stringify(innerSearchVisual)).not.toBe(firstInnerFrame)
  expect(innerRouteSolver.stats.currentNode).not.toBeNull()
  expect(innerRouteSolver.stats.visitedCount).toBeGreaterThan(0)
  expect(innerRouteSolver.stats.frontierSize).toBeGreaterThanOrEqual(0)
  expect(
    innerSearchVisual.circles?.some(
      (circle) => circle.label === "search source endpoint",
    ),
  ).toBe(true)
  expect(
    innerSearchVisual.circles?.some(
      (circle) => circle.label === "search target endpoint",
    ),
  ).toBe(true)
  expect(
    innerSearchVisual.lines?.some(
      (line) => line.label === "direct connection intent guide",
    ),
  ).toBe(true)
  expect(innerSearchVisual.texts?.some((text) => text.text === "S")).toBe(true)
  expect(innerSearchVisual.texts?.some((text) => text.text === "T")).toBe(true)
  expect(
    innerSearchVisual.lines?.some(
      (line) =>
        line.label === "A* live best candidate path" &&
        line.layer === innerRouteSolver.stats.layer,
    ),
  ).toBe(true)

  let acceptedInnerRouteSteps = 0
  while (
    !(
      innerRouteSolver.stats.action === "route_inner_layer_connection" &&
      innerRouteSolver.stats.status === "accepted"
    ) &&
    acceptedInnerRouteSteps < 100_000
  ) {
    solver.step()
    acceptedInnerRouteSteps++
  }
  expect(innerRouteSolver.stats.action).toBe("route_inner_layer_connection")
  expect(innerRouteSolver.stats.status).toBe("accepted")
  const acceptedInnerVisual = solver.visualize()
  expect(
    acceptedInnerVisual.lines?.some(
      (line) =>
        line.label === innerRouteSolver.stats.activeConnection &&
        line.layer === innerRouteSolver.stats.layer,
    ),
  ).toBe(true)

  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(topRouteSolver.iterations).toBeGreaterThan(100)
  expect(innerRouteSolver.iterations).toBeGreaterThan(100)
  assertParityOutput(input, solver.getOutput(), golden)
}, 120_000)
