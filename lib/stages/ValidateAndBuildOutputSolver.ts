import type { SimplifiedPcbTrace } from "@tscircuit/core"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { distance, EPS, fromCanonical } from "../model/geometry"
import type {
  CandidateFanoutRoute,
  FixedTargetBgaFanoutOutput,
  ViaFirstRouteCandidate,
} from "../model/types"
import { collectRouteViolations } from "../routing/routeGeometry"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

const PHASES = [
  "findFreeSpace",
  "rankFanoutNets",
  "assignViaLines",
  "connectBallToVia",
  "connectViaToTarget",
  "repairRouteConflicts",
  "validateAndBuildOutput",
]

export class ValidateAndBuildOutputSolver extends BaseSolver {
  private readonly candidate: ViaFirstRouteCandidate
  private readonly traces: SimplifiedPcbTrace[] = []
  private cursor = 0
  private output: FixedTargetBgaFanoutOutput | null = null

  constructor(candidate: ViaFirstRouteCandidate) {
    super()
    this.candidate = candidate
    this.MAX_ITERATIONS = candidate.routes.length + 2
  }

  override getConstructorParams() {
    return [this.candidate]
  }

  override _setup() {
    const violations = collectRouteViolations(
      this.candidate.plan.model,
      this.candidate.routes,
    )
    this.candidate.violations = violations
    const violationCounts = Object.fromEntries(
      [...new Set(violations.map((item) => item.kind))].map((kind) => [
        kind,
        violations.filter((item) => item.kind === kind).length,
      ]),
    )
    this.stats = {
      phase: "validateAndBuildOutput",
      validated: violations.length === 0,
      remainingViolations: violations.length,
      violationCounts,
      builtTraces: 0,
      totalConnections: this.candidate.routes.length,
    }
  }

  override _step() {
    if (this.candidate.violations.length > 0) {
      const counts = Object.fromEntries(
        [...new Set(this.candidate.violations.map((item) => item.kind))].map(
          (kind) => [
            kind,
            this.candidate.violations.filter((item) => item.kind === kind)
              .length,
          ],
        ),
      )
      throw new Error(
        `[validate_via_first_geometry/all] ${this.candidate.violations.length} unresolved DRC violations ${JSON.stringify(counts)}; first: ${this.candidate.violations[0]!.message}`,
      )
    }
    const route = this.candidate.routes[this.cursor]
    if (route) {
      this.traces.push(this.buildTrace(route))
      this.cursor++
      this.stats = { ...this.stats, builtTraces: this.traces.length }
      return
    }
    const input = this.candidate.plan.model.input
    this.output = {
      traces: this.traces,
      outputSimpleRouteJson: {
        ...input,
        connections: input.connections.map((connection) => ({
          ...connection,
          pointsToConnect: connection.pointsToConnect.map((point) => ({
            ...point,
          })),
        })),
        traces: [...(input.traces ?? []), ...this.traces],
        buses: input.buses?.map((bus) => ({
          ...bus,
          connectionNames: [...bus.connectionNames],
          ...(bus.connectionExitTargets
            ? { connectionExitTargets: { ...bus.connectionExitTargets } }
            : {}),
        })),
      },
      phases: PHASES,
    }
    this.solved = true
  }

  private buildTrace(route: CandidateFanoutRoute): SimplifiedPcbTrace {
    const model = this.candidate.plan.model
    const topPath = route.topPath.map((point) =>
      fromCanonical(model.axisSign, point),
    )
    const innerPath = route.innerPath.map((point) =>
      fromCanonical(model.axisSign, point),
    )
    const width =
      route.net.connection.nominalTraceWidth ??
      route.net.connection.width ??
      model.rules.traceWidth
    const wire = (
      point: { x: number; y: number },
      layer: string,
      extra?: Record<string, string>,
    ) => ({
      route_type: "wire" as const,
      x: point.x,
      y: point.y,
      width,
      layer,
      ...extra,
    })
    const traceRoute: SimplifiedPcbTrace["route"] = topPath.map(
      (point, index) =>
        wire(
          point,
          "top",
          index === 0 && route.net.source.pcb_port_id
            ? { start_pcb_port_id: route.net.source.pcb_port_id }
            : undefined,
        ),
    )
    if (route.net.selectedLayer === "top") {
      if (distance(topPath.at(-1)!, innerPath[0]!) <= EPS) {
        traceRoute.push(
          ...innerPath.slice(1).map((point) => wire(point, "top")),
        )
      } else {
        throw new Error(
          `[build_output/${route.net.connectionName}] top paths are disconnected`,
        )
      }
    } else {
      const via = fromCanonical(model.axisSign, route.via)
      traceRoute.push({
        route_type: "via",
        x: via.x,
        y: via.y,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: model.rules.viaDiameter,
        via_hole_diameter: model.rules.viaHoleDiameter,
      })
      traceRoute.push(
        ...innerPath.map((point) => wire(point, route.net.selectedLayer)),
      )
    }
    return {
      type: "pcb_trace",
      pcb_trace_id: `via-first:${route.net.connectionName}`,
      connection_name: route.net.connectionName,
      connectsTo: [
        ...(route.net.source.pointId ? [route.net.source.pointId] : []),
        ...(route.net.source.pcb_port_id ? [route.net.source.pcb_port_id] : []),
        ...(route.net.target.pointId ? [route.net.target.pointId] : []),
      ],
      route: traceRoute,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.candidate.routes.length)
  }

  override getOutput(): FixedTargetBgaFanoutOutput {
    if (!this.solved || !this.output) {
      throw new Error(
        "ValidateAndBuildOutputSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.candidate.plan.model,
      assignments: this.candidate.plan.viaAssignments,
      routes: this.candidate.routes,
    })
  }
}
