import { expect, test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { assertParityOutput, loadFixture, loadGolden } from "./helpers"

test("SoC BGA preserves the validated 33-trace fixed-target fanout", async () => {
  const input = await loadFixture("am62l-soc-fanout")
  const golden = await loadGolden("am62l-soc-fanout")
  const solver = new FixedTargetBgaFanoutSolver(input)

  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(
    Object.values(solver.getStageStats()).every((stage) => stage.completed),
  ).toBe(true)
  expect(
    solver.getSolver("placeIndependentEarlyDropVias")?.iterations,
  ).toBeGreaterThan(100)
  expect(
    solver.getSolver("completeTopLayerRoutes")?.iterations,
  ).toBeGreaterThan(100)
  expect(
    solver.getSolver("routePrescribedInnerLayers")?.iterations,
  ).toBeGreaterThan(100)
  assertParityOutput(input, solver.getOutput(), golden)
}, 120_000)
