import type { SimpleRouteJson } from "@tscircuit/core"
import {
  BasePipelineSolver,
  definePipelineStep,
  type PipelineStep,
} from "@tscircuit/solver-utils"
import { type GraphicsObject, mergeGraphics } from "graphics-debug"
import { buildFanoutModel } from "./model/buildFanoutModel"
import type {
  BundleRepairPlan,
  BusGroupPlan,
  CorridorAnalysis,
  FanoutModel,
  FixedTargetBgaFanoutOutput,
  FreeSpaceAnalysis,
  InnerConnectorTemplatePlan,
  RankedFanoutModel,
  ScoredInnerConnectorTemplatePlan,
  ScoredTopConnectorTemplatePlan,
  TopConnectorTemplatePlan,
  ValidatedViaFirstRouteCandidate,
  ViaFirstFanoutPlan,
  ViaFirstRouteCandidate,
  ViaLineCandidatePlan,
  ViaLinePlan,
} from "./model/types"
import { AssignNetsToViasSolver } from "./stages/AssignNetsToViasSolver"
import { BuildOutputSolver } from "./stages/BuildOutputSolver"
import {
  CommitBundleRepairsSolver,
  EvaluateBundleRepairsSolver,
  ProposeBundleRepairsSolver,
} from "./stages/BundleRepairSolvers"
import {
  CommitInnerConnectorTemplatesSolver,
  CommitTopConnectorTemplatesSolver,
  EnumerateInnerConnectorTemplatesSolver,
  EnumerateTopConnectorTemplatesSolver,
  ScoreInnerConnectorTemplatesSolver,
  ScoreTopConnectorTemplatesSolver,
} from "./stages/ConnectorTemplateSolvers"
import { DeriveViaCorridorsSolver } from "./stages/DeriveViaCorridorsSolver"
import { DetectRouteConflictsSolver } from "./stages/DetectRouteConflictsSolver"
import { EnumerateViaLineCandidatesSolver } from "./stages/EnumerateViaLineCandidatesSolver"
import { FindFreeSpaceSolver } from "./stages/FindFreeSpaceSolver"
import { GroupBusConnectionsSolver } from "./stages/GroupBusConnectionsSolver"
import { PlaceViaRowsAndSlotsSolver } from "./stages/PlaceViaRowsAndSlotsSolver"
import { RankFanoutNetsSolver } from "./stages/RankFanoutNetsSolver"
import { StrictValidateRoutesSolver } from "./stages/StrictValidateRoutesSolver"
import { visualizeInput } from "./visualize/inputVisuals"

