import { distance, EPS, Q } from "./geometry"
import {
  compareLayers,
  containsPoint,
  isTopPathLegal,
  isViaLegal,
  octilinearCandidates,
  pathLength,
  pathSegments,
  pointSegmentDistance,
  segmentDistance,
  type PowerPlaneCandidateGeometry,
} from "./powerPlanePlanning"
import { findBoundedLegalViaLineCandidates } from "./boundedViaLinePathSearch"
import type {
  CopperPourViaDrop,
  FanoutModel,
  Point,
  PowerPlanePlan,
} from "./types"
import { generateOutwardViaLineCandidates } from "./viaLineCandidates"
import type { ReferenceRouteSnapshot } from "../private/reference/solve-am62l-free-space-fanout"

export type PowerSignalCorridorCandidate = CopperPourViaDrop & {
  conflicts: string[]
  length: number
  bendCount: number
}

export type PowerSignalReservationPlan = {
  corridors: PowerSignalCorridorCandidate[]
  affectedSignalNames: string[]
  totalLength: number
  totalBends: number
}

const MAX_CANDIDATES_PER_CLUSTER = 12
const MAX_CONFLICTING_SIGNALS = 16
const MAX_PLAN_SEARCH_NODES = 2_048
const MAX_RESERVATION_PLANS = 4

const pointKey = (point: Point) => `${Q(point.x)}:${Q(point.y)}`
const pathKey = (path: readonly Point[]) => path.map(pointKey).join("|")
const trueBendCount = (path: readonly Point[]) => {
  let count = 0
  for (let index = 1; index < path.length - 1; index++) {
    const first = path[index - 1]!
    const middle = path[index]!
    const last = path[index + 1]!
    const firstDx = middle.x - first.x
    const firstDy = middle.y - first.y
    const secondDx = last.x - middle.x
    const secondDy = last.y - middle.y
    if (Math.abs(firstDx * secondDy - firstDy * secondDx) > EPS) count++
  }
  return count
}

const viaInsideRoutingBounds = (model: FanoutModel, via: Point) => {
  const radius = model.rules.viaDiameter / 2
  return (
    via.x - radius >= model.routingBounds.minX - EPS &&
    via.x + radius <= model.routingBounds.maxX + EPS &&
    via.y - radius >= model.routingBounds.minY - EPS &&
    via.y + radius <= model.routingBounds.maxY + EPS
  )
}

const corridorConflicts = (
  model: FanoutModel,
  path: readonly Point[],
  via: Point,
  routes: readonly ReferenceRouteSnapshot[],
) => {
  const conflicts = new Set<string>()
  const tracePairDistance = model.rules.traceWidth + model.rules.traceClearance
  const traceViaDistance =
    model.rules.viaDiameter / 2 +
    model.rules.traceWidth / 2 +
    model.rules.traceToViaClearance
  for (const route of routes) {
    const topSegments = pathSegments(route.topPath)
    const innerSegments = pathSegments(route.innerPath)
    if (
      pathSegments(path).some((corridorSegment) =>
        topSegments.some(
          (signalSegment) =>
            segmentDistance(
              corridorSegment.a,
              corridorSegment.b,
              signalSegment.a,
              signalSegment.b,
            ) +
              EPS <
            tracePairDistance,
        ),
      ) ||
      pathSegments(path).some(
        (corridorSegment) =>
          pointSegmentDistance(
            route.via,
            corridorSegment.a,
            corridorSegment.b,
          ) +
            EPS <
          traceViaDistance,
      ) ||
      topSegments.some(
        (segment) =>
          pointSegmentDistance(via, segment.a, segment.b) + EPS <
          traceViaDistance,
      ) ||
      innerSegments.some(
        (segment) =>
          pointSegmentDistance(via, segment.a, segment.b) + EPS <
          traceViaDistance,
      ) ||
      distance(via, route.via) + EPS < model.rules.viaToViaCenter
    ) {
      conflicts.add(route.connectionName)
    }
  }
  return [...conflicts].sort()
}

