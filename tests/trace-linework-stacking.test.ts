import { expect, test } from "bun:test"
import type { GraphicsObject } from "graphics-debug"
import { promoteTraceLinework } from "../lib/visualize/promoteTraceLinework"

test("trace strokes render after fills and before terminal markers", () => {
  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    rects: [
      {
        center: { x: 0, y: 0 },
        width: 4,
        height: 4,
        fill: "#cccccc",
        label: "copper pour",
      },
    ],
    circles: [
      {
        center: { x: 0, y: 0 },
        radius: 0.3,
        fill: "#ef4444",
        label: "BGA pad",
      },
      {
        center: { x: 1, y: 0 },
        radius: 0.2,
        fill: "#f59e0b",
        label: "plane via · terminal",
      },
      {
        center: { x: 4, y: 0 },
        radius: 0.2,
        fill: "#ef4444",
        label: "out-of-focus pad",
      },
    ],
    lines: [
      {
        points: [
          { x: -1, y: 0 },
          { x: 1, y: 0 },
        ],
        strokeWidth: 0.1,
        strokeColor: "#2563eb",
        strokeDash: [0.2, 0.1],
        layer: "top",
        label: "routed trace",
      },
    ],
  }

  const focusBounds = { minX: -1.2, maxX: 1.2, minY: -1, maxY: 1 }
  const promoted = promoteTraceLinework(graphics, focusBounds)
  const padIndex = promoted.polygons!.findIndex(
    (polygon) => polygon.label === "BGA pad",
  )
  const firstTraceIndex = promoted.polygons!.findIndex((polygon) =>
    polygon.label?.startsWith("foreground trace stroke"),
  )

  // graphics-debug renders rects before polygons and circles after polygons.
  // Within polygons, later entries paint on top of earlier entries.
  expect(promoted.rects?.[0]?.label).toBe("copper pour")
  expect(padIndex).toBeGreaterThanOrEqual(0)
  expect(firstTraceIndex).toBeGreaterThan(padIndex)
  expect(promoted.circles?.map((circle) => circle.label)).toEqual([
    "plane via · terminal",
    "out-of-focus pad",
  ])
  const tracePolygons = promoted.polygons!.filter((polygon) =>
    polygon.label?.startsWith("foreground trace"),
  )
  expect(tracePolygons.length).toBeGreaterThan(1)
  expect(
    tracePolygons
      .flatMap((polygon) => polygon.points)
      .every(
        (point) =>
          point.x >= focusBounds.minX - 1e-9 &&
          point.x <= focusBounds.maxX + 1e-9 &&
          point.y >= focusBounds.minY - 1e-9 &&
          point.y <= focusBounds.maxY + 1e-9,
      ),
  ).toBe(true)
})
