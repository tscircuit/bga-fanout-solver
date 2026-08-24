import type { GraphicsObject } from "graphics-debug"
import { clampLayerOffset } from "./clampLayerOffset"
import { getGraphicsLayerOffset } from "./getGraphicsLayerOffset"
import { offsetGraphicsPoint } from "./offsetGraphicsPoint"

export const offsetGraphicsLayers = (
  graphics: GraphicsObject,
  layerCount: number,
  layerOffset: number,
): GraphicsObject => {
  const normalizedLayerOffset = clampLayerOffset(layerOffset)
  if (normalizedLayerOffset === 0) {
    return graphics
  }

  const offsetGraphics = structuredClone(graphics)

  for (const point of offsetGraphics.points ?? []) {
    const offset = getGraphicsLayerOffset(
      point.layer,
      layerCount,
      normalizedLayerOffset,
    )
    offsetGraphicsPoint(point, offset)
  }

  for (const line of offsetGraphics.lines ?? []) {
    const offset = getGraphicsLayerOffset(
      line.layer,
      layerCount,
      normalizedLayerOffset,
    )
    for (const point of line.points) {
      offsetGraphicsPoint(point, offset)
    }
  }

  for (const line of offsetGraphics.infiniteLines ?? []) {
    const offset = getGraphicsLayerOffset(
      line.layer,
      layerCount,
      normalizedLayerOffset,
    )
    offsetGraphicsPoint(line.origin, offset)
  }

  for (const rect of offsetGraphics.rects ?? []) {
    const offset = getGraphicsLayerOffset(
      rect.layer,
      layerCount,
      normalizedLayerOffset,
    )
    offsetGraphicsPoint(rect.center, offset)
  }

  for (const circle of offsetGraphics.circles ?? []) {
    const offset = getGraphicsLayerOffset(
      circle.layer,
      layerCount,
      normalizedLayerOffset,
    )
    offsetGraphicsPoint(circle.center, offset)
  }

  for (const polygon of offsetGraphics.polygons ?? []) {
    const offset = getGraphicsLayerOffset(
      polygon.layer,
      layerCount,
      normalizedLayerOffset,
    )
    for (const point of polygon.points) {
      offsetGraphicsPoint(point, offset)
    }
  }

  for (const text of offsetGraphics.texts ?? []) {
    const offset = getGraphicsLayerOffset(
      text.layer,
      layerCount,
      normalizedLayerOffset,
    )
    offsetGraphicsPoint(text, offset)
  }

  return offsetGraphics
}
