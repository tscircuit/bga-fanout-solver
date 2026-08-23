import { expect, test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { loadFixture, loadGolden, normalizeTraces } from "./helpers"

test("reversing SoC connection array order preserves semantic-order output", async () => {
  const input = await loadFixture("am62l-soc-fanout")
  const originalBusOrders = structuredClone(
    input.buses?.map((bus) => bus.connectionNames),
  )
  input.connections.reverse()
  const solver = new FixedTargetBgaFanoutSolver(input)

  solver.solve()

  expect(normalizeTraces(solver.getOutput().traces)).toEqual(
    normalizeTraces(await loadGolden("am62l-soc-fanout")),
  )
  expect(input.buses?.map((bus) => bus.connectionNames)).toEqual(
    originalBusOrders,
  )
}, 120_000)
