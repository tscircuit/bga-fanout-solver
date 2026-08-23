import { expect, test } from "bun:test"
import { squaredDistance } from "../lib/private/reference/squared-distance"

test("early-drop distance ordering uses deterministic IEEE arithmetic", () => {
  const source = { x: -14.591917, y: -3.650917 }
  const leftCandidate = { x: -14.916917, y: -0.850917 }
  const rightCandidate = { x: -14.266917, y: -0.850917 }

  expect(
    squaredDistance(source, leftCandidate) -
      squaredDistance(source, rightCandidate),
  ).toBeLessThan(0)
})
