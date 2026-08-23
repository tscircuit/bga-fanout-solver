import { expect, test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { loadFixture } from "./helpers"

test("output is guarded and stepping a solved pipeline is a no-op", async () => {
  const solver = new FixedTargetBgaFanoutSolver(
    await loadFixture("lpddr4-ram-fanout"),
  )
  expect(() => solver.getOutput()).toThrow("before completion")
  expect(solver.pipelineDef.map((stage) => stage.solverName)).toEqual([
    "findFreeSpace",
    "rankFanoutNets",
    "compatibilityRoute",
  ])
  solver.step()
  expect(solver.getCurrentStageName()).toBe("findFreeSpace")
  expect(() => solver.getOutput()).toThrow("before completion")

  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const completedIterations = solver.iterations
  expect(solver.visualize().circles?.length).toBeGreaterThan(0)

  solver.step()
  expect(solver.iterations).toBe(completedIterations)
}, 120_000)
