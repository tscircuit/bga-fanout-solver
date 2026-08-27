import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import {
  buildDropTrace,
  buildViaObstacle,
  compareLayers,
  containsPoint,
  dropVia,
  isTopPathLegal,
  isViaLegal,
  octilinearCandidates,
  pathLength,
  traceSegments,
  type PowerPlaneCandidateGeometry,
} from "../model/powerPlanePlanning"
import { Q } from "../model/geometry"
import { findBoundedLegalViaLineCandidates } from "../model/boundedViaLinePathSearch"
import { generateOutwardViaLineCandidates } from "../model/viaLineCandidates"
import type {
  CopperPourViaDrop,
  FanoutModel,
  Point,
  PowerPlanePlan,
  SameNetPadCluster,
  UnresolvedCopperPourViaDrop,
} from "../model/types"
import { visualizeCopperPourViaDrops } from "../visualize/powerPlaneVisuals"
import type { IncrementalReferenceFanoutSession } from "../private/reference/solve-am62l-free-space-fanout"
import type { PowerPlanePlanningContext } from "./PlanSameNetPadClustersSolver"

type DropCandidate = CopperPourViaDrop & {
  candidateId: string
  geometry: PowerPlaneCandidateGeometry
}

const SEARCH_NODE_LIMIT = 5_000

const isViaInsideRoutingBounds = (model: FanoutModel, via: Point) => {
  const radius = model.rules.viaDiameter / 2
  return (
    via.x - radius >= model.routingBounds.minX &&
    via.x + radius <= model.routingBounds.maxX &&
    via.y - radius >= model.routingBounds.minY &&
    via.y + radius <= model.routingBounds.maxY
  )
}

/**
 * Plans one deterministic dogbone/through-via drop for as many disconnected
 * power clusters as possible. An impossible cluster is recorded and skipped;
 * it never makes the fixed-target signal pipeline fail.
 */
export class PlanCopperPourViaDropsSolver extends BaseSolver {
  private readonly model: FanoutModel
  private output: FanoutModel | null = null
  private plan: PowerPlanePlan
  private readonly candidatesByCluster = new Map<string, DropCandidate[]>()
  private clusterCursor = 0
  private searchNodes = 0
  private searchBudgetExhausted = false

  constructor(private readonly context: PowerPlanePlanningContext) {
    super()
    this.model = context.model
    this.plan = this.model.powerPlanePlan
      ? structuredClone(this.model.powerPlanePlan)
      : {
          pours: [],
          pads: [],
          links: [],
          clusters: [],
          legalViaCandidateCount: 0,
          viaDrops: [],
          unresolvedViaDrops: [],
        }
    this.MAX_ITERATIONS = Math.max(2, this.plan.clusters.length + 2)
  }

  override getConstructorParams() {
    return [this.context]
  }

  override _setup() {
    this.updateStats("ready")
  }

  override _step() {
    const cluster = this.plan.clusters[this.clusterCursor++]
    if (cluster) {
      this.candidatesByCluster.set(cluster.id, this.generateCandidates(cluster))
      this.updateStats("enumerate_legal_drop_candidates", cluster.id)
      return
    }
    this.assignAndCommit()
  }

