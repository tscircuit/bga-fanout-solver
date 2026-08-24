import { getGraphicsLayerIndex } from "./getGraphicsLayerIndex"

export const getGraphicsLayerOffset = (
  layer: string | undefined,
  layerCount: number,
  layerOffset: number,
): number => {
  const layerIndex = getGraphicsLayerIndex(layer, layerCount)
  if (layerIndex === null) {
    return 0
  }

  return layerIndex * layerOffset
}
