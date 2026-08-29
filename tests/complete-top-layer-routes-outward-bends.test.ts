import { expect, test } from "bun:test"
import { CompleteTopLayerRoutesSolver } from "../lib/stages/ReferenceRoutingStageSolvers"

test("CompleteTopLayerRoutesSolver bends ViaLines away from the middle", () => {
  expect(CompleteTopLayerRoutesSolver.getViaLineVerticalDirection(-1, 0)).toBe(
    -1,
  )
  expect(CompleteTopLayerRoutesSolver.getViaLineVerticalDirection(0, 0)).toBe(
    1,
  )
  expect(CompleteTopLayerRoutesSolver.getViaLineVerticalDirection(1, 0)).toBe(
    1,
  )
  expect(
    [0, 1, 2].map((slotIndex) =>
      CompleteTopLayerRoutesSolver.getViaLineSlotIndex(slotIndex, 3, -1),
    ),
  ).toEqual([0, 1, 2])
  expect(
    [0, 1, 2].map((slotIndex) =>
      CompleteTopLayerRoutesSolver.getViaLineSlotIndex(slotIndex, 3, 1),
    ),
  ).toEqual([2, 1, 0])
})
