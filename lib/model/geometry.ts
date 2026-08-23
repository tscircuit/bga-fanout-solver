import type { SimpleRouteJson } from "@tscircuit/core"
import type { FanoutNet, FanoutRules, Point } from "./types"

export const EPS = 1e-6
export const Q = (value: number) => Math.round(value * 1e6) / 1e6

export const distance = (first: Point, second: Point) =>
  Math.hypot(first.x - second.x, first.y - second.y)

export const gridKey = (row: number, column: number) => `${row},${column}`

export const compareCanonicalNetOrder = (first: FanoutNet, second: FanoutNet) =>
  first.busRank - second.busRank ||
  first.selectedLayer.localeCompare(second.selectedLayer) ||
  first.source.x - second.source.x ||
  first.source.y - second.source.y ||
  first.target.x - second.target.x ||
  first.target.y - second.target.y

const uniqueSorted = (values: number[]) =>
  [...new Set(values.map(Q))].sort((first, second) => first - second)

export const inferPitch = (values: number[], axis: "x" | "y") => {
  const unique = uniqueSorted(values)
  const differences = unique
    .slice(1)
    .map((value, index) => Q(value - unique[index]!))
    .filter((value) => value > 1e-4)
  if (differences.length === 0) {
    throw new Error(
      `[build_pad_topology/all] cannot derive ${axis}-axis pad pitch`,
    )
  }
  return Math.min(...differences)
}

export const toCanonical = (axisSign: 1 | -1, point: Point): Point => ({
  x: Q(axisSign * point.x),
  y: Q(point.y),
})

export const fromCanonical = (axisSign: 1 | -1, point: Point): Point => ({
  x: Q(axisSign * point.x),
  y: Q(point.y),
})

export const getRules = (input: SimpleRouteJson): FanoutRules => {
  const traceWidth = input.nominalTraceWidth ?? input.minTraceWidth
  const viaDiameter =
    input.min_via_pad_diameter ??
    input.minViaPadDiameter ??
    input.minViaDiameter ??
    0.3
  const viaHoleDiameter =
    input.min_via_hole_diameter ?? input.minViaHoleDiameter ?? viaDiameter / 2
  const traceToPadClearance = input.minTraceToPadEdgeClearance ?? 0
  const viaToPadClearance = input.minViaEdgeToPadEdgeClearance ?? 0
  const traceClearance = input.defaultObstacleMargin ?? traceToPadClearance
  const traceToViaClearance = Math.max(traceClearance, traceToPadClearance)
  const viaToViaCenter = Math.max(
    viaDiameter + traceClearance,
    viaHoleDiameter + (input.minViaHoleEdgeToViaHoleEdgeClearance ?? 0),
  )
  return {
    traceWidth,
    traceClearance,
    traceToPadClearance,
    traceToViaClearance,
    viaDiameter,
    viaHoleDiameter,
    viaToPadClearance,
    viaToViaCenter,
  }
}

export const getPointObstacle = (
  input: SimpleRouteJson,
  point: SimpleRouteJson["connections"][number]["pointsToConnect"][number],
) => {
  const containingObstacle = input.obstacles.find(
    (obstacle) =>
      Boolean(obstacle.componentId) &&
      obstacle.layers.includes(point.layer) &&
      Math.abs(point.x - obstacle.center.x) <= obstacle.width / 2 + EPS &&
      Math.abs(point.y - obstacle.center.y) <= obstacle.height / 2 + EPS,
  )
  if (containingObstacle) return containingObstacle
  return input.obstacles.find(
    (obstacle) =>
      Boolean(obstacle.componentId) &&
      obstacle.layers.includes(point.layer) &&
      ((point.pointId && obstacle.connectedTo.includes(point.pointId)) ||
        (point.pcb_port_id &&
          obstacle.connectedTo.includes(point.pcb_port_id))),
  )
}
