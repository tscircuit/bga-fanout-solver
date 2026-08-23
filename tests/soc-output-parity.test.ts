import { test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { assertParityOutput, loadFixture, loadGolden } from "./helpers"

test("SoC BGA preserves the validated 33-trace fixed-target fanout", async () => {
  const input = await loadFixture("am62l-soc-fanout")
  const golden = await loadGolden("am62l-soc-fanout")
  const solver = new FixedTargetBgaFanoutSolver(input)

  solver.solve()

  assertParityOutput(input, solver.getOutput(), golden)
}, 120_000)