const candidateFitsCommitted = (
  model: FanoutModel,
  candidate: PowerSignalCorridorCandidate,
  committed: readonly PowerSignalCorridorCandidate[],
  existing: readonly PowerPlaneCandidateGeometry[],
  powerPads: PowerPlanePlan["pads"],
) => {
  const committedGeometry: PowerPlaneCandidateGeometry[] = [
    ...existing,
    ...committed.map((item) => ({
      path: item.topPath,
      via: item.via,
      netKey: item.netKey,
    })),
  ]
  return (
    isViaLegal({
      model,
      via: candidate.via,
      netKey: candidate.netKey,
      committedGeometry,
    }) &&
    isTopPathLegal({
      model,
      path: candidate.topPath,
      netKey: candidate.netKey,
      ignoredPadIds: new Set([candidate.sourcePadId]),
      powerPads,
      committedGeometry,
    })
  )
}

const compareCandidates = (
  first: PowerSignalCorridorCandidate,
  second: PowerSignalCorridorCandidate,
) =>
  first.conflicts.length - second.conflicts.length ||
  first.length - second.length ||
  first.bendCount - second.bendCount ||
  first.via.x - second.via.x ||
  first.via.y - second.via.y ||
  first.sourcePadId.localeCompare(second.sourcePadId) ||
  pathKey(first.topPath).localeCompare(pathKey(second.topPath))

const comparePlans = (
  first: PowerSignalReservationPlan,
  second: PowerSignalReservationPlan,
) =>
  first.affectedSignalNames.length - second.affectedSignalNames.length ||
  first.totalLength - second.totalLength ||
  first.totalBends - second.totalBends ||
  JSON.stringify(first.corridors.map((item) => item.id)).localeCompare(
    JSON.stringify(second.corridors.map((item) => item.id)),
  )

/**
 * Enumerates plane corridors that are legal against fixed copper and package
 * geometry, then records the exact routed signals that would need to move.
 * Signal copper is deliberately removed only for this measurement; every
 * candidate is revalidated after the signal trial reroute.
 */
