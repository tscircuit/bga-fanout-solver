import type { SimpleRouteJson } from "@tscircuit/core"
import {
  BasePipelineSolver,
  definePipelineStep,
  type PipelineStep,
} from "@tscircuit/solver-utils"
import { mergeGraphics, type GraphicsObject } from "graphics-debug"
import type {
  FanoutModel,
  FixedTargetBgaFanoutOutput,
  FreeSpaceAnalysis,
  FreeSpaceRegions,
  FreeSpaceSample,
  RankedFanoutModel,
} from "./model/types"
import type { IncrementalReferenceFanoutSession } from "./private/reference/solve-am62l-free-space-fanout"
import { BuildFanoutModelSolver } from "./stages/BuildFanoutModelSolver"
import { PlanCopperPourViaDropsSolver } from "./stages/PlanCopperPourViaDropsSolver"
import {
  PlanSameNetPadClustersSolver,
  type PowerPlanePlanningContext,
} from "./stages/PlanSameNetPadClustersSolver"
import {
  DiscoverFreeSpaceRegionsSolver,
  PackFreeSpaceRegionsSolver,
  SampleFreeSpaceCellsSolver,
} from "./stages/FindFreeSpaceSolver"
import { RankFanoutNetsSolver } from "./stages/RankFanoutNetsSolver"
import { ResolvePowerSignalConflictsSolver } from "./stages/ResolvePowerSignalConflictsSolver"
import {
  AssignPrescribedLayersSolver,
  BuildReferenceOutputSolver,
  CompleteTopLayerRoutesSolver,
  InitializeReferenceRoutingSolver,
  MiterRouteCornersSolver,
  PlaceIndependentEarlyDropViasSolver,
  RoutePrescribedInnerLayersSolver,
  ValidateReferenceRoutesSolver,
} from "./stages/ReferenceRoutingStageSolvers"
import { visualizeInput } from "./visualize/inputVisuals"
import {
  promoteTraceLinework,
  type TraceLineworkFocusBounds,
} from "./visualize/promoteTraceLinework"
import { LOCAL_CONNECTION_GUIDE_LABEL } from "./visualize/simpleRouteJsonVisuals"

const BUILD_FANOUT_MODEL = "buildFanoutModel"
const PLAN_SAME_NET_PAD_CLUSTERS = "planSameNetPadClusters"
const PLAN_COPPER_POUR_VIA_DROPS = "planCopperPourViaDrops"
const RESOLVE_POWER_SIGNAL_CONFLICTS = "resolvePowerSignalConflicts"
const SAMPLE_FREE_SPACE_CELLS = "sampleFreeSpaceCells"
const DISCOVER_FREE_SPACE_REGIONS = "discoverFreeSpaceRegions"
const PACK_FREE_SPACE_REGIONS = "packFreeSpaceRegions"
const RANK_NETS = "rankFanoutNets"
const INITIALIZE_REFERENCE_ROUTING = "initializeReferenceRouting"
const PLACE_EARLY_DROPS = "placeIndependentEarlyDropVias"
const COMPLETE_TOP_ROUTES = "completeTopLayerRoutes"
const ASSIGN_PRESCRIBED_LAYERS = "assignPrescribedLayers"
const ROUTE_PRESCRIBED_LAYERS = "routePrescribedInnerLayers"
const MITER_ROUTE_CORNERS = "miterRouteCorners"
const VALIDATE_ROUTES = "validateReconstructedGeometry"
const BUILD_OUTPUT = "buildOutput"

export class FixedTargetBgaFanoutSolver extends BasePipelineSolver<SimpleRouteJson> {
  private readonly inputVisualization: GraphicsObject