  private generateCandidates(cluster: SameNetPadCluster): DropCandidate[] {
    const pours = this.plan.pours.filter((pour) =>
      cluster.matchingPourIds.includes(pour.id),
    )
    const candidates: DropCandidate[] = []
    const seen = new Set<string>()
    const clusterPads = cluster.padIds
      .map((padId) => this.plan.pads.find((pad) => pad.id === padId))
      .filter((pad): pad is NonNullable<typeof pad> => Boolean(pad))
    for (const sourcePadId of cluster.padIds) {
      const pad = this.plan.pads.find(
        (candidate) => candidate.id === sourcePadId,
      )
      if (!pad) continue
      const viaSites: Point[] = []
      for (const xSign of [-1, 1] as const) {
        for (const ySign of [-1, 1] as const) {
          viaSites.push({
            x: Q(pad.x + (xSign * this.model.pitchX) / 2),
            y: Q(pad.y + (ySign * this.model.pitchY) / 2),
          })
        }
      }
      const viaPathCandidates = viaSites.flatMap((via) =>
        octilinearCandidates(pad, via).map((path) => ({ via, path })),
      )
      viaPathCandidates.push(
        ...generateOutwardViaLineCandidates(this.model, pad, clusterPads),
      )
      viaPathCandidates.sort(
        (first, second) =>
          pathLength(first.path) - pathLength(second.path) ||
          first.via.x - second.via.x ||
          first.via.y - second.via.y ||
          JSON.stringify(first.path).localeCompare(JSON.stringify(second.path)),
      )
      const addLegalCandidate = (via: Point, path: Point[]) => {
        if (
          !isViaInsideRoutingBounds(this.model, via) ||
          !isViaLegal({
            model: this.model,
            via,
            netKey: cluster.netKey,
            committedGeometry: [],
          }) ||
          !isTopPathLegal({
            model: this.model,
            path,
            netKey: cluster.netKey,
            ignoredPadIds: new Set([pad.id]),
            powerPads: this.plan.pads,
            committedGeometry: [],
          })
        ) {
          return
        }
        for (const pour of pours) {
          if (!containsPoint(pour, via)) continue
          for (const terminationLayer of [...pour.layers].sort(compareLayers)) {
            const candidateKey = [
              cluster.id,
              pad.id,
              Q(via.x),
              Q(via.y),
              pour.id,
              terminationLayer,
            ].join(":")
            if (seen.has(candidateKey)) continue
            seen.add(candidateKey)
            const drop: CopperPourViaDrop = {
              id: `drop:${candidateKey}`,
              clusterId: cluster.id,
              netKey: cluster.netKey,
              sourcePadId: pad.id,
              via,
              topPath: path,
              pourId: pour.id,
              terminationLayer,
            }
            candidates.push({
              ...drop,
              candidateId: candidateKey,
              geometry: { path, via, netKey: cluster.netKey },
            })
          }
        }
      }
      const candidateCountBeforePad = candidates.length
      for (const { via, path } of viaPathCandidates) {
        addLegalCandidate(via, path)
      }
      if (candidates.length === candidateCountBeforePad) {
        for (const fallback of findBoundedLegalViaLineCandidates({
          model: this.model,
          pad,
          clusterPads,
          pours,
          powerPads: this.plan.pads,
          netKey: cluster.netKey,
        })) {
          addLegalCandidate(fallback.via, fallback.path)
        }
      }
    }
    const sortedCandidates = candidates.sort(
      (first, second) =>
        pathLength(first.topPath) - pathLength(second.topPath) ||
        compareLayers(first.terminationLayer, second.terminationLayer) ||
        first.via.x - second.via.x ||
        first.via.y - second.via.y ||
        first.sourcePadId.localeCompare(second.sourcePadId) ||
        first.candidateId.localeCompare(second.candidateId),
    )
    const seenViaSites = new Set<string>()
    return sortedCandidates.filter((candidate) => {
      const viaKey = `${Q(candidate.via.x)}:${Q(candidate.via.y)}`
      if (seenViaSites.has(viaKey)) return false
      seenViaSites.add(viaKey)
      return true
    })
  }

  private candidateFits(
    candidate: DropCandidate,
    selected: readonly DropCandidate[],
  ) {
    const committedGeometry = selected.map((item) => item.geometry)
    return (
      isViaLegal({
        model: this.model,
        via: candidate.via,
        netKey: candidate.netKey,
        committedGeometry,
      }) &&
      isTopPathLegal({
        model: this.model,
        path: candidate.topPath,
        netKey: candidate.netKey,
        ignoredPadIds: new Set([candidate.sourcePadId]),
        powerPads: this.plan.pads,
        committedGeometry,
      })
    )
  }

