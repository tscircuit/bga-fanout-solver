import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type { RouteViolation, ViaFirstRouteCandidate } from "../model/types"
import {
  collectRouteViolations,
  getOctilinearTemplates,
  getPathLength,
  scoreViolations,
} from "../routing/routeGeometry"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

const localInnerViolations = (
  connectionName: string,
  layer: string,
  violations: RouteViolation[],
) =>
  violations.filter(
    (violation) =>
      violation.layer === layer &&
      violation.connectionNames.includes(connectionName),
  )

export class ConnectViaToTargetSolver extends BaseSolver {
  private readonly candidate: ViaFirstRouteCandidate
  private cursor = 0
  private output: ViaFirstRouteCandidate | null = null

  constructor(candidate: ViaFirstRouteCandidate) {
    super()
    this.candidate = {
      ...candidate,
      routes: candidate.routes.map((route) => ({
        ...route,
        topPath: route.topPath.map((point) => ({ ...point })),
        innerPath: [],
      })),
    }
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
    if (!route) {
      const violations = collectRouteViolations(
        this.candidate.plan.model,
        this.candidate.routes,
      )
      this.output = { ...this.candidate, violations }
      this.solved = true
      this.updateStats()
      return
    }
    const pitch = this.candidate.plan.model.pitchY
    const laneYs = [
      route.via.y,
      route.net.target.y,
      route.net.target.y - pitch,
      route.net.target.y - pitch / 2,
      route.net.target.y + pitch / 2,
      route.net.target.y + pitch,
    ]
    const templates = getOctilinearTemplates(
      route.via,
      route.net.target,
      laneYs,
    )
    let bestPath = templates[0]!
    let bestViolations: RouteViolation[] = []
    let bestScore = { count: Number.POSITIVE_INFINITY, severity: Infinity }
    for (const template of templates) {
      route.innerPath = template
      const violations = localInnerViolations(
        route.net.connectionName,
        route.net.selectedLayer,
        collectRouteViolations(
          this.candidate.plan.model,
          this.candidate.routes,
        ),
      )
      const score = scoreViolations(violations)
      if (
        score.count < bestScore.count ||
        (score.count === bestScore.count &&
          (score.severity < bestScore.severity ||
            (score.severity === bestScore.severity &&
              getPathLength(template) < getPathLength(bestPath))))
      ) {
        bestPath = template
        bestViolations = violations
        bestScore = score
      }
    }
    route.innerPath = bestPath
    this.cursor++
    this.stats = {
      ...this.stats,
      selectedTemplateViolations: bestViolations.length,
    }
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      ...this.stats,
      phase: "connectViaToTarget",
      routedConnections: this.cursor,
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

  override getOutput(): ViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "ConnectViaToTargetSolver output requested before completion",
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
