import type { GraphicsObject } from "graphics-debug"
import { offsetGraphicsLayers } from "../../lib/visualize/offsetGraphicsLayers"
import { FullAm62lSocFailingReproSolver } from "../full-am62l-soc-failing-repro/FullAm62lSocFailingReproSolver"
import type { FullSocBreakoutProblem } from "../full-am62l-soc-failing-repro/types"

export class LayerOffsetFullAm62lSocFailingReproSolver extends FullAm62lSocFailingReproSolver {
  private readonly layerCount: number
  private readonly layerOffset: number

  constructor(problem: FullSocBreakoutProblem, layerOffset: number) {
    super(problem)
    this.layerCount = problem.solverInput.layerCount
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
