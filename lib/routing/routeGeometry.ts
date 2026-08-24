import { distance, EPS, Q } from "../model/geometry"
import type {
  CandidateFanoutRoute,
  FanoutModel,
  FanoutNet,
  LayeredSegment,
  Point,
  RouteViolation,
} from "../model/types"

export type Segment = { a: Point; b: Point }

export const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

export const pointSegmentDistance = (
  point: Point,
  start: Point,
  end: Point,
) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const t =
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
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy)
}

export const segmentDistance = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) => {
  const c1 = cross(firstStart, firstEnd, secondStart)
  const c2 = cross(firstStart, firstEnd, secondEnd)
  const c3 = cross(secondStart, secondEnd, firstStart)
  const c4 = cross(secondStart, secondEnd, firstEnd)
  if (
    ((c1 > EPS && c2 < -EPS) || (c1 < -EPS && c2 > EPS)) &&
    ((c3 > EPS && c4 < -EPS) || (c3 < -EPS && c4 > EPS))
  ) {
    return 0
  }
  return Math.min(
    pointSegmentDistance(firstStart, secondStart, secondEnd),
    pointSegmentDistance(firstEnd, secondStart, secondEnd),
    pointSegmentDistance(secondStart, firstStart, firstEnd),
    pointSegmentDistance(secondEnd, firstStart, firstEnd),
  )
}

export const pathSegments = (path: readonly Point[]): Segment[] =>
  path.slice(1).map((point, index) => ({ a: path[index]!, b: point }))

export const simplifyPath = (path: readonly Point[]): Point[] => {
  const deduplicated: Point[] = []
  for (const point of path) {
    const canonical = { x: Q(point.x), y: Q(point.y) }
    if (
      deduplicated.length === 0 ||
      distance(deduplicated[deduplicated.length - 1]!, canonical) > EPS
    ) {
      deduplicated.push(canonical)
    }
  }
  if (deduplicated.length < 3) return deduplicated
  const result = [deduplicated[0]!]
  for (let index = 1; index < deduplicated.length - 1; index++) {
    if (
      Math.abs(
        cross(
          result[result.length - 1]!,
          deduplicated[index]!,
          deduplicated[index + 1]!,
        ),
      ) > EPS
    ) {
      result.push(deduplicated[index]!)
    }
  }
  result.push(deduplicated[deduplicated.length - 1]!)
  return result
}

export const isOctilinearSegment = (start: Point, end: Point) => {
  const dx = Math.abs(end.x - start.x)
  const dy = Math.abs(end.y - start.y)
  return dx <= EPS || dy <= EPS || Math.abs(dx - dy) <= EPS
}

const templateSignature = (path: readonly Point[]) =>
  path.map((point) => `${Q(point.x)},${Q(point.y)}`).join(";")

/**
 * Deterministic point-to-point templates containing only horizontal, vertical,
 * and 45-degree segments. The optional lanes add bounded three-segment detours
 * without introducing a graph search.
 */
export const getOctilinearTemplates = (
  start: Point,
  end: Point,
  laneYs: readonly number[] = [],
): Point[][] => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy))
  const sx = Math.sign(dx || 1)
  const sy = Math.sign(dy || 1)
  const candidates: Point[][] = []
  if (isOctilinearSegment(start, end)) candidates.push([start, end])
  candidates.push(
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
    [
      start,
      { x: Q(start.x + sx * diagonal), y: Q(start.y + sy * diagonal) },
      end,
    ],
    [start, { x: Q(end.x - sx * diagonal), y: Q(end.y - sy * diagonal) }, end],
  )
  for (const laneY of laneYs) {
    const firstDx = Math.min(
      Math.abs(end.x - start.x),
      Math.abs(laneY - start.y),
    )
    const lastDx = Math.min(Math.abs(end.x - start.x), Math.abs(end.y - laneY))
    candidates.push([
      start,
      {
        x: Q(start.x + sx * firstDx),
        y: Q(start.y + Math.sign(laneY - start.y || 1) * firstDx),
      },
      {
        x: Q(end.x - sx * lastDx),
        y: Q(end.y - Math.sign(end.y - laneY || 1) * lastDx),
      },
      end,
    ])
  }
  const signatures = new Set<string>()
  return candidates
    .map(simplifyPath)
    .filter(
      (path) =>
        path.length >= 2 &&
        pathSegments(path).every((segment) =>
          isOctilinearSegment(segment.a, segment.b),
        ),
    )
    .filter((path) => {
      const signature = templateSignature(path)
      if (signatures.has(signature)) return false
      signatures.add(signature)
      return true
    })
}

