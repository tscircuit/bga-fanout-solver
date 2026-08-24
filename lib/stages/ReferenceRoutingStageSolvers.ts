import { BaseSolver } from "@tscircuit/solver-utils"
import { mergeGraphics, type GraphicsObject } from "graphics-debug"
import type {
  FixedTargetBgaFanoutOutput,
  RankedFanoutModel,
} from "../model/types"
import { fromCanonical } from "../model/geometry"
import { AM62L_FREE_SPACE_FANOUT_PHASES } from "../private/reference/am62l-free-space-fanout"
import {
  IncrementalReferenceFanoutSession,
  type ReferenceRouteSnapshot,
  type ReferenceSearchStep,
} from "../private/reference/solve-am62l-free-space-fanout"
import { layerColor, visualizeModel } from "../visualize/modelVisuals"

export class InitializeReferenceRoutingSolver extends BaseSolver {
  private output: IncrementalReferenceFanoutSession | null = null

  constructor(private readonly rankedModel: RankedFanoutModel) {
    super()
    this.MAX_ITERATIONS = 2
  }

  override getConstructorParams() {
    return [this.rankedModel]
  }

  override _step() {
    this.output = new IncrementalReferenceFanoutSession(this.rankedModel)
    this.stats = {
      action: "initialize_reference_routing",
      status: "completed",
      connections: this.rankedModel.model.nets.length,
      freeCells: this.rankedModel.freeCells.length,
    }
    this.solved = true
  }

  override getOutput(): IncrementalReferenceFanoutSession {
    if (!this.solved || !this.output) {
      throw new Error(
        "InitializeReferenceRoutingSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeModel({
      model: this.rankedModel.model,
      freeCells: this.rankedModel.freeCells,
      rankedNets: this.rankedModel.model.nets,
    })
  }
}

const visualizeRoutes = (
  session: IncrementalReferenceFanoutSession,
  routes: readonly ReferenceRouteSnapshot[],
  activeConnection: string | null,
  activePoint?: { x: number; y: number },
): GraphicsObject => {
  const context = session.getVisualizationContext()
  const world = (point: { x: number; y: number }) =>
    fromCanonical(context.model.axisSign, point)
  const lines: NonNullable<GraphicsObject["lines"]> = []
  const circles: NonNullable<GraphicsObject["circles"]> = []

  for (const route of routes) {
    const active = route.connectionName === activeConnection
    for (let index = 1; index < route.topPath.length; index++) {
      lines.push({
        points: [
          world(route.topPath[index - 1]!),
          world(route.topPath[index]!),
        ],
        strokeWidth: active
          ? context.model.rules.traceWidth * 1.8
          : context.model.rules.traceWidth,
        strokeColor: layerColor("top"),
        layer: "top",
        label: route.connectionName,
      })
    }
    for (let index = 1; index < route.innerPath.length; index++) {
      lines.push({
        points: [
          world(route.innerPath[index - 1]!),
          world(route.innerPath[index]!),
        ],
        strokeWidth: active
          ? context.model.rules.traceWidth * 1.8
          : context.model.rules.traceWidth,
        strokeColor: layerColor(route.selectedLayer),
        layer: route.selectedLayer,
        label: route.connectionName,
      })
    }
    circles.push({
      center: world(route.via),
      radius: context.model.rules.viaDiameter / 2,
      fill: active ? "#facc15" : "#f59e0b",
      stroke: active ? "#b45309" : "#78350f",
      label: `${route.connectionName} · ${route.kind}`,
    })
  }

  if (activePoint) {
    circles.push({
      center: world(activePoint),
      radius: context.model.rules.viaDiameter * 0.68,
      fill: "#fde047",
      stroke: "#a16207",
      label: "active search candidate",
    })
  }

  return mergeGraphics(
    visualizeModel({
      model: context.model,
      freeCells: context.freeCells,
      rankedNets: context.model.nets,
    }),
    { coordinateSystem: "cartesian", lines, circles },
  )
}

