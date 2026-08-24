export const normalizeLayerOffsetInput = (value: string): string => {
  if (value === "") {
    return ""
  }

  const layerOffset = Number(value)
  if (!Number.isFinite(layerOffset)) {
    return ""
  }
  if (layerOffset < 0) {
    return "0"
  }

  return value
}
