import { distance, EPS, Q } from "./geometry"
import {
  containsPoint,
  isTopPathLegal,
  isViaLegal,
  pathLength,
  pointSegmentDistance,
} from "./powerPlanePlanning"
import type { FanoutModel, Point, PowerPlanePad, PowerPlanePour } from "./types"
import {
  generateOutwardViaLineCandidates,
  type ViaLineCandidate,
} from "./viaLineCandidates"

const MAX_BEND_NODES = 48
const MAX_FALLBACK_PATHS = 24
const MAX_VIA_SITES = 64

const compassDirections: Point[] = [
  { x: 1, y: 0 },
  { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: 0, y: 1 },
  { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  { x: -1, y: 0 },
  { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  { x: 0, y: -1 },
  { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
]

const pointKey = (point: Point) => `${Q(point.x)}:${Q(point.y)}`
const pathKey = (path: readonly Point[]) => path.map(pointKey).join("|")

const simplifyPath = (path: readonly Point[]) => {
  const result: Point[] = []
  for (const point of path) {
    const quantized = { x: Q(point.x), y: Q(point.y) }
    if (!result.at(-1) || distance(result.at(-1)!, quantized) > EPS) {
      result.push(quantized)
    }
  }
  return result
}

const bendCount = (path: readonly Point[]) => Math.max(0, path.length - 2)

const insideBounds = (model: FanoutModel, point: Point) => {
  const margin = model.rules.traceWidth / 2
  return (
    point.x - margin >= model.routingBounds.minX - EPS &&
    point.x + margin <= model.routingBounds.maxX + EPS &&
    point.y - margin >= model.routingBounds.minY - EPS &&
    point.y + margin <= model.routingBounds.maxY + EPS
  )
}

const projectionOnSegment = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const amount =
    lengthSquared <= EPS
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) /
              lengthSquared,
          ),
        )
  return { x: start.x + amount * dx, y: start.y + amount * dy }
}

