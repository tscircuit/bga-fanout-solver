export const clampLayerOffset = (layerOffset: number): number => {
  if (!Number.isFinite(layerOffset) || layerOffset < 0) {
    return 0
  }

  return layerOffset
}
