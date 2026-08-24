import type { SimpleRouteJson } from "@tscircuit/core"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { buildFanoutModel } from "../model/buildFanoutModel"
import type { FanoutModel } from "../model/types"
import { visualizeInput } from "../visualize/inputVisuals"

export class BuildFanoutModelSolver extends BaseSolver {
  private output: FanoutModel | null = null

  constructor(private readonly input: SimpleRouteJson) {
    super()
    this.MAX_ITERATIONS = 2
  }

  override getConstructorParams() {
    return [structuredClone(this.input)]
  }

  override _step() {
    this.output = buildFanoutModel(this.input)
    this.stats = {
      action: "normalize_topology",
      componentId: this.output.componentId,
      pads: this.output.pads.length,
      connections: this.output.nets.length,
      escapeDirection: this.output.axisSign === 1 ? "right" : "left",
    }
    this.solved = true
  }

  override getOutput(): FanoutModel {
    if (!this.solved || !this.output) {
      throw new Error(
        "BuildFanoutModelSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeInput(this.input)
  }
}