export const getPathLength = (path: readonly Point[]) =>
  pathSegments(path).reduce(
    (total, segment) => total + distance(segment.a, segment.b),
    0,
  )

const tracePairCenterDistance = (model: FanoutModel) =>
  model.rules.traceWidth + model.rules.traceClearance

const traceViaCenterDistance = (model: FanoutModel) =>
  model.rules.traceWidth / 2 +
  model.rules.viaDiameter / 2 +
  model.rules.traceToViaClearance

const getOwnPadId = (model: FanoutModel, net: FanoutNet) =>
  model.pads.find((pad) => distance(pad, net.source) <= EPS)?.id

const getSegmentPadClearance = (
  model: FanoutModel,
  segment: Segment,
  ignoredPadId?: string,
) =>
  model.pads.reduce(
    (minimum, pad) =>
      pad.id === ignoredPadId
        ? minimum
        : Math.min(
            minimum,
            pointSegmentDistance(pad, segment.a, segment.b) - pad.radius,
          ),
    Number.POSITIVE_INFINITY,
  )

const pushPathViolations = ({
  model,
  route,
  path,
  layer,
  allRoutes,
  priorSegments,
  violations,
}: {
  model: FanoutModel
  route: CandidateFanoutRoute
  path: readonly Point[]
  layer: string
  allRoutes: readonly CandidateFanoutRoute[]
  priorSegments: readonly LayeredSegment[]
  violations: RouteViolation[]
}) => {
  const ownPadId = layer === "top" ? getOwnPadId(model, route.net) : undefined
  for (const segment of pathSegments(path)) {
    if (!isOctilinearSegment(segment.a, segment.b)) {
      violations.push({
        kind: "non_octilinear",
        connectionNames: [route.net.connectionName],
        layer,
        amount: 1,
        message: `${route.net.connectionName} has a non-octilinear ${layer} segment`,
      })
    }
    for (const point of [segment.a, segment.b]) {
      const outside =
        Math.max(0, model.routingBounds.minX - point.x) +
        Math.max(0, point.x - model.routingBounds.maxX) +
        Math.max(0, model.routingBounds.minY - point.y) +
        Math.max(0, point.y - model.routingBounds.maxY)
      if (outside > EPS) {
        violations.push({
          kind: "bounds",
          connectionNames: [route.net.connectionName],
          layer,
          amount: outside,
          message: `${route.net.connectionName} leaves the routing bounds on ${layer}`,
        })
      }
    }
    if (layer === "top") {
      const clearance = getSegmentPadClearance(model, segment, ownPadId)
      const required =
        model.rules.traceWidth / 2 + model.rules.traceToPadClearance
      if (clearance + EPS < required) {
        violations.push({
          kind: "trace_to_pad",
          connectionNames: [route.net.connectionName],
          layer,
          amount: required - clearance,
          message: `${route.net.connectionName} violates top trace-to-pad clearance`,
        })
      }
    }
    for (const previous of priorSegments) {
      if (previous.layer !== layer) continue
      const clearance = segmentDistance(
        segment.a,
        segment.b,
        previous.a,
        previous.b,
      )
      const required = tracePairCenterDistance(model)
      if (clearance + EPS < required) {
        violations.push({
          kind: "trace_to_trace",
          connectionNames: [
            route.net.connectionName,
            previous.connectionName ?? "previous-trace",
          ],
          layer,
          amount: required - clearance,
          message: `${route.net.connectionName} violates a previous ${layer} trace`,
        })
      }
    }
    for (const other of allRoutes) {
      if (other.net.connectionName === route.net.connectionName) continue
      const otherPath = layer === "top" ? other.topPath : other.innerPath
      if (layer !== "top" && other.net.selectedLayer !== layer) continue
      for (const otherSegment of pathSegments(otherPath)) {
        const clearance = segmentDistance(
          segment.a,
          segment.b,
          otherSegment.a,
          otherSegment.b,
        )
        const required = tracePairCenterDistance(model)
        if (clearance + EPS < required) {
          violations.push({
            kind: "trace_to_trace",
            connectionNames: [
              route.net.connectionName,
              other.net.connectionName,
            ],
            layer,
            amount: required - clearance,
            message: `${route.net.connectionName} crosses or crowds ${other.net.connectionName} on ${layer}`,
          })
        }
      }
      const viaClearance = pointSegmentDistance(other.via, segment.a, segment.b)
      const requiredViaClearance = traceViaCenterDistance(model)
      if (viaClearance + EPS < requiredViaClearance) {
        violations.push({
          kind: "trace_to_via",
          connectionNames: [route.net.connectionName, other.net.connectionName],
          layer,
          amount: requiredViaClearance - viaClearance,
          message: `${route.net.connectionName} crowds ${other.net.connectionName}'s via on ${layer}`,
        })
      }
    }
  }
}