abstract class IncrementalReferenceSearchSolver extends BaseSolver {
  protected currentSearchStep: ReferenceSearchStep | null = null

  constructor(protected readonly session: IncrementalReferenceFanoutSession) {
    super()
    this.MAX_ITERATIONS = 10_000_000
  }

  protected abstract advanceSearch(): boolean

  override getConstructorParams() {
    return [this.session]
  }

  override _step() {
    const completed = this.advanceSearch()
    this.currentSearchStep = this.session.getLastSearchStep()
    this.stats = {
      action: this.currentSearchStep?.action ?? "initialize_search",
      status: this.currentSearchStep?.status ?? "candidate",
      activeConnection: this.currentSearchStep?.connectionName ?? null,
      activeCandidate: this.currentSearchStep?.candidateId ?? null,
      reason: this.currentSearchStep?.reason ?? null,
      processed: this.currentSearchStep?.processed ?? null,
      total: this.currentSearchStep?.total ?? null,
      frontierSize: this.currentSearchStep?.frontierSize ?? null,
      visitedCount: this.currentSearchStep?.visitedCount ?? null,
      layer: this.currentSearchStep?.layer ?? null,
      searchStart: this.currentSearchStep?.searchStart ?? null,
      searchTarget: this.currentSearchStep?.searchTarget ?? null,
      currentNode: this.currentSearchStep?.expandedPoint ?? null,
      candidatePathPoints: this.currentSearchStep?.candidatePath?.length ?? 0,
      committedRoutes: this.session.routeCount,
    }
    if (completed) this.solved = true
  }

  computeProgress() {
    if (this.solved) return 1
    const processed = this.currentSearchStep?.processed
    const total = this.currentSearchStep?.total
    return processed !== undefined && total
      ? Math.min(0.99, processed / total)
      : 0
  }

  override getOutput(): IncrementalReferenceFanoutSession {
    if (!this.solved) {
      throw new Error(
        `${this.getSolverName()} output requested before completion`,
      )
    }
    return this.session
  }

