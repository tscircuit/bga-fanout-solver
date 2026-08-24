import type { SimpleRouteJson } from "@tscircuit/core"
import {
  BasePipelineSolver,
  definePipelineStep,
  type PipelineStep,
} from "@tscircuit/solver-utils"
import { type GraphicsObject, mergeGraphics } from "graphics-debug"
import { buildFanoutModel } from "./model/buildFanoutModel"
import type {
  FanoutModel,
  FixedTargetBgaFanoutOutput,
  FreeSpaceAnalysis,
  RankedFanoutModel,
  ViaFirstFanoutPlan,
  ViaFirstRouteCandidate,
} from "./model/types"
import { AssignViaLinesSolver } from "./stages/AssignViaLinesSolver"
import { ConnectBallToViaSolver } from "./stages/ConnectBallToViaSolver"
import { ConnectViaToTargetSolver } from "./stages/ConnectViaToTargetSolver"
import { FindFreeSpaceSolver } from "./stages/FindFreeSpaceSolver"
import { RankFanoutNetsSolver } from "./stages/RankFanoutNetsSolver"
import { RepairRouteConflictsSolver } from "./stages/RepairRouteConflictsSolver"
import { ValidateAndBuildOutputSolver } from "./stages/ValidateAndBuildOutputSolver"
import { visualizeInput } from "./visualize/inputVisuals"

const FIND_FREE_SPACE = "findFreeSpace"
const RANK_NETS = "rankFanoutNets"
const ASSIGN_VIA_LINES = "assignViaLines"
const CONNECT_BALL_TO_VIA = "connectBallToVia"
const CONNECT_VIA_TO_TARGET = "connectViaToTarget"
const REPAIR_ROUTE_CONFLICTS = "repairRouteConflicts"
const VALIDATE_AND_BUILD_OUTPUT = "validateAndBuildOutput"

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
      ASSIGN_VIA_LINES,
      AssignViaLinesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<RankedFanoutModel>(RANK_NETS),
      ],
    ),
    definePipelineStep(
      CONNECT_BALL_TO_VIA,
      ConnectBallToViaSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstFanoutPlan>(ASSIGN_VIA_LINES),
      ],
    ),
    definePipelineStep(
      CONNECT_VIA_TO_TARGET,
      ConnectViaToTargetSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(CONNECT_BALL_TO_VIA),
      ],
    ),
    definePipelineStep(
      REPAIR_ROUTE_CONFLICTS,
      RepairRouteConflictsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(
          CONNECT_VIA_TO_TARGET,
        ),
      ],
    ),
    definePipelineStep(
      VALIDATE_AND_BUILD_OUTPUT,
      ValidateAndBuildOutputSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(
          REPAIR_ROUTE_CONFLICTS,
        ),
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
      VALIDATE_AND_BUILD_OUTPUT,
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
      this.getSolver<ValidateAndBuildOutputSolver>(
        VALIDATE_AND_BUILD_OUTPUT,
      )?.visualize() ?? null
    )
  }
}
