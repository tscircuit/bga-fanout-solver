import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  CandidateFanoutRoute,
  RouteViolation,
  ViaFirstFanoutPlan,
  ViaFirstRouteCandidate,
} from "../model/types"
import {
  collectRouteViolations,
  getOctilinearTemplates,
  getPathLength,
  scoreViolations,
} from "../routing/routeGeometry"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

const localTopViolations = (
  connectionName: string,
  violations: RouteViolation[],
) =>
  violations.filter(
    (violation) =>
      violation.layer === "top" &&
      violation.connectionNames.includes(connectionName),
  )

export class ConnectBallToViaSolver extends BaseSolver {
  private readonly plan: ViaFirstFanoutPlan
  private readonly routes: CandidateFanoutRoute[]
  private cursor = 0
  private output: ViaFirstRouteCandidate | null = null

  constructor(plan: ViaFirstFanoutPlan) {
    super()
    this.plan = plan
    const assignmentByName = new Map(
      plan.viaAssignments.map((assignment) => [
        assignment.connectionName,
        assignment,
      ]),
    )
    this.routes = plan.model.nets.map((net) => {
      const assignment = assignmentByName.get(net.connectionName)
      if (!assignment) {
        throw new Error(
          `[connect_ball_to_via/${net.connectionName}] missing via assignment`,
        )
      }
      return {
        net,
        via: { ...assignment.via },
        viaLineId: assignment.viaLineId,
        slotIndex: assignment.slotIndex,
        topPath: [],
        innerPath: [],
      }
    })
    this.MAX_ITERATIONS = this.routes.length + 2
  }

  override getConstructorParams() {
    return [this.plan]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const route = this.routes[this.cursor]
    if (!route) {
      this.output = { plan: this.plan, routes: this.routes, violations: [] }
      this.solved = true
      this.updateStats()
      return
    }
    const pitch = this.plan.model.pitchY
    const laneYs = [
      route.net.source.y - pitch,
      route.net.source.y - pitch / 2,
      route.net.source.y + pitch / 2,
      route.net.source.y + pitch,
      route.via.y,
    ]
    const templates = getOctilinearTemplates(
      route.net.source,
      route.via,
      laneYs,
    )
    let bestPath = templates[0]!
    let bestViolations: RouteViolation[] = []
    let bestScore = { count: Number.POSITIVE_INFINITY, severity: Infinity }
    for (const template of templates) {
      route.topPath = template
      const violations = localTopViolations(
        route.net.connectionName,
        collectRouteViolations(this.plan.model, this.routes),
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
    route.topPath = bestPath
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
      phase: "connectBallToVia",
      routedConnections: this.cursor,
      totalConnections: this.routes.length,
      activeConnection: this.routes[this.cursor]?.net.connectionName ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.routes.length)
  }

  override getOutput(): ViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "ConnectBallToViaSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.plan.model,
      assignments: this.plan.viaAssignments,
      routes: this.routes,
    })
  }
}
