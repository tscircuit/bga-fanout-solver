import { distance, EPS, Q } from "./geometry"
import {
  isViaLegal,
  octilinearCandidates,
  pathLength,
  pointSegmentDistance,
} from "./powerPlanePlanning"
import type { FanoutModel, Point } from "./types"

export type ViaLineCandidate = {
  path: Point[]
  via: Point
  bendCount: number
  directionRank: number
  kind: "local" | "edge" | "radial" | "clearance-event"
}

const MAX_RADIAL_STEPS = 8
const MAX_EVENT_SEGMENTS = 40
const MAX_TOP_EVENT_SEGMENTS = 24
const MAX_EVENT_SITES = 64
const MAX_SITES_PER_PAD = 96
const MAX_PATHS_PER_SITE = 18
export const MAX_VIA_LINE_CANDIDATES_PER_PAD = 256

const simplifyPath = (path: readonly Point[]) => {
  const simplified: Point[] = []
  for (const point of path) {
    const quantized = { x: Q(point.x), y: Q(point.y) }
    if (!simplified.at(-1) || distance(simplified.at(-1)!, quantized) > EPS) {
      simplified.push(quantized)
    }
  }
  return simplified
}

const bendCount = (path: readonly Point[]) => {
  let bends = 0
  for (let index = 1; index < path.length - 1; index++) {
    const first = path[index - 1]!
    const middle = path[index]!
    const last = path[index + 1]!
    const firstDx = middle.x - first.x
    const firstDy = middle.y - first.y
    const secondDx = last.x - middle.x
    const secondDy = last.y - middle.y
    if (Math.abs(firstDx * secondDy - firstDy * secondDx) > EPS) bends++
  }
  return bends
}

const pointKey = (point: Point) => `${Q(point.x)}:${Q(point.y)}`
const pathKey = (path: readonly Point[]) => path.map(pointKey).join("|")

const packageCenter = (model: FanoutModel): Point => ({
  x: (model.padBounds.minX + model.padBounds.maxX) / 2,
  y: (model.padBounds.minY + model.padBounds.maxY) / 2,
})

const normalized = (vector: Point): Point => {
  const magnitude = Math.hypot(vector.x, vector.y)
  return magnitude <= EPS
    ? { x: 1, y: 0 }
    : { x: vector.x / magnitude, y: vector.y / magnitude }
}

const directionScore = (preferred: Point, direction: Point) =>
  -(preferred.x * direction.x + preferred.y * direction.y)

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

const outsideDensePackage = (model: FanoutModel, point: Point) => {
  // padBounds already extends half a pitch beyond the outer pad centers. The
  // exact pad-edge clearance is checked against every pad by isViaLegal; do
  // not unnecessarily push the barrel beyond a nearby plane boundary.
  const margin = model.rules.viaDiameter / 2 + EPS
  return (
    point.x <= model.padBounds.minX - margin ||
    point.x >= model.padBounds.maxX + margin ||
    point.y <= model.padBounds.minY - margin ||
    point.y >= model.padBounds.maxY + margin
  )
}

const rayExitFromExpandedBounds = (
  model: FanoutModel,
  start: Point,
  direction: Point,
) => {
  const margin = model.rules.viaDiameter / 2 + 2 * EPS
  const bounds = {
    minX: model.padBounds.minX - margin,
    maxX: model.padBounds.maxX + margin,
    minY: model.padBounds.minY - margin,
    maxY: model.padBounds.maxY + margin,
  }
  const amounts = [
    direction.x < -EPS ? (bounds.minX - start.x) / direction.x : undefined,
    direction.x > EPS ? (bounds.maxX - start.x) / direction.x : undefined,
    direction.y < -EPS ? (bounds.minY - start.y) / direction.y : undefined,
    direction.y > EPS ? (bounds.maxY - start.y) / direction.y : undefined,
  ].filter((amount): amount is number => amount !== undefined && amount >= 0)
  if (amounts.length === 0) return null
  const amount = Math.min(...amounts)
  return {
    x: Q(start.x + direction.x * amount),
    y: Q(start.y + direction.y * amount),
  }
}

type ViaSite = {
  via: Point
  direction: Point
  directionRank: number
  kind: ViaLineCandidate["kind"]
}

const lineIntersection = (
  firstPoint: Point,
  firstDirection: Point,
  secondPoint: Point,
  secondDirection: Point,
) => {
  const denominator =
    firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x
  if (Math.abs(denominator) <= EPS) return null
  const dx = secondPoint.x - firstPoint.x
  const dy = secondPoint.y - firstPoint.y
  const amount = (dx * secondDirection.y - dy * secondDirection.x) / denominator
  return {
    x: Q(firstPoint.x + amount * firstDirection.x),
    y: Q(firstPoint.y + amount * firstDirection.y),
  }
}