  override visualize(): GraphicsObject {
    const routes = this.session.getRoutes()
    if (this.currentSearchStep?.route) {
      const routeIndex = routes.findIndex(
        (route) =>
          route.connectionName ===
          this.currentSearchStep?.route?.connectionName,
      )
      if (routeIndex >= 0) routes[routeIndex] = this.currentSearchStep.route
      else routes.push(this.currentSearchStep.route)
    }
    const visual = visualizeRoutes(
      this.session,
      routes,
      this.currentSearchStep?.connectionName ?? null,
      this.currentSearchStep?.expandedPoint
        ? undefined
        : this.currentSearchStep?.point,
    )
    if (!this.currentSearchStep) return visual
    const context = this.session.getVisualizationContext()
    const world = (point: { x: number; y: number }) =>
      fromCanonical(context.model.axisSign, point)
    const overlayLines: NonNullable<GraphicsObject["lines"]> = []
    const overlayCircles: NonNullable<GraphicsObject["circles"]> = []
    const overlayTexts: NonNullable<GraphicsObject["texts"]> = []
    const searchStart = this.currentSearchStep.searchStart
    const searchTarget = this.currentSearchStep.searchTarget
    if (searchStart && searchTarget) {
      overlayLines.push({
        points: [world(searchStart), world(searchTarget)],
        strokeWidth: context.model.rules.traceWidth * 0.72,
        strokeColor: "rgba(30, 41, 59, 0.9)",
        strokeDash: [0.025, 0.085],
        label: "direct connection intent guide",
      })
      overlayCircles.push(
        {
          center: world(searchStart),
          radius: Math.max(
            context.model.rules.viaDiameter * 0.82,
            context.model.rules.traceWidth * 1.5,
          ),
          fill: "#ffffff",
          stroke: "#0f172a",
          label: "active search source halo",
        },
        {
          center: world(searchStart),
          radius: Math.max(
            context.model.rules.viaDiameter * 0.62,
            context.model.rules.traceWidth * 1.15,
          ),
          fill: "#22c55e",
          stroke: "#14532d",
          label: "search source endpoint",
        },
        {
          center: world(searchTarget),
          radius: Math.max(
            context.model.rules.viaDiameter * 0.82,
            context.model.rules.traceWidth * 1.5,
          ),
          fill: "#ffffff",
          stroke: "#0f172a",
          label: "active search target halo",
        },
        {
          center: world(searchTarget),
          radius: Math.max(
            context.model.rules.viaDiameter * 0.62,
            context.model.rules.traceWidth * 1.15,
          ),
          fill: "#ec4899",
          stroke: "#831843",
          label: "search target endpoint",
        },
      )
      overlayTexts.push(
        {
          ...world(searchStart),
          text: "S",
          color: "#ffffff",
          fontSize: Math.max(0.11, context.model.rules.viaDiameter * 0.62),
          anchorSide: "center",
        },
        {
          ...world(searchTarget),
          text: "T",
          color: "#ffffff",
          fontSize: Math.max(0.11, context.model.rules.viaDiameter * 0.62),
          anchorSide: "center",
        },
      )
    }
    const candidatePath = this.currentSearchStep.candidatePath ?? []
    for (let index = 1; index < candidatePath.length; index++) {
      const points = [
        world(candidatePath[index - 1]!),
        world(candidatePath[index]!),
      ]
      overlayLines.push({
        points,
        strokeWidth: context.model.rules.traceWidth * 4.4,
        strokeColor: "rgba(255, 255, 255, 0.96)",
        layer: this.currentSearchStep.layer,
        label: "A* live best candidate path halo",
      })
      overlayLines.push({
        points,
        strokeWidth: context.model.rules.traceWidth * 2.25,
        strokeColor: "#111827",
        layer: this.currentSearchStep.layer,
        label: "A* live best candidate path outline",
      })
      overlayLines.push({
        points,
        strokeWidth: context.model.rules.traceWidth * 1.15,
        strokeColor: "#fde047",
        layer: this.currentSearchStep.layer,
        label: "A* live best candidate path",
      })
    }
    if (this.currentSearchStep.expandedPoint) {
      overlayCircles.push({
        center: world(this.currentSearchStep.expandedPoint),
        radius: Math.max(
          context.model.rules.viaDiameter * 0.72,
          context.model.rules.traceWidth * 1.2,
        ),
        fill: "#ffffff",
        stroke: "#dc2626",
        label: "A* current expanded node",
      })
    }
    const routingWidth =
      context.model.routingBounds.maxX - context.model.routingBounds.minX
    const routingHeight =
      context.model.routingBounds.maxY - context.model.routingBounds.minY
    const labelYInset = routingHeight * 0.04
    const labelPosition = fromCanonical(context.model.axisSign, {
      x:
        (context.model.routingBounds.minX + context.model.routingBounds.maxX) /
        2,
      y: context.model.routingBounds.maxY - labelYInset,
    })
    const progress =
      this.currentSearchStep.processed !== undefined &&
      this.currentSearchStep.total
        ? ` · ${this.currentSearchStep.processed}/${this.currentSearchStep.total}`
        : ""
    const searchCounts =
      this.currentSearchStep.visitedCount !== undefined ||
      this.currentSearchStep.frontierSize !== undefined
        ? ` · V${this.currentSearchStep.visitedCount ?? 0}/F${this.currentSearchStep.frontierSize ?? 0}`
        : ""
    const layer = this.currentSearchStep.layer
      ? ` · ${this.currentSearchStep.layer}`
      : ""
    const actionLabels: Record<string, string> = {
      evaluate_top_layer_neighbor: "top A* neighbor",
      pop_top_layer_grid_node: "top A* pop",
      evaluate_inner_layer_neighbor: "inner A* neighbor",
      pop_inner_layer_grid_node: "inner A* pop",
    }
    const actionLabel =
      actionLabels[this.currentSearchStep.action] ??
      this.currentSearchStep.action.replaceAll("_", " ")
    const rawIdentifier =
      this.currentSearchStep.connectionName ??
      this.currentSearchStep.candidateId ??
      "search"
    const identifier = rawIdentifier.split(":").at(-1) ?? rawIdentifier
    const compactIdentifier =
      identifier.length > 32 ? `${identifier.slice(0, 29)}...` : identifier
    const reason = this.currentSearchStep.reason
      ? ` · ${this.currentSearchStep.reason.replaceAll("_", " ")}`
      : ""
    const mutedVisual: GraphicsObject = {
      ...visual,
      lines: visual.lines?.map((line) =>
        line.strokeDash
          ? {
              ...line,
              strokeWidth: Math.max(
                0.006,
                context.model.rules.traceWidth * 0.09,
              ),
              strokeColor: "rgba(148, 163, 184, 0.2)",
            }
          : line,
      ),
    }
    return mergeGraphics(mutedVisual, {
      coordinateSystem: "cartesian",
      lines: overlayLines,
      circles: [
        ...(this.currentSearchStep.visitedPoints ?? []).map((point) => ({
          center: world(point),
          radius: Math.max(0.018, context.model.rules.traceWidth * 0.3),
          fill: "rgba(37, 99, 235, 0.28)",
          stroke: "none",
          label: "A* visited node",
        })),
        ...(this.currentSearchStep.frontierPoints ?? []).map((point) => ({
          center: world(point),
          radius: Math.max(0.022, context.model.rules.traceWidth * 0.4),
          fill: "rgba(16, 185, 129, 0.5)",
          stroke: "#047857",
          label: "A* frontier node",
        })),
        ...overlayCircles,
      ],
      texts: [
        ...overlayTexts,
        {
          ...labelPosition,
          text: `${actionLabel} · ${compactIdentifier} · ${this.currentSearchStep.status}${layer}${progress}${searchCounts}${reason}`,
          color:
            this.currentSearchStep.status === "rejected"
              ? "#b91c1c"
              : this.currentSearchStep.status === "accepted" ||
                  this.currentSearchStep.status === "completed"
                ? "#166534"
                : "#1d4ed8",
          fontSize: Math.max(
            0.12,
            (context.model.routingBounds.maxX -
              context.model.routingBounds.minX) *
              0.01,
          ),
          anchorSide: "top_center",
        },
      ],
    })
  }
}