const FIND_FREE_SPACE = "findFreeSpace"
const DERIVE_VIA_CORRIDORS = "deriveViaCorridors"
const RANK_NETS = "rankFanoutNets"
const GROUP_BUS_CONNECTIONS = "groupBusConnections"
const ENUMERATE_VIA_LINE_CANDIDATES = "enumerateViaLineCandidates"
const PLACE_VIA_ROWS_AND_SLOTS = "placeViaRowsAndSlots"
const ASSIGN_NETS_TO_VIAS = "assignNetsToVias"
const ENUMERATE_TOP_TEMPLATES = "enumerateTopConnectorTemplates"
const SCORE_TOP_TEMPLATES = "scoreTopConnectorTemplates"
const COMMIT_TOP_TEMPLATES = "commitTopConnectorTemplates"
const ENUMERATE_INNER_TEMPLATES = "enumerateInnerConnectorTemplates"
const SCORE_INNER_TEMPLATES = "scoreInnerConnectorTemplates"
const COMMIT_INNER_TEMPLATES = "commitInnerConnectorTemplates"
const DETECT_INITIAL_CONFLICTS = "detectInitialConflicts"
const PROPOSE_BUNDLE_REPAIRS = "proposeBundleRepairs"
const EVALUATE_BUNDLE_REPAIRS = "evaluateBundleRepairs"
const COMMIT_BUNDLE_REPAIRS = "commitBundleRepairs"
const DETECT_REPAIRED_CONFLICTS = "detectRepairedConflicts"
const STRICT_VALIDATE_ROUTES = "strictValidateRoutes"
const BUILD_OUTPUT = "buildOutput"

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
      DERIVE_VIA_CORRIDORS,
      DeriveViaCorridorsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<FreeSpaceAnalysis>(FIND_FREE_SPACE),
      ],
    ),
    definePipelineStep(
      RANK_NETS,
      RankFanoutNetsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<CorridorAnalysis>(DERIVE_VIA_CORRIDORS),
      ],
    ),
    definePipelineStep(
      GROUP_BUS_CONNECTIONS,
      GroupBusConnectionsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<RankedFanoutModel>(RANK_NETS),
      ],
    ),
    definePipelineStep(
      ENUMERATE_VIA_LINE_CANDIDATES,
      EnumerateViaLineCandidatesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<BusGroupPlan>(GROUP_BUS_CONNECTIONS),
      ],
    ),
    definePipelineStep(
      PLACE_VIA_ROWS_AND_SLOTS,
      PlaceViaRowsAndSlotsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaLineCandidatePlan>(
          ENUMERATE_VIA_LINE_CANDIDATES,
        ),
      ],
    ),
    definePipelineStep(
      ASSIGN_NETS_TO_VIAS,
      AssignNetsToViasSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaLinePlan>(PLACE_VIA_ROWS_AND_SLOTS),
      ],
    ),
    definePipelineStep(
      ENUMERATE_TOP_TEMPLATES,
      EnumerateTopConnectorTemplatesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstFanoutPlan>(ASSIGN_NETS_TO_VIAS),
      ],
    ),
    definePipelineStep(
      SCORE_TOP_TEMPLATES,
      ScoreTopConnectorTemplatesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<TopConnectorTemplatePlan>(
          ENUMERATE_TOP_TEMPLATES,
        ),
      ],
    ),
    definePipelineStep(
      COMMIT_TOP_TEMPLATES,
      CommitTopConnectorTemplatesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ScoredTopConnectorTemplatePlan>(
          SCORE_TOP_TEMPLATES,
        ),
      ],
    ),
    definePipelineStep(
      ENUMERATE_INNER_TEMPLATES,
      EnumerateInnerConnectorTemplatesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(COMMIT_TOP_TEMPLATES),
      ],
    ),
    definePipelineStep(
      SCORE_INNER_TEMPLATES,
      ScoreInnerConnectorTemplatesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<InnerConnectorTemplatePlan>(
          ENUMERATE_INNER_TEMPLATES,
        ),
      ],
    ),
    definePipelineStep(
      COMMIT_INNER_TEMPLATES,
      CommitInnerConnectorTemplatesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ScoredInnerConnectorTemplatePlan>(
          SCORE_INNER_TEMPLATES,
        ),
      ],
    ),
    definePipelineStep(
      DETECT_INITIAL_CONFLICTS,
      DetectRouteConflictsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(
          COMMIT_INNER_TEMPLATES,
        ),
      ],
    ),
    definePipelineStep(
      PROPOSE_BUNDLE_REPAIRS,
      ProposeBundleRepairsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(
          DETECT_INITIAL_CONFLICTS,
        ),
      ],
    ),
    definePipelineStep(
      EVALUATE_BUNDLE_REPAIRS,
      EvaluateBundleRepairsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<BundleRepairPlan>(PROPOSE_BUNDLE_REPAIRS),
      ],
    ),
    definePipelineStep(
      COMMIT_BUNDLE_REPAIRS,
      CommitBundleRepairsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<BundleRepairPlan>(EVALUATE_BUNDLE_REPAIRS),
      ],
    ),
    definePipelineStep(
      DETECT_REPAIRED_CONFLICTS,
      DetectRouteConflictsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(
          COMMIT_BUNDLE_REPAIRS,
        ),
      ],
    ),
    definePipelineStep(
      STRICT_VALIDATE_ROUTES,
      StrictValidateRoutesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ViaFirstRouteCandidate>(
          DETECT_REPAIRED_CONFLICTS,
        ),
      ],
    ),
    definePipelineStep(
      BUILD_OUTPUT,
      BuildOutputSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<ValidatedViaFirstRouteCandidate>(
          STRICT_VALIDATE_ROUTES,
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
    if (!output) throw new Error(`${stageName} did not produce an output`)
    return output
  }

  override getOutput(): FixedTargetBgaFanoutOutput {
    if (!this.solved) {
      throw new Error(
        "FixedTargetBgaFanoutSolver output requested before completion",
      )
    }
    return this.requireStageOutput<FixedTargetBgaFanoutOutput>(BUILD_OUTPUT)
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
    return this.getSolver<BuildOutputSolver>(BUILD_OUTPUT)?.visualize() ?? null
  }
}