export const buildBoundedPowerSignalReservationPlans = ({
  rankedModel,
  signalModel,
  plan,
  signalRoutes,
}: {
  rankedModel: FanoutModel
  signalModel: FanoutModel
  plan: PowerPlanePlan
  signalRoutes: readonly ReferenceRouteSnapshot[]
}): PowerSignalReservationPlan[] => {
  if (plan.unresolvedViaDrops.length === 0) return []
  const signalNames = new Set(signalRoutes.map((route) => route.connectionName))
  const staticModel: FanoutModel = {
    ...signalModel,
    previousSegments: signalModel.previousSegments.filter(
      (segment) => !signalNames.has(segment.connectionName ?? ""),
    ),
    previousVias: rankedModel.previousVias.map((via) => ({ ...via })),
  }
  const candidatesByCluster = new Map<string, PowerSignalCorridorCandidate[]>()
  const existingPowerGeometry = plan.viaDrops.map((drop) => ({
    path: drop.topPath,
    via: drop.via,
    netKey: drop.netKey,
  }))
  for (const unresolved of plan.unresolvedViaDrops) {
    const cluster = plan.clusters.find(
      (item) => item.id === unresolved.clusterId,
    )
    if (!cluster) continue
    const clusterPads = cluster.padIds
      .map((padId) => plan.pads.find((pad) => pad.id === padId))
      .filter((pad): pad is NonNullable<typeof pad> => Boolean(pad))
    const matchingPours = plan.pours.filter((pour) =>
      cluster.matchingPourIds.includes(pour.id),
    )
    const candidates: PowerSignalCorridorCandidate[] = []
    const seen = new Set<string>()
    for (const pad of clusterPads) {
      const localSites = [] as Array<{ via: Point; path: Point[] }>
      for (const xSign of [-1, 1] as const) {
        for (const ySign of [-1, 1] as const) {
          const via = {
            x: Q(pad.x + (xSign * staticModel.pitchX) / 2),
            y: Q(pad.y + (ySign * staticModel.pitchY) / 2),
          }
          localSites.push(
            ...octilinearCandidates(pad, via).map((path) => ({ via, path })),
          )
        }
      }
      localSites.push(
        ...generateOutwardViaLineCandidates(
          staticModel,
          pad,
          clusterPads,
          cluster.netKey,
        ),
      )
      const addCandidate = (via: Point, path: Point[]) => {
        if (
          !viaInsideRoutingBounds(staticModel, via) ||
          !isViaLegal({
            model: staticModel,
            via,
            netKey: cluster.netKey,
            committedGeometry: existingPowerGeometry,
          }) ||
          !isTopPathLegal({
            model: staticModel,
            path,
            netKey: cluster.netKey,
            ignoredPadIds: new Set([pad.id]),
            powerPads: plan.pads,
            committedGeometry: existingPowerGeometry,
          })
        ) {
          return
        }
        for (const pour of matchingPours) {
          if (!containsPoint(pour, via)) continue
          for (const terminationLayer of [...pour.layers].sort(compareLayers)) {
            const key = `${pad.id}:${pointKey(via)}:${pour.id}:${terminationLayer}:${pathKey(path)}`
            if (seen.has(key)) continue
            seen.add(key)
            const conflicts = corridorConflicts(
              signalModel,
              path,
              via,
              signalRoutes,
            )
            if (conflicts.length > MAX_CONFLICTING_SIGNALS) continue
            candidates.push({
              id: `co-route:${cluster.id}:${key}`,
              clusterId: cluster.id,
              netKey: cluster.netKey,
              sourcePadId: pad.id,
              via,
              topPath: path,
              pourId: pour.id,
              terminationLayer,
              conflicts,
              length: pathLength(path),
              bendCount: trueBendCount(path),
            })
          }
        }
      }
      for (const candidate of localSites) {
        addCandidate(candidate.via, candidate.path)
      }
      if (!candidates.some((candidate) => candidate.sourcePadId === pad.id)) {
        for (const candidate of findBoundedLegalViaLineCandidates({
          model: staticModel,
          pad,
          clusterPads,
          pours: matchingPours,
          powerPads: plan.pads,
          netKey: cluster.netKey,
        })) {
          addCandidate(candidate.via, candidate.path)
        }
      }
    }
    const byConflictShape = new Set<string>()
    candidatesByCluster.set(
      cluster.id,
      candidates
        .sort(compareCandidates)
        .filter((candidate) => {
          const key = `${candidate.conflicts.join("|")}:${pointKey(candidate.via)}`
          if (byConflictShape.has(key)) return false
          byConflictShape.add(key)
          return true
        })
        .slice(0, MAX_CANDIDATES_PER_CLUSTER),
    )
  }

  const clusters = plan.unresolvedViaDrops
    .map((item) => item.clusterId)
    .sort(
      (first, second) =>
        (candidatesByCluster.get(first)?.length ?? 0) -
          (candidatesByCluster.get(second)?.length ?? 0) ||
        first.localeCompare(second),
    )
  if (
    clusters.some((clusterId) => !candidatesByCluster.get(clusterId)?.length)
  ) {
    return []
  }
  const plans: PowerSignalReservationPlan[] = []
  const selected: PowerSignalCorridorCandidate[] = []
  const conflictNames = new Set<string>()
  let searchNodes = 0
  const search = (clusterIndex: number) => {
    if (++searchNodes > MAX_PLAN_SEARCH_NODES) return
    if (clusterIndex === clusters.length) {
      plans.push({
        corridors: [...selected],
        affectedSignalNames: [...conflictNames].sort(),
        totalLength: selected.reduce((sum, item) => sum + item.length, 0),
        totalBends: selected.reduce((sum, item) => sum + item.bendCount, 0),
      })
      plans.sort(comparePlans)
      if (plans.length > MAX_RESERVATION_PLANS)
        plans.length = MAX_RESERVATION_PLANS
      return
    }
    const clusterId = clusters[clusterIndex]!
    for (const candidate of candidatesByCluster.get(clusterId) ?? []) {
      if (
        !candidateFitsCommitted(
          staticModel,
          candidate,
          selected,
          existingPowerGeometry,
          plan.pads,
        )
      ) {
        continue
      }
      const added = candidate.conflicts.filter(
        (name) => !conflictNames.has(name),
      )
      if (conflictNames.size + added.length > MAX_CONFLICTING_SIGNALS) continue
      selected.push(candidate)
      for (const name of added) conflictNames.add(name)
      search(clusterIndex + 1)
      for (const name of added) conflictNames.delete(name)
      selected.pop()
    }
  }
  search(0)
  return plans.sort(comparePlans)
}

export const buildReservationGeometry = (
  initialPlan: PowerPlanePlan,
  reservationPlan: PowerSignalReservationPlan,
) => [
  ...initialPlan.viaDrops.map((drop) => ({
    path: drop.topPath,
    via: drop.via,
    netKey: drop.netKey,
  })),
  ...reservationPlan.corridors.map((corridor) => ({
    path: corridor.topPath,
    via: corridor.via,
    netKey: corridor.netKey,
  })),
]