/**
 * Signal-clearance boundaries create useful deterministic event sites in
 * narrow channels where regular pitch sampling can step over the only legal
 * through-via center. Pairwise intersections are explicitly bounded.
 */
const getClearanceEventSites = (
  model: FanoutModel,
  pad: Point,
  preferred: Point,
  netKey?: string,
): ViaSite[] => {
  const searchRadius = Math.max(
    model.padBounds.maxX - model.padBounds.minX,
    model.padBounds.maxY - model.padBounds.minY,
    4 * Math.max(model.pitchX, model.pitchY),
    4 * model.rules.viaToViaCenter,
  )
  const rankedSegments = model.previousSegments
    .map((segment) => ({
      segment,
      distance: pointSegmentDistance(pad, segment.a, segment.b),
    }))
    .filter((item) => item.distance <= searchRadius)
    .sort(
      (first, second) =>
        first.distance - second.distance ||
        first.segment.layer.localeCompare(second.segment.layer) ||
        first.segment.a.x - second.segment.a.x ||
        first.segment.a.y - second.segment.a.y,
    )
  const selectedSegments = [
    ...rankedSegments
      .filter((item) => item.segment.layer === "top")
      .slice(0, MAX_TOP_EVENT_SEGMENTS),
    ...rankedSegments.filter((item) => item.segment.layer !== "top"),
  ]
  const seenSegments = new Set<string>()
  const segments = selectedSegments
    .filter((item) => {
      const key = `${item.segment.layer}:${pointKey(item.segment.a)}:${pointKey(item.segment.b)}`
      if (seenSegments.has(key)) return false
      seenSegments.add(key)
      return true
    })
    .slice(0, MAX_EVENT_SEGMENTS)
    .map((item) => item.segment)
  const clearance =
    model.rules.viaDiameter / 2 +
    model.rules.traceWidth / 2 +
    model.rules.traceToViaClearance +
    2 * EPS
  const offsetLines = segments.flatMap((segment) => {
    const direction = normalized({
      x: segment.b.x - segment.a.x,
      y: segment.b.y - segment.a.y,
    })
    const normal = { x: -direction.y, y: direction.x }
    return [-1, 1].map((sign) => ({
      point: {
        x: segment.a.x + sign * clearance * normal.x,
        y: segment.a.y + sign * clearance * normal.y,
      },
      direction,
    }))
  })
  const sites: ViaSite[] = []
  for (let firstIndex = 0; firstIndex < offsetLines.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < offsetLines.length;
      secondIndex++
    ) {
      const first = offsetLines[firstIndex]!
      const second = offsetLines[secondIndex]!
      const via = lineIntersection(
        first.point,
        first.direction,
        second.point,
        second.direction,
      )
      if (!via || !outsideDensePackage(model, via)) continue
      if (
        via.x < model.routingBounds.minX ||
        via.x > model.routingBounds.maxX ||
        via.y < model.routingBounds.minY ||
        via.y > model.routingBounds.maxY
      ) {
        continue
      }
      const direction = normalized({ x: via.x - pad.x, y: via.y - pad.y })
      sites.push({
        via,
        direction,
        directionRank: directionScore(preferred, direction),
        kind: "clearance-event",
      })
    }
  }
  const viaLegality = new Map<string, boolean>()
  if (netKey) {
    for (const site of sites) {
      const key = pointKey(site.via)
      if (viaLegality.has(key)) continue
      viaLegality.set(
        key,
        isViaLegal({
          model,
          via: site.via,
          netKey,
          committedGeometry: [],
        }),
      )
    }
  }
  return sites
    .sort(
      (first, second) =>
        (netKey
          ? Number(viaLegality.get(pointKey(second.via)) === true) -
            Number(viaLegality.get(pointKey(first.via)) === true)
          : 0) ||
        distance(pad, first.via) - distance(pad, second.via) ||
        first.directionRank - second.directionRank ||
        first.via.x - second.via.x ||
        first.via.y - second.via.y,
    )
    .slice(0, MAX_EVENT_SITES)
}