abstract class RevealReferenceRoutesSolver extends BaseSolver {
  protected computed = false
  protected visibleRouteCount = 0
  protected routes: ReferenceRouteSnapshot[] = []
  protected activeConnection: string | null = null

  constructor(protected readonly session: IncrementalReferenceFanoutSession) {
    super()
    this.MAX_ITERATIONS = 100
  }

  protected abstract runPhase(): void
  protected abstract readonly action: string

  override getConstructorParams() {
    return [this.session]
  }

  override _step() {
    if (!this.computed) {
      this.runPhase()
      this.routes = this.session.getRoutes()
      this.computed = true
      this.updateStats("computed")
      if (this.routes.length === 0) this.solved = true
      return
    }

    const route = this.routes[this.visibleRouteCount]
    if (route) {
      this.visibleRouteCount++
      this.activeConnection = route.connectionName
      this.updateStats("revealed")
      return
    }

    this.activeConnection = null
    this.updateStats("completed")
    this.solved = true
  }

  private updateStats(status: string) {
    this.stats = {
      action: this.action,
      status,
      activeConnection: this.activeConnection,
      visibleRoutes: this.visibleRouteCount,
      totalRoutes: this.routes.length,
    }
  }

  computeProgress() {
    if (this.solved) return 1
    if (!this.computed) return 0
    return this.visibleRouteCount / Math.max(1, this.routes.length)
  }

  override getOutput(): IncrementalReferenceFanoutSession {
    if (!this.solved) {
      throw new Error(
        `${this.getSolverName()} output requested before completion`,
      )
    }
    return this.session
  }