  private assignAndCommit() {
    const clusters = [...this.plan.clusters].sort((first, second) => {
      const firstCount = this.candidatesByCluster.get(first.id)?.length ?? 0
      const secondCount = this.candidatesByCluster.get(second.id)?.length ?? 0
      return firstCount - secondCount || first.id.localeCompare(second.id)
    })
    let best: DropCandidate[] = []
    const selected: DropCandidate[] = []
    const search = (clusterIndex: number) => {
      this.searchNodes++
      if (selected.length > best.length) best = [...selected]
      if (this.searchNodes > SEARCH_NODE_LIMIT) {
        this.searchBudgetExhausted = true
        return
      }
      if (selected.length + (clusters.length - clusterIndex) <= best.length) {
        return
      }
      if (clusterIndex >= clusters.length) {
        best = [...selected]
        return
      }
      const cluster = clusters[clusterIndex]!
      for (const candidate of this.candidatesByCluster.get(cluster.id) ?? []) {
        if (!this.candidateFits(candidate, selected)) continue
        selected.push(candidate)
        search(clusterIndex + 1)
        selected.pop()
        if (best.length === clusters.length || this.searchBudgetExhausted)
          return
      }
      search(clusterIndex + 1)
    }
    search(0)

    const selectedByCluster = new Map(
      best.map((candidate) => [candidate.clusterId, candidate]),
    )
    const drops = clusters
      .map((cluster) => selectedByCluster.get(cluster.id))
      .filter((drop): drop is DropCandidate => Boolean(drop))
      .map(({ candidateId: _, geometry: __, ...drop }) => drop)
    const unresolved: UnresolvedCopperPourViaDrop[] = clusters
      .filter((cluster) => !selectedByCluster.has(cluster.id))
      .map((cluster) => {
        const candidates = this.candidatesByCluster.get(cluster.id) ?? []
        const reasonCode =
          candidates.length === 0
            ? "no_legal_candidate"
            : this.searchBudgetExhausted
              ? "search_budget_exhausted"
              : "assignment_conflict"
        return {
          clusterId: cluster.id,
          netKey: cluster.netKey,
          padIds: [...cluster.padIds],
          reasonCode,
          message:
            reasonCode === "no_legal_candidate"
              ? "No legal dogbone/via site lies inside a matching copper pour."
              : reasonCode === "search_budget_exhausted"
                ? "The bounded deterministic assignment search kept the best partial result."
                : "All legal sites conflict with higher-priority committed plane drops.",
        }
      })
    this.plan = {
      ...this.plan,
      legalViaCandidateCount: [...this.candidatesByCluster.values()].reduce(
        (sum, candidates) => sum + candidates.length,
        0,
      ),
      viaDrops: drops,
      unresolvedViaDrops: unresolved,
    }
    const dropTraces = drops.map((drop) =>
      buildDropTrace(this.model, drop, this.plan.pads),
    )
    this.output = {
      ...this.model,
      input: {
        ...this.model.input,
        traces: [...(this.model.input.traces ?? []), ...dropTraces],
        obstacles: [
          ...this.model.input.obstacles,
          ...drops.map((drop) => buildViaObstacle(this.model, drop)),
        ],
      },
      previousSegments: [
        ...this.model.previousSegments,
        ...drops.flatMap((drop) =>
          traceSegments(this.model, drop.topPath, drop.netKey),
        ),
      ],
      previousVias: [
        ...this.model.previousVias,
        ...drops.map((drop) => dropVia(drop)),
      ],
      powerPlanePlan: this.plan,
    }
    this.context.session.commitPowerPlaneModel(this.output)
    this.solved = true
    this.updateStats("completed")
  }

  private updateStats(action: string, activeClusterId: string | null = null) {
    const candidateCount = [...this.candidatesByCluster.values()].reduce(
      (sum, candidates) => sum + candidates.length,
      0,
    )
    this.stats = {
      action,
      status: this.solved ? "completed" : "planning",
      clusters: this.plan.clusters.length,
      evaluatedClusters: Math.min(
        this.clusterCursor,
        this.plan.clusters.length,
      ),
      legalViaCandidates: candidateCount,
      droppedClusters: this.plan.viaDrops.length,
      skippedClusters: this.plan.unresolvedViaDrops.length,
      unresolved: this.plan.unresolvedViaDrops.map((item) => ({
        clusterId: item.clusterId,
        netKey: item.netKey,
        reasonCode: item.reasonCode,
        message: item.message,
      })),
      searchNodes: this.searchNodes,
      searchBudgetExhausted: this.searchBudgetExhausted,
      activeClusterId,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.clusterCursor / Math.max(1, this.plan.clusters.length + 1)
  }

  override getOutput(): IncrementalReferenceFanoutSession {
    if (!this.solved || !this.output) {
      throw new Error(
        "PlanCopperPourViaDropsSolver output requested before completion",
      )
    }
    return this.context.session
  }

  override visualize(): GraphicsObject {
    return visualizeCopperPourViaDrops(this.model, this.plan)
  }
}
