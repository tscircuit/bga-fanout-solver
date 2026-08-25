import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import {
  buildLinkTrace,
  discoverPowerPlaneTopology,
  isTopPathLegal,
  octilinearCandidates,
  pathLength,
  traceSegments,
  type PowerPlaneCandidateGeometry,
} from "../model/powerPlanePlanning"
import type {
  FanoutModel,
  PowerPlanePlan,
  SameNetPadCluster,
  SameNetPadLink,
} from "../model/types"
import type { IncrementalReferenceFanoutSession } from "../private/reference/solve-am62l-free-space-fanout"
import { visualizeSameNetPadClusters } from "../visualize/powerPlaneVisuals"

export type PowerPlanePlanningContext = {
  session: IncrementalReferenceFanoutSession
  model: FanoutModel
}

type AdjacentCandidate = {
  firstPadId: string
  secondPadId: string
  netKey: string
  rowDelta: number
  columnDelta: number
}

class DisjointSet {
  private readonly parent = new Map<string, string>()

  constructor(ids: readonly string[]) {
    for (const id of ids) this.parent.set(id, id)
  }

  find(id: string): string {
    const parent = this.parent.get(id)
    if (!parent) throw new Error(`unknown power pad ${id}`)
    if (parent === id) return id
    const root = this.find(parent)
    this.parent.set(id, root)
    return root
  }

  union(first: string, second: string) {
    const firstRoot = this.find(first)
    const secondRoot = this.find(second)
    if (firstRoot === secondRoot) return false
    const [root, child] = [firstRoot, secondRoot].sort()
    this.parent.set(child!, root!)
    return true
  }
}

/**
 * Finds exact-same-net neighboring BGA power pads and commits only legal,
 * short top-copper links. The selected links form a deterministic spanning
 * forest, so every member of a multi-pad cluster has a physical copper path
 * to every other member.
 */
export class PlanSameNetPadClustersSolver extends BaseSolver {
  private readonly model: FanoutModel
  private output: FanoutModel | null = null
  private plan: PowerPlanePlan | null = null
  private readonly candidates: AdjacentCandidate[]
  private readonly disjointSet: DisjointSet
  private readonly links: SameNetPadLink[] = []
  private readonly committedGeometry: PowerPlaneCandidateGeometry[] = []
  private cursor = 0