const getBendNodes = (
  model: FanoutModel,
  pad: PowerPlanePad,
  rawCandidates: readonly ViaLineCandidate[],
) => {
  const nodes: Point[] = rawCandidates.flatMap((candidate) =>
    candidate.path.slice(1, -1),
  )
  const minimumPitch = Math.min(model.pitchX, model.pitchY)
  const maximumPitch = Math.max(model.pitchX, model.pitchY)
  for (const direction of compassDirections) {
    for (const amount of [minimumPitch / 2, minimumPitch, maximumPitch * 1.5]) {
      nodes.push({
        x: Q(pad.x + direction.x * amount),
        y: Q(pad.y + direction.y * amount),
      })
    }
  }

  const tracePadDistance =
    model.rules.traceWidth / 2 + model.rules.traceToPadClearance + 2 * EPS
  for (const obstaclePad of [...model.pads]
    .filter((item) => item.id !== pad.id)
    .sort(
      (first, second) =>
        distance(pad, first) - distance(pad, second) ||
        first.id.localeCompare(second.id),
    )
    .slice(0, 24)) {
    const radius = obstaclePad.radius + tracePadDistance
    for (const direction of compassDirections) {
      nodes.push({
        x: Q(obstaclePad.x + direction.x * radius),
        y: Q(obstaclePad.y + direction.y * radius),
      })
    }
  }

  const traceTraceDistance =
    model.rules.traceWidth + model.rules.traceClearance + 2 * EPS
  for (const segment of [...model.previousSegments]
    .filter((item) => item.layer === "top")
    .sort(
      (first, second) =>
        pointSegmentDistance(pad, first.a, first.b) -
          pointSegmentDistance(pad, second.a, second.b) ||
        first.a.x - second.a.x ||
        first.a.y - second.a.y,
    )
    .slice(0, 20)) {
    const dx = segment.b.x - segment.a.x
    const dy = segment.b.y - segment.a.y
    const magnitude = Math.hypot(dx, dy)
    if (magnitude <= EPS) continue
    const normal = { x: -dy / magnitude, y: dx / magnitude }
    const projection = projectionOnSegment(pad, segment.a, segment.b)
    for (const anchor of [segment.a, segment.b, projection]) {
      for (const sign of [-1, 1]) {
        nodes.push({
          x: Q(anchor.x + sign * normal.x * traceTraceDistance),
          y: Q(anchor.y + sign * normal.y * traceTraceDistance),
        })
      }
    }
  }

  const traceViaDistance =
    model.rules.viaDiameter / 2 +
    model.rules.traceWidth / 2 +
    model.rules.traceToViaClearance +
    2 * EPS
  for (const via of [...model.previousVias]
    .sort(
      (first, second) =>
        distance(pad, first) - distance(pad, second) ||
        first.x - second.x ||
        first.y - second.y,
    )
    .slice(0, 16)) {
    for (const direction of compassDirections) {
      nodes.push({
        x: Q(via.x + direction.x * traceViaDistance),
        y: Q(via.y + direction.y * traceViaDistance),
      })
    }
  }

  const center = {
    x: (model.padBounds.minX + model.padBounds.maxX) / 2,
    y: (model.padBounds.minY + model.padBounds.maxY) / 2,
  }
  const outward = { x: pad.x - center.x, y: pad.y - center.y }
  const seen = new Set<string>()
  return nodes
    .filter((point) => insideBounds(model, point))
    .sort((first, second) => {
      const firstVector = { x: first.x - pad.x, y: first.y - pad.y }
      const secondVector = { x: second.x - pad.x, y: second.y - pad.y }
      const firstOutward = -(
        firstVector.x * outward.x +
        firstVector.y * outward.y
      )
      const secondOutward = -(
        secondVector.x * outward.x +
        secondVector.y * outward.y
      )
      return (
        distance(pad, first) - distance(pad, second) ||
        firstOutward - secondOutward ||
        first.x - second.x ||
        first.y - second.y
      )
    })
    .filter((point) => {
      const key = pointKey(point)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_BEND_NODES)
}

/**
 * A bounded two-bend visibility search used only after ordinary dogbone
 * templates find no legal route. Nodes come from package pitch and nearby
 * pad/trace/via clearance boundaries, never component-specific coordinates.
 */
export const findBoundedLegalViaLineCandidates = ({
  model,
  pad,
  clusterPads,
  pours,
  powerPads,
  netKey,
}: {
  model: FanoutModel
  pad: PowerPlanePad
  clusterPads: readonly PowerPlanePad[]
  pours: readonly PowerPlanePour[]
  powerPads: readonly PowerPlanePad[]
  netKey: string
}): ViaLineCandidate[] => {
  const rawCandidates = generateOutwardViaLineCandidates(
    model,
    pad,
    clusterPads,
    netKey,
  )
  const viaByKey = new Map<string, Point>()
  for (const candidate of rawCandidates) {
    if (!pours.some((pour) => containsPoint(pour, candidate.via))) continue
    if (
      !isViaLegal({
        model,
        via: candidate.via,
        netKey,
        committedGeometry: [],
      })
    ) {
      continue
    }
    viaByKey.set(pointKey(candidate.via), candidate.via)
  }
  const vias = [...viaByKey.values()]
    .sort(
      (first, second) =>
        distance(pad, first) - distance(pad, second) ||
        first.x - second.x ||
        first.y - second.y,
    )
    .slice(0, MAX_VIA_SITES)
  if (vias.length === 0) return []

  const nodes = getBendNodes(model, pad, rawCandidates)
  const ignoredPadIds = new Set([pad.id])
  const edgeCache = new Map<string, boolean>()
  const edgeIsLegal = (first: Point, second: Point) => {
    const sortedKey = [pointKey(first), pointKey(second)].sort().join("|")
    const cached = edgeCache.get(sortedKey)
    if (cached !== undefined) return cached
    const legal = isTopPathLegal({
      model,
      path: [first, second],
      netKey,
      ignoredPadIds,
      powerPads,
      committedGeometry: [],
    })
    edgeCache.set(sortedKey, legal)
    return legal
  }

  const startReachable = nodes.filter((node) => edgeIsLegal(pad, node))
  const results: ViaLineCandidate[] = []
  for (const via of vias) {
    if (edgeIsLegal(pad, via)) {
      results.push({
        path: [pad, via],
        via,
        bendCount: 0,
        directionRank: 0,
        kind: "clearance-event",
      })
      continue
    }
    const endReachable = nodes.filter((node) => edgeIsLegal(node, via))
    for (const first of startReachable) {
      if (endReachable.some((last) => pointKey(last) === pointKey(first))) {
        results.push({
          path: simplifyPath([pad, first, via]),
          via,
          bendCount: 1,
          directionRank: 0,
          kind: "clearance-event",
        })
      }
      for (const second of endReachable) {
        if (!edgeIsLegal(first, second)) continue
        results.push({
          path: simplifyPath([pad, first, second, via]),
          via,
          bendCount: 2,
          directionRank: 0,
          kind: "clearance-event",
        })
      }
    }
  }

  const seen = new Set<string>()
  return results
    .sort(
      (first, second) =>
        pathLength(first.path) - pathLength(second.path) ||
        bendCount(first.path) - bendCount(second.path) ||
        first.via.x - second.via.x ||
        first.via.y - second.via.y ||
        pathKey(first.path).localeCompare(pathKey(second.path)),
    )
    .filter((candidate) => {
      const key = pathKey(candidate.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_FALLBACK_PATHS)
}
