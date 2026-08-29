import { expect, test } from "bun:test"
import { CompleteTopLayerRoutesSolver } from "../lib/stages/ReferenceRoutingStageSolvers"

test("ViaLine depths form deterministic odd and even compact V envelopes", () => {
  const depths = (groupCount: number) =>
    Array.from({ length: groupCount }, (_, groupIndex) =>
      CompleteTopLayerRoutesSolver.getViaLineDepthRank(
        groupIndex,
        groupCount,
      ),
    )

  expect(depths(5)).toEqual([1, 2, 3, 2, 1])
  expect(depths(6)).toEqual([1, 2, 3, 3, 2, 1])
  expect(depths(8)).toEqual([
    2, 3, 4, 5, 5, 4, 3, 2,
  ])
  expect(depths(5).every((depth, index, all) => depth === all.at(-1 - index)))
    .toBe(true)
})
