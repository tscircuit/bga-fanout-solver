import type { SimplifiedPcbTrace } from "@tscircuit/core"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { distance, EPS, fromCanonical } from "../model/geometry"
import type {
  CandidateFanoutRoute,
  FixedTargetBgaFanoutOutput,
  ValidatedViaFirstRouteCandidate,
} from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

export const VIA_FIRST_PHASES = [
  "findFreeSpace",
  "deriveViaCorridors",
  "rankFanoutNets",
  "groupBusConnections",
  "enumerateViaLineCandidates",
  "placeViaRowsAndSlots",
  "assignNetsToVias",
  "enumerateTopConnectorTemplates",
  "scoreTopConnectorTemplates",
  "commitTopConnectorTemplates",
  "enumerateInnerConnectorTemplates",
  "scoreInnerConnectorTemplates",
  "commitInnerConnectorTemplates",
  "detectInitialConflicts",
  "proposeBundleRepairs",
  "evaluateBundleRepairs",
  "commitBundleRepairs",
  "detectRepairedConflicts",
  "strictValidateRoutes",
  "buildOutput",
]

export class BuildOutputSolver extends BaseSolver {
  private readonly candidate: ValidatedViaFirstRouteCandidate
  private readonly traces: SimplifiedPcbTrace[] = []
  private cursor = 0
  private output: FixedTargetBgaFanoutOutput | null = null

  constructor(candidate: ValidatedViaFirstRouteCandidate) {
    super()
    this.candidate = candidate
    this.MAX_ITERATIONS = candidate.routes.length + 2
  }

  override getConstructorParams() {
    return [this.candidate]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const route = this.candidate.routes[this.cursor]
    if (route) {
      this.traces.push(this.buildTrace(route))
      this.cursor++
      this.updateStats()
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
      phases: VIA_FIRST_PHASES,
    }
    this.solved = true
    this.updateStats()
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

  private updateStats() {
    this.stats = {
      phase: "buildOutput",
      builtTraces: this.traces.length,
      totalConnections: this.candidate.routes.length,
      activeConnection:
        this.candidate.routes[this.cursor]?.net.connectionName ?? null,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.candidate.routes.length)
  }

  override getOutput(): FixedTargetBgaFanoutOutput {
    if (!this.solved || !this.output) {
      throw new Error("BuildOutputSolver output requested before completion")
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.candidate.plan.model,
      assignments: this.candidate.plan.viaAssignments,
      routes: this.candidate.routes,
      stage: "build exact SRJ output",
      progress: this.computeProgress(),
      counts: `${this.traces.length}/${this.candidate.routes.length} traces`,
    })
  }
}
