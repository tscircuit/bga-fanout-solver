import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import fixtureData from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"

const EXPECTED_FAILURE =
  "[build_residual_via_lines] all: SRJ routing maxX -4.350000 mm is below the ordered ViaLine requirement 6.695440 mm (7 bus-preserving strings; short by 11.045440 mm)"

test("simplified AM62L 8-layer DDR breakout preserves its consumer failure", () => {
  const input = structuredClone(fixtureData) as unknown as SimpleRouteJson

  expect(input.layerCount).toBe(8)
  expect(input.connections).toHaveLength(33)
  expect(input.obstacles).toHaveLength(373)
  expect(input.buses?.map((bus) => [bus.busId, bus.preferredLayer])).toEqual([
    ["DDR_BYTE0", "inner2"],
    ["DDR_BYTE1", "bottom"],
    ["DDR_COMMAND", "inner5"],
  ])

  const solver = new FixedTargetBgaFanoutSolver(input)
  expect(() => solver.solve()).toThrow(EXPECTED_FAILURE)
  expect(solver.failed).toBeTrue()
  expect(solver.error).toContain(EXPECTED_FAILURE)
  expect(solver.getCurrentStageName()).toBe("compatibilityRoute")
}, 120_000)
