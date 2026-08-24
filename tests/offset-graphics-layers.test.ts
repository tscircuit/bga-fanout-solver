import { expect, test } from "bun:test"
import type { GraphicsObject } from "graphics-debug"
import { offsetGraphicsLayers } from "../lib/visualize/offsetGraphicsLayers"

test("layer offsets separate graphics diagonally without mutating the input", () => {
  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    points: [{ x: 1, y: 2, layer: "z2" }],
    lines: [
      {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        layer: "inner1",
      },
    ],
    infiniteLines: [
      {
        origin: { x: 1, y: 1 },
        directionVector: { x: 1, y: 0 },
        layer: "z3",
      },
    ],
    circles: [{ center: { x: 2, y: 3 }, radius: 1, layer: "bottom" }],
    rects: [{ center: { x: 4, y: 5 }, width: 1, height: 2 }],
    polygons: [
      {
        points: [
          { x: 0, y: 1 },
          { x: 2, y: 3 },
        ],
        layer: "z1,2",
      },
    ],
    texts: [{ x: 5, y: 6, text: "top", layer: "top" }],
  }

  const offset = offsetGraphicsLayers(graphics, 4, 0.5)

  expect(offset.points?.[0]).toMatchObject({ x: 2, y: 3 })
  expect(offset.lines?.[0]?.points).toEqual([
    { x: 0.5, y: 0.5 },
    { x: 1.5, y: 1.5 },
  ])
  expect(offset.infiniteLines?.[0]?.origin).toEqual({ x: 2.5, y: 2.5 })
  expect(offset.circles?.[0]?.center).toEqual({ x: 3.5, y: 4.5 })
  expect(offset.rects?.[0]?.center).toEqual({ x: 4, y: 5 })
  expect(offset.polygons?.[0]?.points).toEqual([
    { x: 0.5, y: 1.5 },
    { x: 2.5, y: 3.5 },
  ])
  expect(offset.texts?.[0]).toMatchObject({ x: 5, y: 6 })
  expect(graphics.points?.[0]).toMatchObject({ x: 1, y: 2 })
  expect(offsetGraphicsLayers(graphics, 4, -0.5)).toBe(graphics)
})
