import { clampLayerOffset } from "../../lib/visualize/clampLayerOffset"

export const parseLayerOffsetInput = (value: string): number => {
  const layerOffset = Number(value)
  return clampLayerOffset(layerOffset)
}
