import { test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { assertParityOutput, loadFixture, loadGolden } from "./helpers"

test("RAM BGA preserves the validated 33-trace fixed-target fanout", async () => {
  const input = await loadFixture("lpddr4-ram-fanout")
  const golden = await loadGolden("lpddr4-ram-fanout")
  const solver = new FixedTargetBgaFanoutSolver(input)

  solver.solve()

  assertParityOutput(input, solver.getOutput(), golden)
}, 120_000)