const getViaSites = (
  model: FanoutModel,
  pad: Point,
  clusterPads: readonly Point[],
  netKey?: string,
) => {
  const center = packageCenter(model)
  const clusterCenter = clusterPads.length
    ? {
        x:
          clusterPads.reduce((sum, item) => sum + item.x, 0) /
          clusterPads.length,
        y:
          clusterPads.reduce((sum, item) => sum + item.y, 0) /
          clusterPads.length,
      }
    : pad
  const preferred = normalized({
    x: clusterCenter.x - center.x,
    y: clusterCenter.y - center.y,
  })
  const sites: ViaSite[] = []
  const radialStep = model.rules.viaToViaCenter
  const packageMargin = model.rules.viaDiameter / 2 + 2 * EPS
  const sideDefinitions = [
    {
      direction: { x: -1, y: 0 },
      fixed: model.padBounds.minX - packageMargin,
      tangential: pad.y,
      axis: "x" as const,
    },
    {
      direction: { x: 1, y: 0 },
      fixed: model.padBounds.maxX + packageMargin,
      tangential: pad.y,
      axis: "x" as const,
    },
    {
      direction: { x: 0, y: -1 },
      fixed: model.padBounds.minY - packageMargin,
      tangential: pad.x,
      axis: "y" as const,
    },
    {
      direction: { x: 0, y: 1 },
      fixed: model.padBounds.maxY + packageMargin,
      tangential: pad.x,
      axis: "y" as const,
    },
  ].sort(
    (first, second) =>
      directionScore(preferred, first.direction) -
      directionScore(preferred, second.direction),
  )
  for (const side of sideDefinitions) {
    const transversePitch = side.axis === "x" ? model.pitchY : model.pitchX
    for (let depth = 0; depth < MAX_RADIAL_STEPS; depth++) {
      for (const transverse of [0, -0.5, 0.5, -1, 1]) {
        const tangential = side.tangential + transverse * transversePitch
        const normal = depth * radialStep
        const via =
          side.axis === "x"
            ? {
                x: Q(side.fixed + side.direction.x * normal),
                y: Q(tangential),
              }
            : {
                x: Q(tangential),
                y: Q(side.fixed + side.direction.y * normal),
              }
        sites.push({
          via,
          direction: side.direction,
          directionRank: directionScore(preferred, side.direction),
          kind: "edge",
        })
      }
    }
  }

  const rayDirections = [
    preferred,
    ...compassDirections
      .filter(
        (direction) =>
          preferred.x * direction.x + preferred.y * direction.y >= -EPS,
      )
      .sort(
        (first, second) =>
          directionScore(preferred, first) - directionScore(preferred, second),
      ),
  ]
  for (const rawDirection of rayDirections) {
    const direction = normalized(rawDirection)
    const exit = rayExitFromExpandedBounds(model, pad, direction)
    if (!exit) continue
    for (let depth = 0; depth < MAX_RADIAL_STEPS; depth++) {
      sites.push({
        via: {
          x: Q(exit.x + direction.x * depth * radialStep),
          y: Q(exit.y + direction.y * depth * radialStep),
        },
        direction,
        directionRank: directionScore(preferred, direction),
        kind: "radial",
      })
    }
  }
  sites.push(...getClearanceEventSites(model, pad, preferred, netKey))

  const seen = new Set<string>()
  return sites
    .filter((site) => outsideDensePackage(model, site.via))
    .sort(
      (first, second) =>
        distance(pad, first.via) - distance(pad, second.via) ||
        first.directionRank - second.directionRank ||
        first.kind.localeCompare(second.kind) ||
        first.via.x - second.via.x ||
        first.via.y - second.via.y,
    )
    .filter((site) => {
      const key = pointKey(site.via)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_SITES_PER_PAD)
}

const getPathVariants = (model: FanoutModel, start: Point, site: ViaSite) => {
  const paths: Point[][] = [
    [start, site.via],
    ...octilinearCandidates(start, site.via),
    [start, { x: site.via.x, y: start.y }, site.via],
    [start, { x: start.x, y: site.via.y }, site.via],
  ]
  const accessDistances = [
    Math.min(model.pitchX, model.pitchY) / 2,
    Math.max(model.pitchX, model.pitchY),
  ]
  const accessDirections = [...compassDirections].sort(
    (first, second) =>
      directionScore(site.direction, first) -
      directionScore(site.direction, second),
  )
  for (const accessDirection of accessDirections) {
    for (const accessDistance of accessDistances) {
      const access = {
        x: Q(start.x + accessDirection.x * accessDistance),
        y: Q(start.y + accessDirection.y * accessDistance),
      }
      for (const tail of octilinearCandidates(access, site.via)) {
        paths.push([start, ...tail])
      }
    }
  }
  const seen = new Set<string>()
  return paths
    .map(simplifyPath)
    .filter((path) => path.length >= 2 && bendCount(path) <= 2)
    .sort(
      (first, second) =>
        pathLength(first) - pathLength(second) ||
        bendCount(first) - bendCount(second) ||
        pathKey(first).localeCompare(pathKey(second)),
    )
    .filter((path) => {
      const key = pathKey(path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_PATHS_PER_SITE)
}

/**
 * Preserve a bounded lane-to-edge family for pads whose electrically useful
 * escape is on the far side of the package (for example, opposite the signal
 * portal). Global shortest-site truncation must not erase an entire side.
 */
const getReservedEdgeLaneCandidates = (
  model: FanoutModel,
  pad: Point,
): ViaLineCandidate[] => {
  const halfPitchX = model.pitchX / 2
  const halfPitchY = model.pitchY / 2
  const viaRadius = model.rules.viaDiameter / 2 + 2 * EPS
  const sideCoordinates = {
    left: Q(model.padBounds.minX - viaRadius),
    right: Q(model.padBounds.maxX + viaRadius),
    bottom: Q(model.padBounds.minY - viaRadius),
    top: Q(model.padBounds.maxY + viaRadius),
  }
  const candidates: ViaLineCandidate[] = []
  const add = (path: Point[], via: Point) => {
    const simplified = simplifyPath(path)
    candidates.push({
      path: simplified,
      via,
      bendCount: bendCount(simplified),
      directionRank: 0,
      kind: "edge",
    })
  }
  for (const ySign of [-1, 1] as const) {
    const laneY = Q(pad.y + ySign * halfPitchY)
    for (let depth = 0; depth < MAX_RADIAL_STEPS; depth++) {
      const offset = depth * model.rules.viaToViaCenter
      const leftVia = { x: Q(sideCoordinates.left - offset), y: laneY }
      const rightVia = { x: Q(sideCoordinates.right + offset), y: laneY }
      add([pad, { x: Q(pad.x - halfPitchX), y: laneY }, leftVia], leftVia)
      add([pad, { x: Q(pad.x + halfPitchX), y: laneY }, rightVia], rightVia)
    }
  }
  for (const xSign of [-1, 1] as const) {
    const laneX = Q(pad.x + xSign * halfPitchX)
    for (let depth = 0; depth < MAX_RADIAL_STEPS; depth++) {
      const offset = depth * model.rules.viaToViaCenter
      const bottomVia = { x: laneX, y: Q(sideCoordinates.bottom - offset) }
      const topVia = { x: laneX, y: Q(sideCoordinates.top + offset) }
      add([pad, { x: laneX, y: Q(pad.y - halfPitchY) }, bottomVia], bottomVia)
      add([pad, { x: laneX, y: Q(pad.y + halfPitchY) }, topVia], topVia)
    }
  }
  return candidates
}

/**
 * General bounded via-line enumeration for arbitrary BGA pitch, orientation,
 * and edge direction. It includes direct dogbones, orthogonal/45-degree
 * one/two-bend variants, geometry-derived radial exits, and narrow-channel
 * clearance events. Legality is deliberately evaluated by the owning solver.
 */
export const generateOutwardViaLineCandidates = (
  model: FanoutModel,
  pad: Point,
  clusterPads: readonly Point[] = [pad],
  netKey?: string,
): ViaLineCandidate[] => {
  const compareCandidates = (
    first: ViaLineCandidate,
    second: ViaLineCandidate,
  ) =>
    pathLength(first.path) - pathLength(second.path) ||
    first.bendCount - second.bendCount ||
    first.directionRank - second.directionRank ||
    first.via.x - second.via.x ||
    first.via.y - second.via.y ||
    pathKey(first.path).localeCompare(pathKey(second.path))
  const reserved = getReservedEdgeLaneCandidates(model, pad)
  const candidatesBySite = getViaSites(model, pad, clusterPads, netKey).map(
    (site) =>
      getPathVariants(model, pad, site).map((path) => ({
        path,
        via: site.via,
        bendCount: bendCount(path),
        directionRank: site.directionRank,
        kind: site.kind,
      })),
  )
  // Reserve the shortest route to every sampled site before admitting extra
  // path variants. This keeps narrow-channel clearance events and every
  // package side represented under the global candidate cap.
  const primaryCandidates = candidatesBySite.flatMap((siteCandidates) =>
    siteCandidates.length > 0 ? [siteCandidates[0]!] : [],
  )
  const extraCandidates = candidatesBySite
    .flatMap((siteCandidates) => siteCandidates.slice(1))
    .sort(
      (first, second) =>
        Number(second.kind === "clearance-event") -
          Number(first.kind === "clearance-event") ||
        compareCandidates(first, second),
    )
  const seen = new Set<string>()
  const uniqueReserved = reserved.filter((candidate) => {
    const key = `${pointKey(candidate.via)}:${pathKey(candidate.path)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const uniqueGeneral = [...primaryCandidates, ...extraCandidates]
    .filter((candidate) => {
      const key = `${pointKey(candidate.via)}:${pathKey(candidate.path)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(
      0,
      Math.max(0, MAX_VIA_LINE_CANDIDATES_PER_PAD - uniqueReserved.length),
    )
  return [...uniqueReserved, ...uniqueGeneral].sort(compareCandidates)
}
