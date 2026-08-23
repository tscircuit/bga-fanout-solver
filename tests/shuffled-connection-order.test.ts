import { expect, test } from "bun:test"
import { FixedTargetBgaFanoutSolver } from "../lib"
import {
  loadFixture,
  loadGolden,
  normalizeTraces,
  shuffleConnections,
} from "./helpers"

test("seeded-shuffled RAM connections preserve semantic-order output", async () => {
  const original = await loadFixture("lpddr4-ram-fanout")
  const input = shuffleConnections(original, 0x62_4c_5044)
  const solver = new FixedTargetBgaFanoutSolver(input)

  solver.solve()

  expect(normalizeTraces(solver.getOutput().traces)).toEqual(
    normalizeTraces(await loadGolden("lpddr4-ram-fanout")),
  )
  expect(input.buses?.map((bus) => bus.connectionNames)).toEqual(
    original.buses?.map((bus) => bus.connectionNames),
  )
}, 120_000)