export const collectRouteViolations = (
  model: FanoutModel,
  routes: readonly CandidateFanoutRoute[],
): RouteViolation[] => {
  const violations: RouteViolation[] = []
  for (const route of routes) {
    if (
      distance(route.topPath[0] ?? route.via, route.net.source) > EPS ||
      distance(route.topPath.at(-1) ?? route.net.source, route.via) > EPS ||
      distance(route.innerPath[0] ?? route.net.target, route.via) > EPS ||
      distance(route.innerPath.at(-1) ?? route.via, route.net.target) > EPS
    ) {
      violations.push({
        kind: "endpoint",
        connectionNames: [route.net.connectionName],
        layer: route.net.selectedLayer,
        amount: 1,
        message: `${route.net.connectionName} is not connected to its exact endpoints`,
      })
    }
    pushPathViolations({
      model,
      route,
      path: route.topPath,
      layer: "top",
      allRoutes: routes,
      priorSegments: model.previousSegments,
      violations,
    })
    pushPathViolations({
      model,
      route,
      path: route.innerPath,
      layer: route.net.selectedLayer,
      allRoutes: routes,
      priorSegments: model.previousSegments,
      violations,
    })
  }
  for (let firstIndex = 0; firstIndex < routes.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < routes.length;
      secondIndex++
    ) {
      const first = routes[firstIndex]!
      const second = routes[secondIndex]!
      const clearance = distance(first.via, second.via)
      if (clearance + EPS < model.rules.viaToViaCenter) {
        violations.push({
          kind: "via_to_via",
          connectionNames: [
            first.net.connectionName,
            second.net.connectionName,
          ],
          layer: "all",
          amount: model.rules.viaToViaCenter - clearance,
          message: `${first.net.connectionName} and ${second.net.connectionName} violate via spacing`,
        })
      }
    }
  }
  const signatures = new Set<string>()
  return violations.filter((violation) => {
    const signature = `${violation.kind}:${[...violation.connectionNames].sort().join("/")}:${violation.layer}:${Q(violation.amount)}`
    if (signatures.has(signature)) return false
    signatures.add(signature)
    return true
  })
}

export const scoreViolations = (violations: readonly RouteViolation[]) => ({
  count: violations.length,
  severity: violations.reduce(
    (total, violation) => total + violation.amount * violation.amount,
    0,
  ),
})

export const isBetterViolationScore = (
  candidate: readonly RouteViolation[],
  current: readonly RouteViolation[],
) => {
  const candidateScore = scoreViolations(candidate)
  const currentScore = scoreViolations(current)
  return (
    candidateScore.count < currentScore.count ||
    (candidateScore.count === currentScore.count &&
      candidateScore.severity + EPS < currentScore.severity)
  )
}
