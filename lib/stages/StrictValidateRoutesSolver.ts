import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  RouteViolation,
  ValidatedViaFirstRouteCandidate,
  ViaFirstRouteCandidate,
} from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

export class StrictValidateRoutesSolver extends BaseSolver {
  private readonly candidate: ViaFirstRouteCandidate
  private readonly inspected: RouteViolation[] = []
  private cursor = 0
  private output: ValidatedViaFirstRouteCandidate | null = null

  constructor(candidate: ViaFirstRouteCandidate) {
    super()
    this.candidate = candidate
    this.MAX_ITERATIONS = candidate.violations.length + 2
  }

  override getConstructorParams() {
    return [this.candidate]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const violation = this.candidate.violations[this.cursor]
    if (violation) {
      this.inspected.push(violation)
      this.cursor++
      this.updateStats()
      return
    }
    if (this.inspected.length > 0) {
      const counts = Object.fromEntries(
        [...new Set(this.inspected.map((item) => item.kind))].map((kind) => [
          kind,
          this.inspected.filter((item) => item.kind === kind).length,
        ]),
      )
      throw new Error(
        `[validate_via_first_geometry/all] ${this.inspected.length} unresolved DRC violations ${JSON.stringify(counts)}; first: ${this.inspected[0]!.message}`,
      )
    }
    this.output = { ...this.candidate, validated: true }
    this.solved = true
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "strictValidateRoutes",
      inspectedViolations: this.inspected.length,
      totalViolations: this.candidate.violations.length,
      validated: this.solved && this.inspected.length === 0,
      activeViolation: this.candidate.violations[this.cursor]?.kind ?? null,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.candidate.violations.length)
  }

  override getOutput(): ValidatedViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "StrictValidateRoutesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.candidate.plan.model,
      assignments: this.candidate.plan.viaAssignments,
      routes: this.candidate.routes,
      violations: this.inspected,
      stage: "strict route validation",
      progress: this.computeProgress(),
      counts: `${this.inspected.length}/${this.candidate.violations.length} violations inspected`,
    })
  }
}
