export const getGraphicsLayerIndex = (
  layer: string | undefined,
  layerCount: number,
): number | null => {
  if (!layer) {
    return null
  }

  const firstLayer = layer.split(",")[0]
  if (!firstLayer) {
    return null
  }

  const zLayerMatch = /^z(\d+)$/.exec(firstLayer)
  if (zLayerMatch) {
    return Number(zLayerMatch[1])
  }
  if (firstLayer === "top") {
    return 0
  }
  if (firstLayer === "bottom") {
    return layerCount - 1
  }

  const innerLayerMatch = /^inner(\d+)$/.exec(firstLayer)
  if (innerLayerMatch) {
    return Number(innerLayerMatch[1])
  }

  return null
}
