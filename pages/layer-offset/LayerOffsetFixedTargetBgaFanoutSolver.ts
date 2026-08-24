import type { SimpleRouteJson } from "@tscircuit/core"
import type { GraphicsObject } from "graphics-debug"
import { FixedTargetBgaFanoutSolver } from "../../lib"
import { offsetGraphicsLayers } from "../../lib/visualize/offsetGraphicsLayers"

export class LayerOffsetFixedTargetBgaFanoutSolver extends FixedTargetBgaFanoutSolver {
  private readonly layerCount: number
  private readonly layerOffset: number

  constructor(input: SimpleRouteJson, layerOffset: number) {
    super(input)
    this.layerCount = input.layerCount
    this.layerOffset = layerOffset
  }

  override visualize(): GraphicsObject {
    return offsetGraphicsLayers(
      super.visualize(),
      this.layerCount,
      this.layerOffset,
    )
  }
}
