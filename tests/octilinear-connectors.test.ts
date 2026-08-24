import { expect, test } from "bun:test"
import {
  getOctilinearTemplates,
  isOctilinearSegment,
  pathSegments,
} from "../lib/routing/routeGeometry"

test("point-to-point templates are deterministic, exact, and octilinear", () => {
  const start = { x: 1.25, y: -0.5 }
  const end = { x: 5.75, y: 1.25 }
  const laneYs = [-1.5, 0.25, 2.5]

  const first = getOctilinearTemplates(start, end, laneYs)
  const second = getOctilinearTemplates(start, end, laneYs)

  expect(first).toEqual(second)
  expect(first.length).toBeGreaterThan(0)
  expect(new Set(first.map((path) => JSON.stringify(path))).size).toBe(
    first.length,
  )
  for (const path of first) {
    expect(path[0]).toEqual(start)
    expect(path.at(-1)).toEqual(end)
    expect(
      pathSegments(path).every((segment) =>
        isOctilinearSegment(segment.a, segment.b),
      ),
    ).toBeTrue()
  }
})