  override pipelineDef: PipelineStep<any>[] = [
    definePipelineStep(
      BUILD_FANOUT_MODEL,
      BuildFanoutModelSolver,
      (solver: FixedTargetBgaFanoutSolver) => [solver.inputProblem],
    ),
    definePipelineStep(
      SAMPLE_FREE_SPACE_CELLS,
      SampleFreeSpaceCellsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<FanoutModel>(BUILD_FANOUT_MODEL),
      ],
    ),
    definePipelineStep(
      DISCOVER_FREE_SPACE_REGIONS,
      DiscoverFreeSpaceRegionsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<FreeSpaceSample>(SAMPLE_FREE_SPACE_CELLS),
      ],
    ),
    definePipelineStep(
      PACK_FREE_SPACE_REGIONS,
      PackFreeSpaceRegionsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<FreeSpaceRegions>(
          DISCOVER_FREE_SPACE_REGIONS,
        ),
      ],
    ),
    definePipelineStep(
      RANK_NETS,
      RankFanoutNetsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<FreeSpaceAnalysis>(PACK_FREE_SPACE_REGIONS),
      ],
    ),
    definePipelineStep(
      INITIALIZE_REFERENCE_ROUTING,
      InitializeReferenceRoutingSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<RankedFanoutModel>(RANK_NETS),
      ],
    ),
    definePipelineStep(
      PLACE_EARLY_DROPS,
      PlaceIndependentEarlyDropViasSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          INITIALIZE_REFERENCE_ROUTING,
        ),
      ],
    ),
    definePipelineStep(
      COMPLETE_TOP_ROUTES,
      CompleteTopLayerRoutesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          PLACE_EARLY_DROPS,
        ),
      ],
    ),
    definePipelineStep(
      ASSIGN_PRESCRIBED_LAYERS,
      AssignPrescribedLayersSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          COMPLETE_TOP_ROUTES,
        ),
      ],
    ),
    definePipelineStep(
      ROUTE_PRESCRIBED_LAYERS,
      RoutePrescribedInnerLayersSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          ASSIGN_PRESCRIBED_LAYERS,
        ),
      ],
    ),
    definePipelineStep(
      MITER_ROUTE_CORNERS,
      MiterRouteCornersSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          ROUTE_PRESCRIBED_LAYERS,
        ),
      ],
    ),
    definePipelineStep(
      VALIDATE_ROUTES,
      ValidateReferenceRoutesSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          MITER_ROUTE_CORNERS,
        ),
      ],
    ),
    definePipelineStep(
      PLAN_SAME_NET_PAD_CLUSTERS,
      PlanSameNetPadClustersSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          VALIDATE_ROUTES,
        ),
      ],
    ),
    definePipelineStep(
      PLAN_COPPER_POUR_VIA_DROPS,
      PlanCopperPourViaDropsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<PowerPlanePlanningContext>(
          PLAN_SAME_NET_PAD_CLUSTERS,
        ),
      ],
    ),
    definePipelineStep(
      RESOLVE_POWER_SIGNAL_CONFLICTS,
      ResolvePowerSignalConflictsSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        {
          rankedModel: solver.requireStageOutput<RankedFanoutModel>(RANK_NETS),
          initialContext: solver.requireStageOutput<PowerPlanePlanningContext>(
            PLAN_SAME_NET_PAD_CLUSTERS,
          ),
          baselineSession:
            solver.requireStageOutput<IncrementalReferenceFanoutSession>(
              PLAN_COPPER_POUR_VIA_DROPS,
            ),
        },
      ],
    ),
    definePipelineStep(
      BUILD_OUTPUT,
      BuildReferenceOutputSolver,
      (solver: FixedTargetBgaFanoutSolver) => [
        solver.requireStageOutput<IncrementalReferenceFanoutSession>(
          RESOLVE_POWER_SIGNAL_CONFLICTS,
        ),
      ],
    ),
  ]

  constructor(input: SimpleRouteJson) {
    super(structuredClone(input))
    this.MAX_ITERATIONS = 10_000_000
    this.inputVisualization = visualizeInput(this.inputProblem)
  }

  override getConstructorParams() {
    return [structuredClone(this.inputProblem)]
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

  private getTraceLineworkFocusBounds(
    model: FanoutModel,
  ): TraceLineworkFocusBounds {
    const horizontalBounds = [
      model.axisSign * model.padBounds.minX,
      model.axisSign * model.padBounds.maxX,
    ]
    const focusPadding = Math.max(model.rules.viaDiameter, 0.25)
    return {
      minX: Math.min(...horizontalBounds) - focusPadding,
      maxX: Math.max(...horizontalBounds) + focusPadding,
      minY: model.padBounds.minY - focusPadding,
      maxY: model.padBounds.maxY + focusPadding,
    }
  }

  override visualize(): GraphicsObject {
    const action = String(this.activeSubSolver?.stats.action ?? "")
    const searchIsActive =
      action.includes("_grid_node") || action.includes("_neighbor")
    const inputVisualization = searchIsActive
      ? {
          ...this.inputVisualization,
          lines: this.inputVisualization.lines?.map((line) =>
            line.label?.startsWith(LOCAL_CONNECTION_GUIDE_LABEL)
              ? {
                  ...line,
                  strokeColor: "rgba(148, 163, 184, 0.16)",
                  strokeWidth: 0.007,
                }
              : line,
          ),
        }
      : this.inputVisualization
    const model = this.getStageOutput<FanoutModel>(BUILD_FANOUT_MODEL)
    if (!model) return mergeGraphics(inputVisualization, super.visualize())
    return promoteTraceLinework(
      mergeGraphics(inputVisualization, super.visualize()),
      this.getTraceLineworkFocusBounds(model),
    )
  }

  override preview(): GraphicsObject {
    return this.visualize()
  }

  override finalVisualize(): GraphicsObject | null {
    const signalVisualization =
      this.getSolver<BuildReferenceOutputSolver>(BUILD_OUTPUT)?.visualize()
    if (!signalVisualization) return null

    const clusterVisualization = this.getSolver<PlanSameNetPadClustersSolver>(
      PLAN_SAME_NET_PAD_CLUSTERS,
    )?.visualize()
    const viaDropVisualization = this.getSolver<PlanCopperPourViaDropsSolver>(
      PLAN_COPPER_POUR_VIA_DROPS,
    )?.visualize()
    const clusterGeometry = clusterVisualization
      ? {
          ...clusterVisualization,
          // The via-drop panel already summarizes the completed power plan.
          // Keep cluster geometry without stacking a second panel over it.
          rects: [],
          texts: [],
        }
      : { coordinateSystem: "cartesian" as const }
    const finalVisualization = mergeGraphics(
      mergeGraphics(signalVisualization, clusterGeometry),
      viaDropVisualization ?? { coordinateSystem: "cartesian" },
    )
    const model = this.getStageOutput<FanoutModel>(BUILD_FANOUT_MODEL)
    return model
      ? promoteTraceLinework(
          finalVisualization,
          this.getTraceLineworkFocusBounds(model),
        )
      : finalVisualization
  }
}