  constructor(private readonly session: IncrementalReferenceFanoutSession) {
    super()
    const signalModel = session.getVisualizationContext().model
    const signalRoutes = session.getRoutes()
    this.model = {
      ...signalModel,
      previousSegments: [
        ...signalModel.previousSegments,
        ...signalRoutes.flatMap((route) => [
          ...route.topPath.slice(1).map((point, index) => ({
            a: route.topPath[index]!,
            b: point,
            layer: "top",
            connectionName: route.connectionName,
          })),
          ...route.innerPath.slice(1).map((point, index) => ({
            a: route.innerPath[index]!,
            b: point,
            layer: route.selectedLayer,
            connectionName: route.connectionName,
          })),
        ]),
      ],
      previousVias: [
        ...signalModel.previousVias,
        ...signalRoutes.map((route) => ({
          ...route.via,
          fromLayer: "top",
          toLayer: "bottom",
        })),
      ],
    }
    const topology = discoverPowerPlaneTopology(this.model)
    this.plan = {
      ...topology,
      links: [],
      clusters: [],
      legalViaCandidateCount: 0,
      viaDrops: [],
      unresolvedViaDrops: [],
    }
    this.disjointSet = new DisjointSet(topology.pads.map((pad) => pad.id))
    this.candidates = []
    for (let firstIndex = 0; firstIndex < topology.pads.length; firstIndex++) {
      const first = topology.pads[firstIndex]!
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < topology.pads.length;
        secondIndex++
      ) {
        const second = topology.pads[secondIndex]!
        if (first.netKey !== second.netKey) continue
        const rowDelta = Math.abs(first.row - second.row)
        const columnDelta = Math.abs(first.column - second.column)
        if (
          rowDelta > 1 ||
          columnDelta > 1 ||
          (rowDelta === 0 && columnDelta === 0)
        ) {
          continue
        }
        this.candidates.push({
          firstPadId: first.id,
          secondPadId: second.id,
          netKey: first.netKey,
          rowDelta,
          columnDelta,
        })
      }
    }
    this.candidates.sort(
      (first, second) =>
        first.netKey.localeCompare(second.netKey) ||
        first.rowDelta +
          first.columnDelta -
          (second.rowDelta + second.columnDelta) ||
        first.firstPadId.localeCompare(second.firstPadId) ||
        first.secondPadId.localeCompare(second.secondPadId),
    )
    this.MAX_ITERATIONS = Math.max(2, this.candidates.length + 2)
  }

  override getConstructorParams() {
    return [this.session]
  }

  override _setup() {
    this.updateStats("ready")
  }

  override _step() {
    const candidate = this.candidates[this.cursor++]
    if (candidate) {
      this.evaluateCandidate(candidate)
      this.updateStats("evaluate_legal_same_net_link", candidate)
      return
    }
    this.finishPlan()
  }

  private evaluateCandidate(candidate: AdjacentCandidate) {
    if (
      this.disjointSet.find(candidate.firstPadId) ===
      this.disjointSet.find(candidate.secondPadId)
    ) {
      return
    }
    const first = this.plan!.pads.find(
      (pad) => pad.id === candidate.firstPadId,
    )!
    const second = this.plan!.pads.find(
      (pad) => pad.id === candidate.secondPadId,
    )!
    const path = octilinearCandidates(first, second)
      .filter((candidatePath) =>
        isTopPathLegal({
          model: this.model,
          path: candidatePath,
          netKey: candidate.netKey,
          ignoredPadIds: new Set([first.id, second.id]),
          powerPads: this.plan!.pads,
          committedGeometry: this.committedGeometry,
        }),
      )
      .sort(
        (firstPath, secondPath) =>
          pathLength(firstPath) - pathLength(secondPath) ||
          JSON.stringify(firstPath).localeCompare(JSON.stringify(secondPath)),
      )[0]
    if (!path) return
    if (!this.disjointSet.union(first.id, second.id)) return
    const link: SameNetPadLink = {
      id: `link:${candidate.netKey}:${first.id}:${second.id}`,
      netKey: candidate.netKey,
      firstPadId: first.id,
      secondPadId: second.id,
      path,
      length: pathLength(path),
    }
    this.links.push(link)
    this.committedGeometry.push({ path, netKey: candidate.netKey })
  }

  private finishPlan() {
    const linksByRoot = new Map<string, string[]>()
    const padsByRoot = new Map<string, string[]>()
    for (const pad of this.plan!.pads) {
      const root = this.disjointSet.find(pad.id)
      const pads = padsByRoot.get(root) ?? []
      pads.push(pad.id)
      padsByRoot.set(root, pads)
    }
    for (const link of this.links) {
      const root = this.disjointSet.find(link.firstPadId)
      const links = linksByRoot.get(root) ?? []
      links.push(link.id)
      linksByRoot.set(root, links)
    }
    const clusters: SameNetPadCluster[] = [...padsByRoot.entries()]
      .map(([root, padIds]) => {
        padIds.sort()
        const clusterPads = padIds.map(
          (id) => this.plan!.pads.find((pad) => pad.id === id)!,
        )
        return {
          id: `cluster:${clusterPads[0]!.netKey}:${padIds[0]}`,
          netKey: clusterPads[0]!.netKey,
          padIds,
          linkIds: (linksByRoot.get(root) ?? []).sort(),
          matchingPourIds: [
            ...new Set(clusterPads.flatMap((pad) => pad.matchingPourIds)),
          ].sort(),
        }
      })
      .sort(
        (first, second) =>
          first.netKey.localeCompare(second.netKey) ||
          first.id.localeCompare(second.id),
      )
    this.plan = {
      ...this.plan!,
      links: this.links,
      clusters,
    }
    const linkTraces = this.links.map((link) =>
      buildLinkTrace(this.model, link, this.plan!.pads),
    )
    this.output = {
      ...this.model,
      input: {
        ...this.model.input,
        traces: [...(this.model.input.traces ?? []), ...linkTraces],
      },
      previousSegments: [
        ...this.model.previousSegments,
        ...this.links.flatMap((link) =>
          traceSegments(this.model, link.path, link.netKey),
        ),
      ],
      powerPlanePlan: this.plan,
    }
    this.solved = true
    this.updateStats("completed")
  }

  private updateStats(action: string, active?: AdjacentCandidate) {
    this.stats = {
      action,
      status: this.solved ? "completed" : "planning",
      eligiblePads: this.plan?.pads.length ?? 0,
      matchingPours: this.plan?.pours.length ?? 0,
      adjacentCandidates: this.candidates.length,
      evaluatedCandidates: Math.min(this.cursor, this.candidates.length),
      legalLinks: this.links.length,
      clusters: this.plan?.clusters.length ?? 0,
      activePadPair: active
        ? `${active.firstPadId} ↔ ${active.secondPadId}`
        : null,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.candidates.length + 1)
  }

  override getOutput(): PowerPlanePlanningContext {
    if (!this.solved || !this.output) {
      throw new Error(
        "PlanSameNetPadClustersSolver output requested before completion",
      )
    }
    return { session: this.session, model: this.output }
  }

  override visualize(): GraphicsObject {
    return visualizeSameNetPadClusters(this.model, {
      ...(this.plan ?? {
        pours: [],
        pads: [],
        clusters: [],
        legalViaCandidateCount: 0,
        viaDrops: [],
        unresolvedViaDrops: [],
      }),
      links: this.links,
    })
  }
}
