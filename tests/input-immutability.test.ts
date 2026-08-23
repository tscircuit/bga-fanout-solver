import { expect, test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { loadFixture } from "./helpers"

test("solving does not mutate the supplied SRJ", async () => {
  const input = await loadFixture("am62l-soc-fanout")
  const snapshot = structuredClone(input)
  const solver = new FixedTargetBgaFanoutSolver(input)

  solver.solve()

  expect(input).toEqual(snapshot)
}, 120_000)
