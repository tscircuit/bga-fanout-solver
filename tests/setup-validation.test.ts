import { expect, test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { loadFixture } from "./helpers"

test("model validation fails loudly during pipeline setup", async () => {
  const input = await loadFixture("am62l-soc-fanout")
  input.obstacles = []
  const solver = new FixedTargetBgaFanoutSolver(input)

  solver.step()
  expect(() => solver.step()).toThrow(
    "[build_pad_topology/all] no source BGA component",
  )
  expect(solver.failed).toBe(true)
  expect(solver.error).toContain(
    "[build_pad_topology/all] no source BGA component",
  )
})
