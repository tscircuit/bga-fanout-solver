import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import fixtureData from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"

const EXPECTED_FAILURE =
  "[build_residual_via_lines] all: SRJ routing maxX -15.091917 mm is below the ordered ViaLine requirement -10.070397 mm (3 bus-preserving strings; short by 5.021520 mm)"

test("exact index.circuit.tsx RAM capture preserves its consumer failure", () => {
  const input = structuredClone(fixtureData) as unknown as SimpleRouteJson
  const obstacleCountByComponentId = Object.groupBy(
    input.obstacles,
    (obstacle) => obstacle.componentId ?? "none",
  )

  expect(input.layerCount).toBe(8)
  expect(input.connections).toHaveLength(33)
  expect(input.obstacles).toHaveLength(1050)
  expect(input.traces).toHaveLength(0)
  expect(obstacleCountByComponentId.pcb_component_0).toHaveLength(373)
  expect(obstacleCountByComponentId.pcb_component_1).toHaveLength(200)
  expect(input.buses?.map((bus) => [bus.busId, bus.preferredLayer])).toEqual([
    ["DDR_BYTE0", "inner2"],
    ["DDR_BYTE1", "bottom"],
    ["DDR_COMMAND", "inner5"],
  ])
  expect(
    input.connections.filter(
      (connection) => connection.pointsToConnect[1]?.layer === "bottom",
    ),
  ).toHaveLength(11)
  expect(
    input.connections.filter(
      (connection) => connection.pointsToConnect[1]?.layer === "inner2",
    ),
  ).toHaveLength(11)
  expect(
    input.connections.filter(
      (connection) => connection.pointsToConnect[1]?.layer === "inner5",
    ),
  ).toHaveLength(11)

  const solver = new FixedTargetBgaFanoutSolver(input)
  expect(() => solver.solve()).toThrow(EXPECTED_FAILURE)
  expect(solver.failed).toBeTrue()
  expect(solver.error).toContain(EXPECTED_FAILURE)
  expect(solver.getCurrentStageName()).toBe("compatibilityRoute")
}, 120_000)
