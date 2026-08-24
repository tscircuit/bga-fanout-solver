import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  BundleRepairPlan,
  BundleRepairProposal,
  CandidateFanoutRoute,
  Point,
  ViaFirstRouteCandidate,
} from "../model/types"
import {
  collectRouteViolations,
  getOctilinearTemplates,
  isBetterViolationScore,
  scoreViolations,
} from "../routing/routeGeometry"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

const OFFSETS = [-3, -2, -1, -0.5, 0.5, 1, 2, 3]

const cloneRoutes = (routes: readonly CandidateFanoutRoute[]) =>
  routes.map((route) => ({
    ...route,
    via: { ...route.via },
    topPath: route.topPath.map((point) => ({ ...point })),
    innerPath: route.innerPath.map((point) => ({ ...point })),
  }))

const applyProposal = (
  routes: readonly CandidateFanoutRoute[],
  proposal: BundleRepairProposal,
) => {
  const replacements = new Map(
    proposal.replacements.map((item) => [item.connectionName, item.path]),
  )
  return cloneRoutes(routes).map((route) => {
    const replacement = replacements.get(route.net.connectionName)
    if (!replacement) return route
    if (proposal.leg === "top") route.topPath = replacement
    else route.innerPath = replacement
    return route
  })
}

type PendingProposal = {
  groupId: string
  leg: "top" | "inner"
  offset: number
}

export class ProposeBundleRepairsSolver extends BaseSolver {
  private readonly candidate: ViaFirstRouteCandidate
  private readonly pending: PendingProposal[] = []
  private readonly proposals: BundleRepairProposal[] = []
  private cursor = 0
  private output: BundleRepairPlan | null = null

  constructor(candidate: ViaFirstRouteCandidate) {
    super()
    this.candidate = candidate
  }

  override getConstructorParams() {
    return [this.candidate]
  }

  override _setup() {
    const conflictedNames = new Set(
      this.candidate.violations.flatMap((item) => item.connectionNames),
    )
    for (const group of this.candidate.plan.busGroups) {
      if (!group.connectionNames.some((name) => conflictedNames.has(name))) {
        continue
      }
      for (const leg of ["top", "inner"] as const) {
        for (const offset of OFFSETS) {
          this.pending.push({ groupId: group.id, leg, offset })
        }
      }
    }
    this.MAX_ITERATIONS = this.pending.length + 2
    this.updateStats()
  }

  override _step() {
    const pending = this.pending[this.cursor]
    if (!pending) {
      this.output = { candidate: this.candidate, proposals: this.proposals }
      this.solved = true
      this.updateStats()
      return
    }
    const group = this.candidate.plan.busGroups.find(
      (item) => item.id === pending.groupId,
    )!
    const replacements: Array<{ connectionName: string; path: Point[] }> = []
    for (const connectionName of group.connectionNames) {
      const route = this.candidate.routes.find(
        (item) => item.net.connectionName === connectionName,
      )
      if (!route) continue
      const start = pending.leg === "top" ? route.net.source : route.via
      const end = pending.leg === "top" ? route.via : route.net.target
      const anchorY =
        pending.leg === "top" ? route.net.source.y : route.net.target.y
      const paths = getOctilinearTemplates(start, end, [
        anchorY + pending.offset * this.candidate.plan.model.pitchY,
      ])
      const replacement = paths.at(-1)
      if (replacement) replacements.push({ connectionName, path: replacement })
    }
    if (replacements.length === group.connectionNames.length) {
      this.proposals.push({
        id: `bundle:${pending.groupId}:${pending.leg}:${pending.offset}`,
        busId: group.busId,
        leg: pending.leg,
        laneOffset: pending.offset,
        replacements,
      })
    }
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "proposeBundleRepairs",
      generatedProposals: this.proposals.length,
      evaluatedInputs: this.cursor,
      totalInputs: this.pending.length,
      activeGroup: this.pending[this.cursor]?.groupId ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.pending.length)
  }

  override getOutput(): BundleRepairPlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "ProposeBundleRepairsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.candidate.plan.model,
      assignments: this.candidate.plan.viaAssignments,
      routes: this.candidate.routes,
      violations: this.candidate.violations,
      repairProposal: this.proposals.at(-1),
      repairStatus: "proposed",
      stage: "propose coordinated bundle repair",
      progress: this.computeProgress(),
      counts: `${this.proposals.length} proposals`,
    })
  }
}

export class EvaluateBundleRepairsSolver extends BaseSolver {
  private readonly plan: BundleRepairPlan
  private readonly proposals: BundleRepairProposal[]
  private cursor = 0
  private output: BundleRepairPlan | null = null

