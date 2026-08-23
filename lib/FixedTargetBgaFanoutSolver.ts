import type { SimpleRouteJson } from "@tscircuit/core"
import {
  BasePipelineSolver,
  definePipelineStep,
  type PipelineStep,
} from "@tscircuit/solver-utils"
import { mergeGraphics, type GraphicsObject } from "graphics-debug"
import { buildFanoutModel } from "./model/buildFanoutModel"
import type {
  FanoutModel,
  FixedTargetBgaFanoutOutput,
  FreeSpaceAnalysis,
  RankedFanoutModel,
} from "./model/types"
import { CompatibilityRouteSolver } from "./private/CompatibilityRouteSolver"
import { FindFreeSpaceSolver } from "./stages/FindFreeSpaceSolver"
import { RankFanoutNetsSolver } from "./stages/RankFanoutNetsSolver"
import { visualizeInput } from "./visualize/inputVisuals"

const FIND_FREE_SPACE = "findFreeSpace"
const RANK_NETS = "rankFanoutNets"
const COMPATIBILITY_ROUTE = "compatibilityRoute"

export class FixedTargetBgaFanoutSolver extends BasePipelineSolver<SimpleRouteJson> {
  private fanoutModel: FanoutModel | null = null
  private readonly inputVisualization: GraphicsObject
  private setupError: unknown | null = null

  override pipelineDef: PipelineStep<any>[] = [
    definePipelineStep(
      FIND_FREE_SPACE,
      FindFreeSpaceSolver,
      (solver: FixedTargetBgaFanoutSolver) => [solver.requireFanoutModel()],
    ),
    definePipelineStep(
      RANK_NETS,
      RankFanoutNetsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<FreeSpaceAnalysis>(FIND_FREE_SPACE),
      ],
    ),
    definePipelineStep(
      COMPATIBILITY_ROUTE,
      CompatibilityRouteSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        {
          input: solver.inputProblem,
          rankedModel: solver.requireStageOutput<RankedFanoutModel>(RANK_NETS),
        },
      ],
    ),
  ]

  constructor(input: SimpleRouteJson) {
    super(structuredClone(input))
    this.inputVisualization = visualizeInput(this.inputProblem)
  }

  override _setup() {
    try {
      this.fanoutModel = buildFanoutModel(this.inputProblem)
    } catch (error) {
      this.setupError = error
    }
  }

  override _step() {
    if (this.setupError) throw this.setupError
    super._step()
  }

  override getConstructorParams() {
    return [structuredClone(this.inputProblem)]
  }

  private requireFanoutModel(): FanoutModel {
    if (!this.fanoutModel) {
      throw new Error("fanout model requested before solver setup")
    }
    return this.fanoutModel
  }

  private requireStageOutput<T>(stageName: string): T {
    const output = this.getStageOutput<T>(stageName)
    if (!output) {
      throw new Error(`${stageName} did not produce an output`)
    }
    return output
  }

  override getOutput(): FixedTargetBgaFanoutOutput {
    if (!this.solved) {
      throw new Error(
        "FixedTargetBgaFanoutSolver output requested before completion",
      )
    }
    return this.requireStageOutput<FixedTargetBgaFanoutOutput>(
      COMPATIBILITY_ROUTE,
    )
  }

  override initialVisualize(): null {
    return null
  }

  override visualize(): GraphicsObject {
    return mergeGraphics(this.inputVisualization, super.visualize())
  }

  override preview(): GraphicsObject {
    return this.visualize()
  }

  override finalVisualize(): GraphicsObject | null {
    return (
      this.getSolver<CompatibilityRouteSolver>(
        COMPATIBILITY_ROUTE,
      )?.visualize() ?? null
    )
  }
}
