import { expect } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"

export const expectedLayerCounts = {
  bottom: 5,
  inner1: 4,
  inner2: 5,
  inner3: 5,
  inner4: 5,
  inner5: 5,
  inner6: 4,
}

export const expectedPreferredLayers = [
  ["inner2", "inner3", "inner4", "inner5", "inner6", "bottom", "inner1"],
  ["inner4", "inner5", "inner6", "bottom", "inner1", "inner2", "inner3"],
  ["bottom", "inner1", "inner2", "inner3", "inner4", "inner5", "inner6"],
]

export const expectFixedLayerDistribution = (input: SimpleRouteJson) => {
  expect(input.buses?.map((bus) => bus.preferredLayers)).toEqual(
    expectedPreferredLayers,
  )
  expect(
    Object.fromEntries(
      Object.entries(
        Object.groupBy(
          input.connections,
          (connection) => connection.pointsToConnect[1]!.layer,
        ),
      ).map(([layer, connections]) => [layer, connections?.length]),
    ),
  ).toEqual(expectedLayerCounts)
}

export const expectBothCopperPours = (
  input: SimpleRouteJson,
  capturedInput: SimpleRouteJson,
) => {
  expect(input.obstacles.filter((obstacle) => obstacle.isCopperPour)).toEqual(
    capturedInput.obstacles.filter((obstacle) => obstacle.isCopperPour),
  )
}