  override visualize(): GraphicsObject {
    return visualizeRoutes(
      this.session,
      this.routes.slice(0, this.visibleRouteCount),
      this.activeConnection,
    )
  }
}

export class PlaceIndependentEarlyDropViasSolver extends IncrementalReferenceSearchSolver {
  protected override advanceSearch() {
    return this.session.stepIndependentEarlyDropVias()
  }
}

export class CompleteTopLayerRoutesSolver extends IncrementalReferenceSearchSolver {
  protected override advanceSearch() {
    return this.session.stepResidualTopDogbones()
  }
}

export class AssignPrescribedLayersSolver extends RevealReferenceRoutesSolver {
  protected readonly action = "assign_prescribed_layer"

  protected override runPhase() {
    this.session.assignPreferredLayers()
  }
}

export class RoutePrescribedInnerLayersSolver extends IncrementalReferenceSearchSolver {
  protected override advanceSearch() {
    return this.session.stepPrescribedInnerLayers()
  }
}

export class MiterRouteCornersSolver extends BaseSolver {
  private activeConnection: string | null = null

  constructor(private readonly session: IncrementalReferenceFanoutSession) {
    super()
    this.MAX_ITERATIONS = Math.max(2, session.routeCount + 2)
  }

  override getConstructorParams() {
    return [this.session]
  }

  override _step() {
    const route = this.session.miterNextRoute()
    if (!route) {
      this.activeConnection = null
      this.updateStats("completed")
      this.solved = true
      return
    }
    this.activeConnection = route.connectionName
    this.updateStats("mitered")
  }

  private updateStats(status: string) {
    this.stats = {
      action: "miter_route_corners",
      status,
      activeConnection: this.activeConnection,
      miteredRoutes: this.session.miteredRouteCount,
      totalRoutes: this.session.routeCount,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.session.miteredRouteCount / Math.max(1, this.session.routeCount)
  }

  override getOutput(): IncrementalReferenceFanoutSession {
    if (!this.solved) {
      throw new Error(
        "MiterRouteCornersSolver output requested before completion",
      )
    }
    return this.session
  }

  override visualize(): GraphicsObject {
    return visualizeRoutes(
      this.session,
      this.session.getRoutes(),
      this.activeConnection,
    )
  }
}

export class ValidateReferenceRoutesSolver extends BaseSolver {
  constructor(private readonly session: IncrementalReferenceFanoutSession) {
    super()
    this.MAX_ITERATIONS = 2
  }

  override getConstructorParams() {
    return [this.session]
  }

  override _step() {
    this.session.validate()
    this.stats = {
      action: "validate_reconstructed_geometry",
      status: "completed",
      routes: this.session.routeCount,
    }
    this.solved = true
  }

  override getOutput(): IncrementalReferenceFanoutSession {
    if (!this.solved) {
      throw new Error(
        "ValidateReferenceRoutesSolver output requested before completion",
      )
    }
    return this.session
  }

  override visualize(): GraphicsObject {
    return visualizeRoutes(this.session, this.session.getRoutes(), null)
  }
}

export class BuildReferenceOutputSolver extends BaseSolver {
  private output: FixedTargetBgaFanoutOutput | null = null

  constructor(private readonly session: IncrementalReferenceFanoutSession) {
    super()
    this.MAX_ITERATIONS = 2
  }

  override getConstructorParams() {
    return [this.session]
  }

  override _step() {
    const result = this.session.buildOutput()
    this.output = {
      ...result,
      phases: [...AM62L_FREE_SPACE_FANOUT_PHASES],
    }
    this.stats = {
      action: "build_output",
      status: "completed",
      traces: result.traces.length,
    }
    this.solved = true
  }

  override getOutput(): FixedTargetBgaFanoutOutput {
    if (!this.solved || !this.output) {
      throw new Error(
        "BuildReferenceOutputSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeRoutes(this.session, this.session.getRoutes(), null)
  }
}
