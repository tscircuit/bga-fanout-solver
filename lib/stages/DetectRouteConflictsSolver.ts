import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type { RouteViolation, ViaFirstRouteCandidate } from "../model/types"
import { collectRouteViolations } from "../routing/routeGeometry"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

export class DetectRouteConflictsSolver extends BaseSolver {
  private readonly candidate: ViaFirstRouteCandidate
  private readonly violations: RouteViolation[] = []
  private readonly signatures = new Set<string>()
  private pending: RouteViolation[] = []
  private routeCursor = 0
  private output: ViaFirstRouteCandidate | null = null

  constructor(candidate: ViaFirstRouteCandidate) {
    super()
    this.candidate = candidate
    this.MAX_ITERATIONS = candidate.routes.length * 100 + 2
  }

  override getConstructorParams() {
    return [this.candidate]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const violation = this.pending.shift()
    if (violation) {
      const signature = `${violation.kind}:${[...violation.connectionNames].sort().join("/")}:${violation.layer}:${violation.amount}`
      if (!this.signatures.has(signature)) {
        this.signatures.add(signature)
        this.violations.push(violation)
      }
      this.updateStats()
      return
    }
    const route = this.candidate.routes[this.routeCursor]
    if (!route) {
      this.output = {
        ...this.candidate,
        violations: this.violations.map((item) => ({ ...item })),
      }
      this.solved = true
      this.updateStats()
      return
    }
    this.pending = collectRouteViolations(
      this.candidate.plan.model,
      this.candidate.routes,
    ).filter((item) => item.connectionNames[0] === route.net.connectionName)
    this.routeCursor++
    this.updateStats()
  }

  private updateStats() {
    const counts = Object.fromEntries(
      [...new Set(this.violations.map((item) => item.kind))].map((kind) => [
        kind,
        this.violations.filter((item) => item.kind === kind).length,
      ]),
    )
    this.stats = {
      phase: "detectRouteConflicts",
      scannedConnections: this.routeCursor,
      totalConnections: this.candidate.routes.length,
      classifiedViolations: this.violations.length,
      pendingViolations: this.pending.length,
      violationCounts: counts,
      activeConnection:
        this.candidate.routes[this.routeCursor]?.net.connectionName ?? null,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.routeCursor / Math.max(1, this.candidate.routes.length)
  }

  override getOutput(): ViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "DetectRouteConflictsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.candidate.plan.model,
      assignments: this.candidate.plan.viaAssignments,
      routes: this.candidate.routes,
      violations: this.violations,
      activeConnectionName:
        this.candidate.routes[this.routeCursor]?.net.connectionName,
      stage: "detect and classify conflicts",
      progress: this.computeProgress(),
      counts: `${this.violations.length} classified · ${this.pending.length} pending`,
    })
  }
}
