import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  CandidateFanoutRoute,
  Point,
  ViaFirstRouteCandidate,
} from "../model/types"
import {
  collectRouteViolations,
  getOctilinearTemplates,
  isBetterViolationScore,
} from "../routing/routeGeometry"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

type RepairAttempt = {
  connectionName: string
  leg: "top" | "inner"
  path: Point[]
}

const pathSignature = (path: readonly Point[]) =>
  path.map((point) => `${point.x},${point.y}`).join(";")

const cloneRoute = (route: CandidateFanoutRoute): CandidateFanoutRoute => ({
  ...route,
  net: route.net,
  via: { ...route.via },
  topPath: route.topPath.map((point) => ({ ...point })),
  innerPath: route.innerPath.map((point) => ({ ...point })),
})

/**
 * Bounded joint repair. Each step tests one deterministic template replacement
 * against the DRC score for the whole fanout and accepts only strict progress.
 */
export class RepairRouteConflictsSolver extends BaseSolver {
  private readonly candidate: ViaFirstRouteCandidate
  private readonly attempts: RepairAttempt[] = []
  private cursor = 0
  private acceptedAttempts = 0
  private output: ViaFirstRouteCandidate | null = null

  constructor(candidate: ViaFirstRouteCandidate) {
    super()
    this.candidate = {
      ...candidate,
      routes: candidate.routes.map(cloneRoute),
      violations: [...candidate.violations],
    }
  }

  override getConstructorParams() {
    return [this.candidate]
  }

  override _setup() {
    const model = this.candidate.plan.model
    for (const route of this.candidate.routes) {
      const offsets = [-3, -2, -1, -0.5, 0.5, 1, 2, 3]
      const topLaneYs = offsets.map(
        (offset) => route.net.source.y + offset * model.pitchY,
      )
      const innerLaneYs = offsets.map(
        (offset) => route.net.target.y + offset * model.pitchY,
      )
      const currentTopSignature = pathSignature(route.topPath)
      for (const path of getOctilinearTemplates(
        route.net.source,
        route.via,
        topLaneYs,
      )) {
        if (pathSignature(path) === currentTopSignature) continue
        this.attempts.push({
          connectionName: route.net.connectionName,
          leg: "top",
          path,
        })
      }
      const currentInnerSignature = pathSignature(route.innerPath)
      for (const path of getOctilinearTemplates(
        route.via,
        route.net.target,
        innerLaneYs,
      )) {
        if (pathSignature(path) === currentInnerSignature) continue
        this.attempts.push({
          connectionName: route.net.connectionName,
          leg: "inner",
          path,
        })
      }
    }
    this.MAX_ITERATIONS = this.attempts.length + 2
    this.candidate.violations = collectRouteViolations(
      model,
      this.candidate.routes,
    )
    this.updateStats()
  }

  override _step() {
    if (this.candidate.violations.length === 0) {
      this.finish()
      return
    }
    const attempt = this.attempts[this.cursor]
    if (!attempt) {
      this.finish()
      return
    }
    const routeIndex = this.candidate.routes.findIndex(
      (route) => route.net.connectionName === attempt.connectionName,
    )
    const route = this.candidate.routes[routeIndex]
    if (!route) {
      throw new Error(
        `[repair_route_conflicts/${attempt.connectionName}] route disappeared`,
      )
    }
    const trialRoutes = [...this.candidate.routes]
    const trialRoute = cloneRoute(route)
    if (attempt.leg === "top") trialRoute.topPath = attempt.path
    else trialRoute.innerPath = attempt.path
    trialRoutes[routeIndex] = trialRoute
    const trialViolations = collectRouteViolations(
      this.candidate.plan.model,
      trialRoutes,
    )
    if (isBetterViolationScore(trialViolations, this.candidate.violations)) {
      this.candidate.routes = trialRoutes
      this.candidate.violations = trialViolations
      this.acceptedAttempts++
    }
    this.cursor++
    this.updateStats()
  }

  private finish() {
    this.output = {
      ...this.candidate,
      routes: this.candidate.routes.map(cloneRoute),
      violations: [...this.candidate.violations],
    }
    this.solved = true
    this.updateStats()
  }

  private updateStats() {
    const violationCounts = Object.fromEntries(
      [...new Set(this.candidate.violations.map((item) => item.kind))].map(
        (kind) => [
          kind,
          this.candidate.violations.filter((item) => item.kind === kind).length,
        ],
      ),
    )
    this.stats = {
      phase: "repairRouteConflicts",
      attemptedTemplates: this.cursor,
      totalTemplates: this.attempts.length,
      acceptedTemplates: this.acceptedAttempts,
      remainingViolations: this.candidate.violations.length,
      violationCounts,
      activeConnection: this.attempts[this.cursor]?.connectionName ?? null,
      activeLeg: this.attempts[this.cursor]?.leg ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.attempts.length)
  }

  override getOutput(): ViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "RepairRouteConflictsSolver output requested before completion",
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
