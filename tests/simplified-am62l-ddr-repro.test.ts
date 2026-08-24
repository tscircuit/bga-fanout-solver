import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import fixtureData from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"

const EXPECTED_FAILURE_PREFIX =
  "[route_top_layer_dogbones] breakout:pcb_breakout_point_9: no early-drop arrangement leaves a complete legal escape topology (23/33 total; best residual set 10/20;"

test("exact index.circuit.tsx SoC capture preserves its consumer failure", () => {
  const input = structuredClone(fixtureData) as unknown as SimpleRouteJson
  const obstacleCountByComponentId = Object.groupBy(
    input.obstacles,
    (obstacle) => obstacle.componentId ?? "none",
  )

  expect(input.layerCount).toBe(8)
  expect(input.connections).toHaveLength(33)
  expect(input.obstacles).toHaveLength(988)
  expect(input.traces).toHaveLength(0)
  expect(input.bounds).toEqual({
    minX: -8.650000000000002,
    maxX: 12.650000000000002,
    minY: -9.650000000000002,
    maxY: 11.650000000000002,
  })
  expect(obstacleCountByComponentId.pcb_component_0).toHaveLength(373)
  expect(obstacleCountByComponentId.pcb_component_1).toHaveLength(200)
  expect(input.obstacles.filter((obstacle) => obstacle.isCopperPour)).toEqual([
    expect.objectContaining({
      center: { x: 2, y: 1 },
      width: 21.300000000000004,
      height: 21.300000000000004,
      layers: ["inner1"],
    }),
    expect.objectContaining({
      center: { x: 2, y: 1 },
      width: 21.300000000000004,
      height: 21.300000000000004,
      layers: ["inner6"],
    }),
  ])
  expect(input.buses?.map((bus) => [bus.busId, bus.preferredLayer])).toEqual([
    ["DDR_BYTE0", "inner2"],
    ["DDR_BYTE1", "bottom"],
    ["DDR_COMMAND", "inner5"],
  ])
  expect(
    Object.groupBy(
      input.connections,
      (connection) => connection.pointsToConnect[1]?.layer ?? "none",
    ),
  ).toMatchObject({
    bottom: expect.any(Array),
    inner2: expect.any(Array),
    inner5: expect.any(Array),
  })
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
  expect(() => solver.solve()).toThrow(EXPECTED_FAILURE_PREFIX)
  expect(solver.failed).toBeTrue()
  expect(solver.error).toContain(EXPECTED_FAILURE_PREFIX)
  expect(solver.getCurrentStageName()).toBe("compatibilityRoute")
}, 120_000)
