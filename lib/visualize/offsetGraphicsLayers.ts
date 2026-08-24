import type { GraphicsObject } from "graphics-debug"

const getLayerIndex = (
  layer: string | undefined,
  layerCount: number,
): number | null => {
  if (!layer) return null

  const firstLayer = layer.split(",")[0]
  const zLayerMatch = /^z(\d+)$/.exec(firstLayer ?? "")
  if (zLayerMatch) return Number(zLayerMatch[1])
  if (firstLayer === "top") return 0
  if (firstLayer === "bottom") return layerCount - 1

  const innerLayerMatch = /^inner(\d+)$/.exec(firstLayer ?? "")
  return innerLayerMatch ? Number(innerLayerMatch[1]) : null
}

const getOffset = (
  layer: string | undefined,
  layerCount: number,
  layerOffset: number,
): number => (getLayerIndex(layer, layerCount) ?? 0) * layerOffset

const offsetPoint = (
  point: { x: number; y: number },
  offset: number,
): { x: number; y: number } => ({
  ...point,
  x: point.x + offset,
  y: point.y + offset,
})

export const offsetGraphicsLayers = (
  graphics: GraphicsObject,
  layerCount: number,
  layerOffset: number,
): GraphicsObject => {
  if (!Number.isFinite(layerOffset) || layerOffset === 0) return graphics

  return {
    ...graphics,
    points: graphics.points?.map((point) =>
      offsetPoint(point, getOffset(point.layer, layerCount, layerOffset)),
    ),
    lines: graphics.lines?.map((line) => {
      const offset = getOffset(line.layer, layerCount, layerOffset)
      return {
        ...line,
        points: line.points.map((point) => offsetPoint(point, offset)),
      }
    }),
    infiniteLines: graphics.infiniteLines?.map((line) => ({
      ...line,
      origin: offsetPoint(
        line.origin,
        getOffset(line.layer, layerCount, layerOffset),
      ),
    })),
    rects: graphics.rects?.map((rect) => ({
      ...rect,
      center: offsetPoint(
        rect.center,
        getOffset(rect.layer, layerCount, layerOffset),
      ),
    })),
    circles: graphics.circles?.map((circle) => ({
      ...circle,
      center: offsetPoint(
        circle.center,
        getOffset(circle.layer, layerCount, layerOffset),
      ),
    })),
    polygons: graphics.polygons?.map((polygon) => {
      const offset = getOffset(polygon.layer, layerCount, layerOffset)
      return {
        ...polygon,
        points: polygon.points.map((point) => offsetPoint(point, offset)),
      }
    }),
    texts: graphics.texts?.map((text) => {
      const offset = getOffset(text.layer, layerCount, layerOffset)
      return {
        ...text,
        x: text.x + offset,
        y: text.y + offset,
      }
    }),
  }
}