  constructor(plan: BundleRepairPlan) {
    super()
    this.plan = plan
    this.proposals = plan.proposals.map((proposal) => ({ ...proposal }))
    this.MAX_ITERATIONS = this.proposals.length + 2
  }

  override getConstructorParams() {
    return [this.plan]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const proposal = this.proposals[this.cursor]
    if (!proposal) {
      this.output = {
        candidate: this.plan.candidate,
        proposals: this.proposals,
      }
      this.solved = true
      this.updateStats()
      return
    }
    const trialViolations = collectRouteViolations(
      this.plan.candidate.plan.model,
      applyProposal(this.plan.candidate.routes, proposal),
    )
    const score = scoreViolations(trialViolations)
    proposal.beforeViolationCount = this.plan.candidate.violations.length
    proposal.afterViolationCount = score.count
    proposal.afterViolationSeverity = score.severity
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "evaluateBundleRepairs",
      evaluatedProposals: this.cursor,
      totalProposals: this.proposals.length,
      improvingProposals: this.proposals.filter(
        (item) =>
          (item.afterViolationCount ?? Number.POSITIVE_INFINITY) <
          (item.beforeViolationCount ?? 0),
      ).length,
      activeProposal: this.proposals[this.cursor]?.id ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.proposals.length)
  }

  override getOutput(): BundleRepairPlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "EvaluateBundleRepairsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.plan.candidate.plan.model,
      assignments: this.plan.candidate.plan.viaAssignments,
      routes: this.plan.candidate.routes,
      violations: this.plan.candidate.violations,
      repairProposal: this.proposals[this.cursor],
      repairStatus: "proposed",
      stage: "evaluate coordinated bundle repair",
      progress: this.computeProgress(),
      counts: `${this.cursor}/${this.proposals.length} evaluated`,
    })
  }
}

export class CommitBundleRepairsSolver extends BaseSolver {
  private readonly plan: BundleRepairPlan
  private readonly proposals: BundleRepairProposal[]
  private readonly candidate: ViaFirstRouteCandidate
  private cursor = 0
  private accepted = 0
  private activeProposal: BundleRepairProposal | undefined
  private output: ViaFirstRouteCandidate | null = null

  constructor(plan: BundleRepairPlan) {
    super()
    this.plan = plan
    this.proposals = [...plan.proposals].sort(
      (first, second) =>
        (first.afterViolationCount ?? Number.POSITIVE_INFINITY) -
          (second.afterViolationCount ?? Number.POSITIVE_INFINITY) ||
        (first.afterViolationSeverity ?? Number.POSITIVE_INFINITY) -
          (second.afterViolationSeverity ?? Number.POSITIVE_INFINITY) ||
        first.id.localeCompare(second.id),
    )
    this.candidate = {
      ...plan.candidate,
      routes: cloneRoutes(plan.candidate.routes),
      violations: [...plan.candidate.violations],
    }
    this.MAX_ITERATIONS = this.proposals.length + 2
  }

  override getConstructorParams() {
    return [this.plan]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const proposal = this.proposals[this.cursor]
    this.activeProposal = proposal
    if (!proposal) {
      this.output = this.candidate
      this.solved = true
      this.updateStats()
      return
    }
    const trialRoutes = applyProposal(this.candidate.routes, proposal)
    const trialViolations = collectRouteViolations(
      this.candidate.plan.model,
      trialRoutes,
    )
    if (isBetterViolationScore(trialViolations, this.candidate.violations)) {
      this.candidate.routes = trialRoutes
      this.candidate.violations = trialViolations
      proposal.accepted = true
      this.accepted++
    } else {
      proposal.accepted = false
    }
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "commitBundleRepairs",
      consideredProposals: this.cursor,
      totalProposals: this.proposals.length,
      acceptedProposals: this.accepted,
      remainingViolations: this.candidate.violations.length,
      activeProposal: this.activeProposal?.id ?? null,
      activeStatus:
        this.activeProposal?.accepted === undefined
          ? null
          : this.activeProposal.accepted
            ? "accepted"
            : "rejected",
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.proposals.length)
  }

  override getOutput(): ViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "CommitBundleRepairsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.candidate.plan.model,
      assignments: this.candidate.plan.viaAssignments,
      routes: this.candidate.routes,
      violations: this.candidate.violations,
      repairProposal: this.activeProposal,
      repairStatus:
        this.activeProposal?.accepted === undefined
          ? "proposed"
          : this.activeProposal.accepted
            ? "accepted"
            : "rejected",
      stage: "commit coordinated bundle repair",
      progress: this.computeProgress(),
      counts: `${this.accepted} accepted · ${this.candidate.violations.length} DRC`,
    })
  }
}
