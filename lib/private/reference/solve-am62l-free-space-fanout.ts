import type {
  AutorouterProgressEvent,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/core"

// Private extraction oracle. Keep this file behaviorally identical to the
// validated in-circuit solver until every search phase has an incremental
// replacement with exact parity. It is deliberately not exported publicly.
import { AM62L_FREE_SPACE_FANOUT_PHASES } from "./am62l-free-space-fanout"
import type { InProcessAutorouterResult } from "./create-in-process-autorouter"
import { squaredDistance } from "./squared-distance"
import type {
  FanoutModel,
  PowerPlanePlan,
  PowerSignalCoRoutingSummary,
  TargetSpacingAdaptationSummary,
  RankedFanoutModel,
} from "../../model/types"
import { generateBoundedSignalViaRelocationSites } from "../../model/signalViaRelocationCandidates"

type Point = { x: number; y: number }
type Segment = { a: Point; b: Point }
type LayeredSegment = Segment & { layer: string; connectionName?: string }
type LayeredVia = Point & { fromLayer: string; toLayer: string }

type Pad = Point & {
  id: string
  radius: number
  row: number
  column: number
}

type Rules = {
  traceWidth: number
  traceClearance: number
  traceToPadClearance: number
  traceToViaClearance: number
  viaDiameter: number
  viaHoleDiameter: number
  viaToPadClearance: number
  viaToViaCenter: number
}

type FreeCell = Point & {
  row: number
  column: number
  clearance: number
  regionId?: string
}

type FanoutNet = {
  connection: SimpleRouteJson["connections"][number]
  connectionName: string
  source: Point & { layer: string; pointId?: string; pcb_port_id?: string }
  target: Point & { layer: string; pointId?: string; pcb_port_id?: string }
  selectedLayer: string
  busId: string
  sourceTraceId?: string
  busRank: number
  rank: number
}

type RoutedNet = FanoutNet & {
  topPath: Point[]
  via: Point
  innerPath: Point[]
  kind: "early" | "residual"
  regionId?: string
  viaLineId?: string
  residualPriorityNames?: string[]
}

type GeometryModel = {
  input: SimpleRouteJson
  rules: Rules
  nets: FanoutNet[]
  pads: Pad[]
  componentId: string
  axisSign: 1 | -1
  pitchX: number
  pitchY: number
  padBounds: { minX: number; maxX: number; minY: number; maxY: number }
  routingBounds: { minX: number; maxX: number; minY: number; maxY: number }
  freeCells: FreeCell[]
  freeRegions: FreeCell[][]
  previousSegments: LayeredSegment[]
  previousVias: LayeredVia[]
  earlyRouteCandidates: RoutedNet[][]
  routes: RoutedNet[]
  routeHints: Map<string, ReferenceRouteSnapshot>
  selectiveViaLineBlockingSignals: Set<string>
  powerPlanePlan?: PowerPlanePlan
  targetSpacingAdaptation?: TargetSpacingAdaptationSummary
}

const EPS = 1e-6
const Q = (value: number) => Math.round(value * 1e6) / 1e6
const compareCanonicalNetOrder = (first: FanoutNet, second: FanoutNet) =>
  first.busRank - second.busRank ||
  first.selectedLayer.localeCompare(second.selectedLayer) ||
  first.source.x - second.source.x ||
  first.source.y - second.source.y ||
  first.target.x - second.target.x ||
  first.target.y - second.target.y
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const pointKey = (point: Point) => `${Q(point.x)},${Q(point.y)}`
const gridKey = (row: number, column: number) => `${row},${column}`
const getLayerIndex = (layer: string, layerCount: number) => {
  if (layer === "top") return 0
  if (layer === "bottom") return layerCount - 1
  const match = /^inner(\d+)$/.exec(layer)
  return match ? Number(match[1]) : undefined
}
const viaTouchesLayer = (
  via: { fromLayer: string; toLayer: string },
  layer: string,
  layerCount: number,
) => {
  const fromIndex = getLayerIndex(via.fromLayer, layerCount)
  const toIndex = getLayerIndex(via.toLayer, layerCount)
  const layerIndex = getLayerIndex(layer, layerCount)
  if (
    fromIndex === undefined ||
    toIndex === undefined ||
    layerIndex === undefined
  ) {
    return true
  }
  return (
    layerIndex >= Math.min(fromIndex, toIndex) &&
    layerIndex <= Math.max(fromIndex, toIndex)
  )
}
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

const pointSegmentDistance = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared < EPS
      ? 0
      : clamp(
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
          0,
          1,
        )
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy)
}

const segmentDistance = (a: Point, b: Point, c: Point, d: Point) => {
  const c1 = cross(a, b, c)
  const c2 = cross(a, b, d)
  const c3 = cross(c, d, a)
  const c4 = cross(c, d, b)
  if (
    ((c1 > EPS && c2 < -EPS) || (c1 < -EPS && c2 > EPS)) &&
    ((c3 > EPS && c4 < -EPS) || (c3 < -EPS && c4 > EPS))
  ) {
    return 0
  }
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  )
}

const pathSegments = (path: readonly Point[]): Segment[] =>
  path.slice(1).map((point, index) => ({ a: path[index]!, b: point }))

const simplifyPath = (points: readonly Point[]): Point[] => {
  const deduplicated: Point[] = []
  for (const point of points) {
    if (
      deduplicated.length === 0 ||
      distance(deduplicated[deduplicated.length - 1]!, point) > EPS
    ) {
      deduplicated.push({ x: Q(point.x), y: Q(point.y) })
    }
  }
  if (deduplicated.length < 3) return deduplicated
  const simplified: Point[] = [deduplicated[0]!]
  for (let index = 1; index < deduplicated.length - 1; index++) {
    if (
      Math.abs(
        cross(
          simplified[simplified.length - 1]!,
          deduplicated[index]!,
          deduplicated[index + 1]!,
        ),
      ) > EPS
    ) {
      simplified.push(deduplicated[index]!)
    }
  }
  simplified.push(deduplicated[deduplicated.length - 1]!)
  return simplified
}

const isRightAngleTurn = (previous: Point, corner: Point, next: Point) => {
  const incoming = {
    x: corner.x - previous.x,
    y: corner.y - previous.y,
  }
  const outgoing = { x: next.x - corner.x, y: next.y - corner.y }
  const incomingLength = Math.hypot(incoming.x, incoming.y)
  const outgoingLength = Math.hypot(outgoing.x, outgoing.y)
  if (incomingLength <= EPS || outgoingLength <= EPS) return false
  return (
    Math.abs(incoming.x * outgoing.x + incoming.y * outgoing.y) <=
    EPS * incomingLength * outgoingLength
  )
}

const miterRightAngleTurns = (
  path: readonly Point[],
  rules: Rules,
  replacementAllowed: (start: Point, end: Point) => boolean = () => true,
): Point[] => {
  if (path.length < 3) return path.map((point) => ({ ...point }))
  const result: Point[] = [{ ...path[0]! }]
  const preferredOffset = rules.traceWidth + rules.traceClearance
  for (let index = 1; index < path.length - 1; index++) {
    const previous = path[index - 1]!
    const corner = path[index]!
    const next = path[index + 1]!
    if (!isRightAngleTurn(previous, corner, next)) {
      result.push({ ...corner })
      continue
    }
    const incomingLength = distance(previous, corner)
    const outgoingLength = distance(corner, next)
    const previousIsCorner =
      index > 1 && isRightAngleTurn(path[index - 2]!, previous, corner)
    const nextIsCorner =
      index + 2 < path.length &&
      isRightAngleTurn(corner, next, path[index + 2]!)
    const maximumOffset = Math.min(
      incomingLength * (previousIsCorner ? 0.49 : 1),
      outgoingLength * (nextIsCorner ? 0.49 : 1),
    )
    const candidateOffsets = uniqueSorted(
      [
        Math.min(preferredOffset, maximumOffset),
        Math.min(preferredOffset * 0.875, maximumOffset),
        Math.min(preferredOffset * 0.75, maximumOffset),
        Math.min(preferredOffset * 0.625, maximumOffset),
        Math.min(preferredOffset * 0.5, maximumOffset),
        maximumOffset,
        maximumOffset * 0.875,
        maximumOffset * 0.75,
        maximumOffset * 0.625,
        maximumOffset * 0.5,
        maximumOffset * 0.375,
        maximumOffset * 0.25,
        maximumOffset * 0.125,
        maximumOffset * 0.0625,
        maximumOffset * 0.03125,
        maximumOffset * 0.015625,
        maximumOffset * 0.0078125,
        maximumOffset * 0.00390625,
        maximumOffset * 0.001953125,
        maximumOffset * 0.0009765625,
        maximumOffset * 0.00048828125,
        maximumOffset * 0.000244140625,
      ].filter((offset) => offset > EPS),
    ).sort(
      (first, second) =>
        Math.abs(first - preferredOffset) -
          Math.abs(second - preferredOffset) || second - first,
    )
    let replacement: { before: Point; after: Point } | undefined
    for (const offset of candidateOffsets) {
      const before = {
        x: Q(corner.x - ((corner.x - previous.x) / incomingLength) * offset),
        y: Q(corner.y - ((corner.y - previous.y) / incomingLength) * offset),
      }
      const after = {
        x: Q(corner.x + ((next.x - corner.x) / outgoingLength) * offset),
        y: Q(corner.y + ((next.y - corner.y) / outgoingLength) * offset),
      }
      if (!replacementAllowed(before, after)) continue
      replacement = { before, after }
      break
    }
    if (!replacement) {
      result.push({ ...corner })
      continue
    }
    result.push(replacement.before, replacement.after)
  }
  result.push({ ...path[path.length - 1]! })
  const compact: Point[] = []
  for (const point of result) {
    if (
      compact.length === 0 ||
      distance(compact[compact.length - 1]!, point) > EPS
    ) {
      compact.push(point)
    }
  }
  if (compact.length < 3) return compact
  const collinear: Point[] = [compact[0]!]
  for (let index = 1; index < compact.length - 1; index++) {
    const previous = collinear[collinear.length - 1]!
    const point = compact[index]!
    const next = compact[index + 1]!
    const incomingLength = distance(previous, point)
    const outgoingLength = distance(point, next)
    const dot =
      (point.x - previous.x) * (next.x - point.x) +
      (point.y - previous.y) * (next.y - point.y)
    if (
      dot > 0 &&
      Math.abs(cross(previous, point, next)) <=
        EPS * incomingLength * outgoingLength
    ) {
      continue
    }
    collinear.push(point)
  }
  collinear.push(compact[compact.length - 1]!)
  return collinear
}

const isOctilinear = (a: Point, b: Point) => {
  const dx = Math.abs(a.x - b.x)
  const dy = Math.abs(a.y - b.y)
  return dx <= EPS || dy <= EPS || Math.abs(dx - dy) <= EPS
}

const octilinearCandidates = (start: Point, end: Point): Point[][] => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (
    Math.abs(dx) <= EPS ||
    Math.abs(dy) <= EPS ||
    Math.abs(Math.abs(dx) - Math.abs(dy)) <= EPS
  ) {
    return [[{ ...start }, { ...end }]]
  }
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy))
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  return [
    [
      { ...start },
      { x: Q(start.x + sx * diagonal), y: Q(start.y + sy * diagonal) },
      { ...end },
    ],
    [
      { ...start },
      { x: Q(end.x - sx * diagonal), y: Q(end.y - sy * diagonal) },
      { ...end },
    ],
    [{ ...start }, { x: end.x, y: start.y }, { ...end }],
    [{ ...start }, { x: start.x, y: end.y }, { ...end }],
  ].map(simplifyPath)
}

class MinHeap<T extends { score: number }> {
  private items: T[] = []
  get length() {
    return this.items.length
  }
  push(item: T) {
    let index = this.items.push(item) - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.items[parent]!.score <= item.score) break
      this.items[index] = this.items[parent]!
      index = parent
    }
    this.items[index] = item
  }
  snapshot(limit = 128): T[] {
    return this.items.slice(0, limit)
  }
  pop(): T | undefined {
    const first = this.items[0]
    const last = this.items.pop()
    if (!first || !last || this.items.length === 0) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      if (left >= this.items.length) break
      const child =
        right < this.items.length &&
        this.items[right]!.score < this.items[left]!.score
          ? right
          : left
      if (this.items[child]!.score >= last.score) break
      this.items[index] = this.items[child]!
      index = child
    }
    this.items[index] = last
    return first
  }
}

const phaseError = (
  phase: (typeof AM62L_FREE_SPACE_FANOUT_PHASES)[number],
  connectionName: string,
  constraint: string,
) => new Error(`[${phase}] ${connectionName}: ${constraint}`)

const reportPhase = (
  reportProgress: (event: AutorouterProgressEvent) => void,
  phaseIndex: number,
) => {
  reportProgress({
    type: "progress",
    phase: AM62L_FREE_SPACE_FANOUT_PHASES[phaseIndex]!,
    steps: phaseIndex + 1,
    progress: (phaseIndex + 1) / AM62L_FREE_SPACE_FANOUT_PHASES.length,
  })
}

type SearchClock = { now: () => number }
const wallClock: SearchClock = { now: () => Date.now() }

class ActiveComputeClock implements SearchClock {
  private elapsedMs = 0
  private stepStartedAt: number | null = null

  beginStep() {
    this.stepStartedAt = performance.now()
  }

  endStep() {
    if (this.stepStartedAt === null) return
    this.elapsedMs += performance.now() - this.stepStartedAt
    this.stepStartedAt = null
  }

  now() {
    return (
      this.elapsedMs +
      (this.stepStartedAt === null ? 0 : performance.now() - this.stepStartedAt)
    )
  }
}

export type ReferenceSearchStep = {
  action: string
  status: "candidate" | "accepted" | "rejected" | "completed"
  connectionName?: string
  candidateId?: string
  reason?: string
  processed?: number
  total?: number
  point?: Point
  expandedPoint?: Point
  searchStart?: Point
  searchTarget?: Point
  candidatePath?: Point[]
  layer?: string
  route?: ReferenceRouteSnapshot
  frontierPoints?: Point[]
  visitedPoints?: Point[]
  frontierSize?: number
  visitedCount?: number
}

const uniqueSorted = (values: readonly number[]) =>
  [...new Set(values.map(Q))].sort((a, b) => a - b)

const inferPitch = (values: readonly number[], axis: string) => {
  const unique = uniqueSorted(values)
  const differences = unique
    .slice(1)
    .map((value, index) => Q(value - unique[index]!))
    .filter((value) => value > 1e-4)
  if (differences.length === 0) {
    throw phaseError(
      "build_pad_topology",
      "all",
      `cannot derive ${axis}-axis pad pitch`,
    )
  }
  return Math.min(...differences)
}

const toCanonical = (axisSign: 1 | -1, point: Point): Point => ({
  x: Q(axisSign * point.x),
  y: Q(point.y),
})

const fromCanonical = (axisSign: 1 | -1, point: Point): Point => ({
  x: Q(axisSign * point.x),
  y: Q(point.y),
})

const getRules = (input: SimpleRouteJson): Rules => {
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
  // A via annulus is copper-pad geometry for trace clearance. The SRJ's
  // minViaEdgeToPadEdgeClearance applies specifically to via-vs-pad, while a
  // trace approaching another net's via uses trace-to-pad clearance.
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

const getPointObstacle = (
  input: SimpleRouteJson,
  point: SimpleRouteJson["connections"][number]["pointsToConnect"][number],
) => {
  // Connectivity IDs are expanded across the whole net, so an obstacle on the
  // opposite BGA can contain this point's pcb_port_id. Prefer the obstacle that
  // physically contains the point and only use connectivity as a fallback.
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

const buildModel = (input: SimpleRouteJson): GeometryModel => {
  if (input.connections.length === 0) {
    return {
      input,
      rules: getRules(input),
      nets: [],
      pads: [],
      componentId: "empty",
      axisSign: 1,
      pitchX: 1,
      pitchY: 1,
      padBounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      routingBounds: { ...input.bounds },
      freeCells: [],
      freeRegions: [],
      previousSegments: [],
      previousVias: [],
      earlyRouteCandidates: [],
      routes: [],
      routeHints: new Map(),
      selectiveViaLineBlockingSignals: new Set(),
    }
  }

  const sourceComponents = new Map<string, number>()
  for (const connection of input.connections) {
    for (const point of connection.pointsToConnect) {
      const componentId = getPointObstacle(input, point)?.componentId
      if (componentId) {
        sourceComponents.set(
          componentId,
          (sourceComponents.get(componentId) ?? 0) + 1,
        )
      }
    }
  }
  const componentId = [...sourceComponents].sort(
    ([firstId, firstCount], [secondId, secondCount]) =>
      secondCount - firstCount || firstId.localeCompare(secondId),
  )[0]?.[0]
  if (!componentId) {
    throw phaseError(
      "build_pad_topology",
      "all",
      "no source BGA component can be identified from connection point IDs",
    )
  }

  const sourceAndTarget = input.connections.map((connection) => {
    if (connection.pointsToConnect.length !== 2) {
      throw phaseError(
        "build_pad_topology",
        connection.name,
        `expected exactly two connection points, got ${connection.pointsToConnect.length}`,
      )
    }
    const sourceIndex = connection.pointsToConnect.findIndex(
      (point) => getPointObstacle(input, point)?.componentId === componentId,
    )
    if (sourceIndex < 0) {
      throw phaseError(
        "build_pad_topology",
        connection.name,
        "cannot identify the BGA source point",
      )
    }
    const targetIndex = sourceIndex === 0 ? 1 : 0
    return {
      connection,
      source: connection.pointsToConnect[sourceIndex]!,
      target: connection.pointsToConnect[targetIndex]!,
    }
  })

  const averageSourceX =
    sourceAndTarget.reduce((sum, item) => sum + item.source.x, 0) /
    sourceAndTarget.length
  const averageTargetX =
    sourceAndTarget.reduce((sum, item) => sum + item.target.x, 0) /
    sourceAndTarget.length
  const axisSign: 1 | -1 = averageTargetX >= averageSourceX ? 1 : -1
  const rules = getRules(input)

  const componentObstacles = input.obstacles.filter(
    (obstacle) =>
      obstacle.componentId === componentId && obstacle.layers.includes("top"),
  )
  if (componentObstacles.length < sourceAndTarget.length) {
    throw phaseError(
      "build_pad_topology",
      "all",
      `identified only ${componentObstacles.length} top-layer pads for ${sourceAndTarget.length} sources`,
    )
  }
  const canonicalObstacleCenters = componentObstacles.map((obstacle) => ({
    obstacle,
    ...toCanonical(axisSign, obstacle.center),
  }))
  const pitchX = inferPitch(
    canonicalObstacleCenters.map((pad) => pad.x),
    "x",
  )
  const pitchY = inferPitch(
    canonicalObstacleCenters.map((pad) => pad.y),
    "y",
  )
  const minPadX = Math.min(...canonicalObstacleCenters.map((pad) => pad.x))
  const maxPadX = Math.max(...canonicalObstacleCenters.map((pad) => pad.x))
  const minPadY = Math.min(...canonicalObstacleCenters.map((pad) => pad.y))
  const maxPadY = Math.max(...canonicalObstacleCenters.map((pad) => pad.y))
  const pads: Pad[] = canonicalObstacleCenters.map(
    ({ obstacle, x, y }, index) => ({
      id:
        obstacle.circuitJsonMetadata?.pcb_smtpad_id ??
        obstacle.obstacleId ??
        `pad-${index}`,
      x,
      y,
      radius: Math.max(obstacle.width, obstacle.height) / 2,
      column: Math.round((x - minPadX) / pitchX),
      row: Math.round((y - minPadY) / pitchY),
    }),
  )

  const busByConnectionName = new Map<
    string,
    NonNullable<SimpleRouteJson["buses"]>[number]
  >()
  for (const bus of input.buses ?? []) {
    for (const connectionName of bus.connectionNames) {
      if (busByConnectionName.has(connectionName)) {
        throw phaseError(
          "build_pad_topology",
          connectionName,
          "connection belongs to more than one fanout bus",
        )
      }
      busByConnectionName.set(connectionName, bus)
    }
  }
  const nets: FanoutNet[] = sourceAndTarget.map(
    ({ connection, source, target }, rank) => {
      const bus = busByConnectionName.get(connection.name)
      const selectedLayer =
        bus?.termination?.type === "plane"
          ? bus.termination.layer
          : target.layer !== "top"
            ? target.layer
            : (bus?.preferredLayer ?? bus?.preferredLayers?.[0] ?? target.layer)
      if (!selectedLayer) {
        throw phaseError(
          "build_pad_topology",
          connection.name,
          "no prescribed fanout layer is present in the SRJ",
        )
      }
      return {
        connection,
        connectionName: connection.name,
        source: { ...toCanonical(axisSign, source), ...source },
        target: { ...toCanonical(axisSign, target), ...target },
        selectedLayer,
        busId: bus?.busId ?? `ungrouped:${connection.name}`,
        sourceTraceId: connection.source_trace_id,
        busRank: bus?.connectionNames.indexOf(connection.name) ?? rank,
        rank,
      }
    },
  )
  // Object spread above deliberately preserves point metadata but would also
  // overwrite canonical x/y. Restore canonical coordinates explicitly.
  for (let index = 0; index < nets.length; index++) {
    nets[index]!.source.x = toCanonical(
      axisSign,
      sourceAndTarget[index]!.source,
    ).x
    nets[index]!.source.y = toCanonical(
      axisSign,
      sourceAndTarget[index]!.source,
    ).y
    nets[index]!.target.x = toCanonical(
      axisSign,
      sourceAndTarget[index]!.target,
    ).x
    nets[index]!.target.y = toCanonical(
      axisSign,
      sourceAndTarget[index]!.target,
    ).y
  }
  nets.sort(compareCanonicalNetOrder)

  const canonicalBounds = [
    toCanonical(axisSign, { x: input.bounds.minX, y: input.bounds.minY }),
    toCanonical(axisSign, { x: input.bounds.maxX, y: input.bounds.maxY }),
  ]
  const previousSegments: LayeredSegment[] = []
  const previousVias: LayeredVia[] = []
  for (const trace of input.traces ?? []) {
    let priorWire:
      | { route_type: "wire"; x: number; y: number; layer: string }
      | undefined
    for (const routePoint of trace.route) {
      if (routePoint.route_type === "wire") {
        if (priorWire && priorWire.layer === routePoint.layer) {
          previousSegments.push({
            a: toCanonical(axisSign, priorWire),
            b: toCanonical(axisSign, routePoint),
            layer: routePoint.layer,
            connectionName: trace.connection_name,
          })
        }
        priorWire = routePoint
      } else if (routePoint.route_type === "via") {
        previousVias.push({
          ...toCanonical(axisSign, routePoint),
          fromLayer: routePoint.from_layer,
          toLayer: routePoint.to_layer,
        })
        priorWire = undefined
      } else {
        priorWire = undefined
      }
    }
  }

  return {
    input,
    rules,
    nets,
    pads,
    componentId,
    axisSign,
    pitchX,
    pitchY,
    padBounds: {
      minX: Q(minPadX - pitchX / 2),
      maxX: Q(maxPadX + pitchX / 2),
      minY: Q(minPadY - pitchY / 2),
      maxY: Q(maxPadY + pitchY / 2),
    },
    routingBounds: {
      minX: Math.min(...canonicalBounds.map((point) => point.x)),
      maxX: Math.max(...canonicalBounds.map((point) => point.x)),
      minY: input.bounds.minY,
      maxY: input.bounds.maxY,
    },
    freeCells: [],
    freeRegions: [],
    previousSegments,
    previousVias,
    earlyRouteCandidates: [],
    routes: [],
    routeHints: new Map(),
    selectiveViaLineBlockingSignals: new Set(),
  }
}

const padEdgeDistance = (model: GeometryModel, point: Point) =>
  model.pads.reduce(
    (minimum, pad) => Math.min(minimum, distance(point, pad) - pad.radius),
    Number.POSITIVE_INFINITY,
  )

const segmentPadEdgeDistance = (
  model: GeometryModel,
  start: Point,
  end: Point,
  ignoredPadId?: string,
) =>
  model.pads.reduce(
    (minimum, pad) =>
      pad.id === ignoredPadId
        ? minimum
        : Math.min(minimum, pointSegmentDistance(pad, start, end) - pad.radius),
    Number.POSITIVE_INFINITY,
  )

const getOwnPad = (model: GeometryModel, net: FanoutNet) =>
  model.pads.find((pad) => distance(pad, net.source) <= EPS)

const buildFreeSpace = (model: GeometryModel) => {
  if (model.nets.length === 0) return
  // Sample both missing lattice sites and interstitial sites. The reference
  // uses missing lattice cells; every sampled site is checked using the exact
  // SRJ via diameter and clearance, including rectangular pad arrays.
  const samplePitchX = model.pitchX / 2
  const samplePitchY = model.pitchY / 2
  const rowCount =
    Math.round(
      (model.padBounds.maxY - model.padBounds.minY - model.pitchY) /
        samplePitchY,
    ) + 1
  const columnCount =
    Math.round(
      (model.padBounds.maxX - model.padBounds.minX - model.pitchX) /
        samplePitchX,
    ) + 1
  const legalByGrid = new Map<string, FreeCell>()
  const requiredPadEdge =
    model.rules.viaDiameter / 2 + model.rules.viaToPadClearance
  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const cell: FreeCell = {
        x: Q(model.padBounds.minX + model.pitchX / 2 + column * samplePitchX),
        y: Q(model.padBounds.minY + model.pitchY / 2 + row * samplePitchY),
        row,
        column,
        clearance: 0,
      }
      cell.clearance =
        padEdgeDistance(model, cell) - model.rules.viaDiameter / 2
      if (cell.clearance + EPS >= model.rules.viaToPadClearance) {
        legalByGrid.set(gridKey(row, column), cell)
      }
    }
  }

  const visited = new Set<string>()
  const qualifyingRegions: FreeCell[][] = []
  for (const seed of legalByGrid.values()) {
    const seedKey = gridKey(seed.row, seed.column)
    if (visited.has(seedKey)) continue
    visited.add(seedKey)
    const queue = [seed]
    const cells: FreeCell[] = []
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head]!
      cells.push(cell)
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const key = gridKey(cell.row + dr, cell.column + dc)
        const next = legalByGrid.get(key)
        if (!next || visited.has(key)) continue
        visited.add(key)
        queue.push(next)
      }
    }
    const packed: FreeCell[] = []
    for (const cell of [...cells].sort(
      (first, second) =>
        second.clearance - first.clearance ||
        first.row - second.row ||
        first.column - second.column,
    )) {
      if (
        packed.every(
          (other) => distance(cell, other) + EPS >= model.rules.viaToViaCenter,
        )
      ) {
        packed.push(cell)
      }
    }
    if (packed.length >= 2) {
      const regionId = `free-region-${qualifyingRegions.length}`
      for (const cell of cells) cell.regionId = regionId
      qualifyingRegions.push(cells)
    }
  }
  model.freeRegions = qualifyingRegions
  model.freeCells = qualifyingRegions.flat()
  if (model.freeRegions.length === 0) {
    throw phaseError(
      "find_two_via_free_space",
      "all",
      `no connected free-space region can hold two vias (required pad-edge distance ${requiredPadEdge.toFixed(4)} mm)`,
    )
  }
}

const tracePairCenterDistance = (rules: Rules) =>
  rules.traceWidth + rules.traceClearance
const traceViaCenterDistance = (rules: Rules) =>
  rules.traceWidth / 2 + rules.viaDiameter / 2 + rules.traceToViaClearance

const topPathIsLegal = (
  model: GeometryModel,
  net: FanoutNet,
  path: readonly Point[],
  via: Point,
  accepted: readonly RoutedNet[],
) => {
  const ownPad = getOwnPad(model, net)
  if (!ownPad) return false
  if (
    padEdgeDistance(model, via) + EPS <
    model.rules.viaDiameter / 2 + model.rules.viaToPadClearance
  ) {
    return false
  }
  const otherVias = [
    ...model.previousVias,
    ...accepted.map((route) => route.via),
  ]
  if (
    otherVias.some(
      (other) => distance(via, other) + EPS < model.rules.viaToViaCenter,
    )
  ) {
    return false
  }
  const segments = pathSegments(path)
  for (const segment of segments) {
    if (!isOctilinear(segment.a, segment.b)) return false
    if (
      segmentPadEdgeDistance(model, segment.a, segment.b, ownPad.id) + EPS <
      model.rules.traceWidth / 2 + model.rules.traceToPadClearance
    ) {
      return false
    }
    for (const otherVia of otherVias) {
      if (
        pointSegmentDistance(otherVia, segment.a, segment.b) + EPS <
        traceViaCenterDistance(model.rules)
      ) {
        return false
      }
    }
    for (const previous of model.previousSegments) {
      if (previous.layer !== "top") continue
      if (
        segmentDistance(segment.a, segment.b, previous.a, previous.b) + EPS <
        tracePairCenterDistance(model.rules)
      ) {
        return false
      }
    }
    for (const route of accepted) {
      for (const other of pathSegments(route.topPath)) {
        if (
          segmentDistance(segment.a, segment.b, other.a, other.b) + EPS <
          tracePairCenterDistance(model.rules)
        ) {
          return false
        }
      }
      if (
        pointSegmentDistance(route.via, segment.a, segment.b) + EPS <
        traceViaCenterDistance(model.rules)
      ) {
        return false
      }
    }
  }
  for (const route of accepted) {
    for (const segment of pathSegments(route.topPath)) {
      if (
        pointSegmentDistance(via, segment.a, segment.b) + EPS <
        traceViaCenterDistance(model.rules)
      ) {
        return false
      }
    }
  }
  return true
}

const validateCompletedTopGeometry = (model: GeometryModel) => {
  const segments: LayeredSegment[] = []
  for (const route of model.routes) {
    const ownPad = getOwnPad(model, route)
    if (
      !ownPad ||
      !Number.isFinite(route.via.x) ||
      !Number.isFinite(route.via.y) ||
      distance(route.topPath[0]!, route.source) > EPS ||
      distance(route.topPath.at(-1)!, route.via) > EPS ||
      padEdgeDistance(model, route.via) + EPS <
        model.rules.viaDiameter / 2 + model.rules.viaToPadClearance
    ) {
      return false
    }
    for (const segment of pathSegments(route.topPath)) {
      if (
        !isOctilinear(segment.a, segment.b) ||
        segmentPadEdgeDistance(model, segment.a, segment.b, ownPad.id) + EPS <
          model.rules.traceWidth / 2 + model.rules.traceToPadClearance
      ) {
        return false
      }
      segments.push({
        ...segment,
        layer: "top",
        connectionName: route.connectionName,
      })
    }
  }
  for (let firstIndex = 0; firstIndex < model.routes.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < model.routes.length;
      secondIndex++
    ) {
      if (
        distance(
          model.routes[firstIndex]!.via,
          model.routes[secondIndex]!.via,
        ) +
          EPS <
        model.rules.viaToViaCenter
      ) {
        return false
      }
    }
  }
  for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
    const first = segments[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < segments.length;
      secondIndex++
    ) {
      const second = segments[secondIndex]!
      if (
        !sameNet(first.connectionName, second.connectionName) &&
        segmentDistance(first.a, first.b, second.a, second.b) + EPS <
          tracePairCenterDistance(model.rules)
      ) {
        return false
      }
    }
    for (const route of model.routes) {
      if (
        !sameNet(first.connectionName, route.connectionName) &&
        pointSegmentDistance(route.via, first.a, first.b) + EPS <
          traceViaCenterDistance(model.rules)
      ) {
        return false
      }
    }
  }
  return true
}

const numberByFreeSpaceDistance = (model: GeometryModel) => {
  for (const net of model.nets) {
    const row = Math.round(
      (net.source.y - (model.padBounds.minY + model.pitchY / 2)) /
        (model.pitchY / 2),
    )
    const column = Math.round(
      (net.source.x - (model.padBounds.minX + model.pitchX / 2)) /
        (model.pitchX / 2),
    )
    net.rank = Math.min(
      ...model.freeCells.map(
        (cell) => Math.abs(cell.row - row) + Math.abs(cell.column - column),
      ),
    )
  }
}

const snapshotRoutedNet = (route: RoutedNet): ReferenceRouteSnapshot => ({
  connectionName: route.connectionName,
  selectedLayer: route.selectedLayer,
  source: { ...route.source },
  target: { ...route.target },
  topPath: route.topPath.map((point) => ({ ...point })),
  via: { ...route.via },
  innerPath: route.innerPath.map((point) => ({ ...point })),
  kind: route.kind,
})

const assignEarlyDropsSteps = function* (
  model: GeometryModel,
  clock: SearchClock = wallClock,
): Generator<ReferenceSearchStep, void> {
  const assignmentDeadline = clock.now() + 30_000
  const hasAssignmentBudget = () => clock.now() < assignmentDeadline
  const maximumReach = Math.max(model.pitchX, model.pitchY) * 2.52
  const enumerateLocalDrops = function* (
    net: FanoutNet,
    accepted: RoutedNet[],
    limit = 1,
    reach = maximumReach,
    includeBoundarySites = true,
  ): Generator<ReferenceSearchStep, RoutedNet[]> {
    yield {
      action: "prepare_early_drop_candidate_pool",
      status: "candidate",
      connectionName: net.connectionName,
    }
    const minimumSourceY = Math.min(
      ...model.nets.map((route) => route.source.y),
    )
    const maximumSourceY = Math.max(
      ...model.nets.map((route) => route.source.y),
    )
    const packageCenterY = (minimumSourceY + maximumSourceY) / 2
    const sourceBoundaryDistance = Math.min(
      Math.abs(net.source.y - minimumSourceY),
      Math.abs(net.source.y - maximumSourceY),
    )
    const exteriorSites: FreeCell[] =
      includeBoundarySites && sourceBoundaryDistance <= model.pitchY / 2 + EPS
        ? [model.pitchY / 2, model.pitchY, model.pitchY * 1.5].flatMap(
            (depth, depthIndex) =>
              [
                -model.pitchX / 2,
                -model.pitchX / 4,
                0,
                model.pitchX / 4,
                model.pitchX / 2,
              ].map((offsetX, offsetIndex) => ({
                x: Q(net.source.x + offsetX),
                y: Q(
                  net.source.y +
                    Math.sign(net.source.y - packageCenterY || 1) * depth,
                ),
                row: depthIndex,
                column: offsetIndex,
                clearance: padEdgeDistance(model, {
                  x: Q(net.source.x + offsetX),
                  y: Q(
                    net.source.y +
                      Math.sign(net.source.y - packageCenterY || 1) * depth,
                  ),
                }),
              })),
          )
        : []
    const candidates = [...exteriorSites, ...model.freeCells]
      .flatMap((cell) =>
        (exteriorSites.includes(cell)
          ? [0]
          : [-model.pitchX / 4, 0, model.pitchX / 4]
        ).flatMap((offsetX) =>
          [
            ...(exteriorSites.includes(cell)
              ? [0]
              : [
                  -model.pitchY / 2,
                  -model.pitchY / 4,
                  0,
                  model.pitchY / 4,
                  model.pitchY / 2,
                ]),
          ].map((offsetY) => ({
            ...cell,
            x: Q(cell.x + offsetX),
            y: Q(cell.y + offsetY),
          })),
        ),
      )
      .map((cell) => ({
        cell,
        distance: distance(net.source, cell),
        distanceSquared: squaredDistance(net.source, cell),
      }))
      .sort(
        (first, second) =>
          first.distanceSquared - second.distanceSquared ||
          second.cell.clearance - first.cell.clearance ||
          first.cell.row - second.cell.row ||
          first.cell.column - second.cell.column,
      )
    yield {
      action: "rank_early_drop_candidate_pool",
      status: "completed",
      connectionName: net.connectionName,
      processed: candidates.length,
      total: candidates.length,
    }
    const selected: RoutedNet[] = []
    const signatures = new Set<string>()
    let processedCandidates = 0
    for (const { cell, distance: candidateDistance } of candidates) {
      if (!hasAssignmentBudget()) break
      if (candidateDistance > reach + EPS) break
      for (const path of octilinearCandidates(net.source, cell)) {
        processedCandidates++
        const candidateRoute: RoutedNet = {
          ...net,
          topPath: path,
          via: { x: cell.x, y: cell.y },
          innerPath: [],
          kind: "early",
          regionId: cell.regionId,
        }
        if (!topPathIsLegal(model, net, path, cell, accepted)) {
          yield {
            action: "evaluate_early_drop_candidate",
            status: "rejected",
            connectionName: net.connectionName,
            candidateId: `${pointKey(cell)}:${processedCandidates}`,
            reason: "top_geometry_conflict",
            processed: processedCandidates,
            point: { x: cell.x, y: cell.y },
            route: snapshotRoutedNet(candidateRoute),
          }
          continue
        }
        const signature = `${pointKey(cell)}:${path.map((point) => pointKey(point)).join(";")}`
        if (signatures.has(signature)) {
          yield {
            action: "evaluate_early_drop_candidate",
            status: "rejected",
            connectionName: net.connectionName,
            candidateId: signature,
            reason: "duplicate_candidate",
            processed: processedCandidates,
            point: { x: cell.x, y: cell.y },
            route: snapshotRoutedNet(candidateRoute),
          }
          continue
        }
        signatures.add(signature)
        selected.push(candidateRoute)
        yield {
          action: "evaluate_early_drop_candidate",
          status: "accepted",
          connectionName: net.connectionName,
          candidateId: signature,
          processed: processedCandidates,
          point: { x: cell.x, y: cell.y },
          route: snapshotRoutedNet(candidateRoute),
        }
        if (selected.length >= limit) {
          yield {
            action: "complete_early_drop_enumeration",
            status: "accepted",
            connectionName: net.connectionName,
            candidateId: signature,
            processed: processedCandidates,
            total: candidates.length,
            point: { ...candidateRoute.via },
            route: snapshotRoutedNet(candidateRoute),
          }
          return selected
        }
      }
    }
    yield {
      action: "complete_early_drop_enumeration",
      status: selected.length > 0 ? "accepted" : "rejected",
      connectionName: net.connectionName,
      reason: selected.length > 0 ? undefined : "no_legal_local_drop",
      processed: processedCandidates,
      total: candidates.length,
      point: selected.at(-1)?.via,
      route: selected.at(-1) ? snapshotRoutedNet(selected.at(-1)!) : undefined,
    }
    return selected
  }
  const assignOne = function* (
    net: FanoutNet,
    accepted: RoutedNet[],
    includeBoundarySites = true,
  ): Generator<ReferenceSearchStep, RoutedNet | undefined> {
    const candidates = yield* enumerateLocalDrops(
      net,
      accepted,
      1,
      maximumReach,
      includeBoundarySites,
    )
    return candidates[0]
  }
  const getTopologyPenalty = (routes: RoutedNet[]) => {
    let penalty = 0
    for (const layer of new Set(routes.map((route) => route.selectedLayer))) {
      const ordered = routes
        .filter((route) => route.selectedLayer === layer)
        .sort((first, second) => first.target.y - second.target.y)
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1]!
        const current = ordered[index]!
        const viaSeparation = current.via.y - previous.via.y
        penalty += Math.max(0, model.rules.viaToViaCenter - viaSeparation) * 100
        penalty += Math.abs(
          current.target.y - previous.target.y - viaSeparation,
        )
      }
    }
    return penalty
  }
  const baseOrder = [...model.nets].sort(
    (first, second) =>
      first.rank - second.rank ||
      first.source.y - second.source.y ||
      compareCanonicalNetOrder(first, second),
  )
  const minimumSourceY = Math.min(...model.nets.map((net) => net.source.y))
  const maximumSourceY = Math.max(...model.nets.map((net) => net.source.y))
  const boundaryTolerance = Math.min(model.pitchX, model.pitchY) / 4
  const isBoundarySource = (net: FanoutNet) =>
    Math.abs(net.source.y - minimumSourceY) <= boundaryTolerance ||
    Math.abs(net.source.y - maximumSourceY) <= boundaryTolerance
  const boundaryFirstShallow = [...baseOrder].sort(
    (first, second) =>
      Number(isBoundarySource(second)) - Number(isBoundarySource(first)) ||
      (isBoundarySource(first) && isBoundarySource(second)
        ? second.source.x - first.source.x || first.source.y - second.source.y
        : first.rank - second.rank),
  )
  const boundaryFirstDeep = [...baseOrder].sort(
    (first, second) =>
      Number(isBoundarySource(second)) - Number(isBoundarySource(first)) ||
      (isBoundarySource(first) && isBoundarySource(second)
        ? first.source.x - second.source.x || first.source.y - second.source.y
        : first.rank - second.rank),
  )
  const candidateSets: Array<{
    routes: RoutedNet[]
    singletonResidualBuses: number
    topologyPenalty: number
    rankSum: number
  }> = []
  const signatures = new Set<string>()
  const registerCandidate = (routes: RoutedNet[]) => {
    const acceptedNames = new Set(routes.map((route) => route.connectionName))
    const signature = routes
      .map((route) => `${route.connectionName}@${pointKey(route.via)}`)
      .sort()
      .join("\n")
    if (signatures.has(signature)) return
    signatures.add(signature)
    const singletonResidualBuses = (model.input.buses ?? []).filter(
      (bus) =>
        bus.connectionNames.filter((name) => !acceptedNames.has(name))
          .length === 1,
    ).length
    candidateSets.push({
      routes: [...routes].sort((first, second) => first.rank - second.rank),
      singletonResidualBuses,
      topologyPenalty: getTopologyPenalty(routes),
      rankSum: routes.reduce((sum, route) => sum + route.rank, 0),
    })
  }
  const requiredBoundaryGroups = new Map<string, FanoutNet[]>()
  for (const net of model.nets) {
    if (!isBoundarySource(net)) continue
    const row = Q(net.source.y)
    const key = `${row}:${net.busId}`
    const routes = requiredBoundaryGroups.get(key) ?? []
    routes.push(net)
    requiredBoundaryGroups.set(key, routes)
  }
  const boundaryGroups = [...requiredBoundaryGroups.values()].filter(
    (group) => group.length >= 2,
  )
  const maximumBoundaryGroupSize = Math.max(
    0,
    ...boundaryGroups.map((group) => group.length),
  )
  const requiredBoundaryNets = boundaryGroups
    .filter((group) => group.length === maximumBoundaryGroupSize)
    .flatMap((group) => {
      // The reference ViaLine phase partitions an ordered escape row into
      // strings of two or three.  The string nearest the escape-facing edge
      // is the one that must receive short local dogbones before the interior
      // rows can occupy its channels.  Keep this derived from source geometry
      // and the generic 2–3 grouping rule.
      const ordered = [...group].sort(
        (first, second) =>
          first.source.x - second.source.x || first.busRank - second.busRank,
      )
      const sizes: number[] = []
      let remaining = ordered.length
      if (remaining % 3 === 1) {
        sizes.push(2, 2)
        remaining -= 4
      } else if (remaining % 3 === 2) {
        sizes.push(2)
        remaining -= 2
      }
      while (remaining > 0) {
        sizes.push(3)
        remaining -= 3
      }
      return ordered.slice(-sizes.at(-1)!)
    })
  const extendedLocalReach = (net: FanoutNet) =>
    Math.max(
      maximumReach,
      (net.rank * Math.min(model.pitchX, model.pitchY)) / 2 +
        Math.max(model.pitchX, model.pitchY),
    )
  const requiredCandidateMap = new Map<string, RoutedNet[]>()
  for (const net of requiredBoundaryNets) {
    requiredCandidateMap.set(
      net.connectionName,
      yield* enumerateLocalDrops(net, [], 12, extendedLocalReach(net)),
    )
  }
  const localRoutesConflict = (first: RoutedNet, second: RoutedNet) =>
    !topPathIsLegal(model, first, first.topPath, first.via, [second]) ||
    !topPathIsLegal(model, second, second.topPath, second.via, [first])
  let conflictClosureAttempts = 0
  const repairBoundaryLocalDrops = function* (
    accepted: RoutedNet[],
    fillOrder: FanoutNet[],
  ): Generator<ReferenceSearchStep, void> {
    if (
      !hasAssignmentBudget() ||
      requiredBoundaryNets.length === 0 ||
      conflictClosureAttempts++ >= 1 ||
      [...requiredCandidateMap.values()].some(
        (candidates) => candidates.length === 0,
      )
    ) {
      return
    }
    const requiredNames = new Set(
      requiredBoundaryNets.map((net) => net.connectionName),
    )
    const closureRoutes = accepted.filter(
      (route) =>
        requiredNames.has(route.connectionName) ||
        [...requiredCandidateMap.values()].some((candidates) =>
          candidates.some((candidate) => localRoutesConflict(candidate, route)),
        ),
    )
    const closureNames = new Set(
      closureRoutes.map((route) => route.connectionName),
    )
    const frozen = accepted.filter(
      (route) => !closureNames.has(route.connectionName),
    )
    const variableNets = [
      ...requiredBoundaryNets,
      ...closureRoutes
        .filter((route) => !requiredNames.has(route.connectionName))
        .map(
          (route) =>
            model.nets.find(
              (net) => net.connectionName === route.connectionName,
            )!,
        ),
    ]
    const candidateMap = new Map<string, RoutedNet[]>()
    for (const net of variableNets) {
      if (!hasAssignmentBudget()) return
      candidateMap.set(
        net.connectionName,
        yield* enumerateLocalDrops(
          net,
          frozen,
          requiredNames.has(net.connectionName) ? 8 : 12,
          extendedLocalReach(net),
        ),
      )
    }
    if (
      [...candidateMap.values()].some((candidates) => candidates.length === 0)
    ) {
      return
    }
    const requiredVariableNets = variableNets.filter((net) =>
      requiredNames.has(net.connectionName),
    )
    const optionalVariableNets = variableNets.filter(
      (net) => !requiredNames.has(net.connectionName),
    )
    const allCandidates = [...candidateMap.values()].flat()
    const candidateIndex = new Map(
      allCandidates.map((candidate, index) => [candidate, index]),
    )
    const conflictBits = allCandidates.map(
      () => new Uint8Array(allCandidates.length),
    )
    for (let firstIndex = 0; firstIndex < allCandidates.length; firstIndex++) {
      if (!hasAssignmentBudget()) return
      const first = allCandidates[firstIndex]!
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < allCandidates.length;
        secondIndex++
      ) {
        const second = allCandidates[secondIndex]!
        let conflict = false
        if (
          first.connectionName !== second.connectionName &&
          localRoutesConflict(first, second)
        ) {
          conflict = true
          conflictBits[firstIndex]![secondIndex] = 1
          conflictBits[secondIndex]![firstIndex] = 1
        }
        yield {
          action: "compare_early_drop_candidates",
          status: conflict ? "rejected" : "accepted",
          connectionName: first.connectionName,
          candidateId: `${firstIndex}:${secondIndex}`,
          reason: conflict
            ? `conflicts_with:${second.connectionName}`
            : undefined,
          processed:
            firstIndex * allCandidates.length + secondIndex - firstIndex,
          total: allCandidates.length * allCandidates.length,
          point: { ...first.via },
          route: snapshotRoutedNet(first),
        }
      }
    }
    const candidatesConflict = (first: RoutedNet, second: RoutedNet) => {
      const firstIndex = candidateIndex.get(first)
      const secondIndex = candidateIndex.get(second)
      return firstIndex === undefined || secondIndex === undefined
        ? localRoutesConflict(first, second)
        : conflictBits[firstIndex]![secondIndex] === 1
    }
    let exploredStates = 0
    const searchDeadline = Math.min(assignmentDeadline, clock.now() + 8_000)
    const searchBudgetAvailable = () =>
      exploredStates < 32_768 && clock.now() < searchDeadline
    let solution: RoutedNet[] | undefined
    const viableCandidates = (remaining: FanoutNet[], selected: RoutedNet[]) =>
      remaining
        .map((net) => ({
          net,
          candidates: candidateMap
            .get(net.connectionName)!
            .filter((candidate) =>
              selected.every((other) => !candidatesConflict(candidate, other)),
            ),
        }))
        .sort(
          (first, second) =>
            first.candidates.length - second.candidates.length ||
            second.net.rank - first.net.rank,
        )
    const searchOptional = function* (
      remaining: FanoutNet[],
      selected: RoutedNet[],
    ): Generator<ReferenceSearchStep, void> {
      exploredStates++
      yield {
        action: "search_optional_early_drop_set",
        status: "candidate",
        connectionName: remaining[0]?.connectionName,
        processed: exploredStates,
        total: 32_768,
      }
      if (!searchBudgetAvailable()) return
      if (!solution || selected.length > solution.length) {
        solution = selected
      }
      if (
        remaining.length === 0 ||
        selected.length + remaining.length <= (solution?.length ?? 0)
      ) {
        return
      }
      const next = viableCandidates(remaining, selected)[0]!
      const rest = remaining.filter(
        (net) => net.connectionName !== next.net.connectionName,
      )
      for (const candidate of next.candidates) {
        yield* searchOptional(rest, [...selected, candidate])
      }
      yield* searchOptional(rest, selected)
    }
    const searchRequired = function* (
      remaining: FanoutNet[],
      selected: RoutedNet[],
    ): Generator<ReferenceSearchStep, void> {
      exploredStates++
      yield {
        action: "search_required_early_drop_set",
        status: "candidate",
        connectionName: remaining[0]?.connectionName,
        processed: exploredStates,
        total: 32_768,
      }
      if (!searchBudgetAvailable()) return
      if (remaining.length === 0) {
        yield* searchOptional(optionalVariableNets, selected)
        return
      }
      const next = viableCandidates(remaining, selected)[0]!
      if (next.candidates.length === 0) return
      const rest = remaining.filter(
        (net) => net.connectionName !== next.net.connectionName,
      )
      for (const candidate of next.candidates) {
        yield* searchRequired(rest, [...selected, candidate])
      }
    }
    yield* searchRequired(requiredVariableNets, [])
    if (!solution) return
    const repaired = [...frozen, ...solution]
    const repairedNames = new Set(repaired.map((route) => route.connectionName))
    for (const net of fillOrder) {
      if (repairedNames.has(net.connectionName)) continue
      const selected = yield* assignOne(net, repaired)
      if (!selected) continue
      repaired.push(selected)
      repairedNames.add(net.connectionName)
    }
    const displacedClosureNames = [...closureNames].filter(
      (name) => !repairedNames.has(name),
    )
    const prioritizedRepaired = repaired.map((route, index) =>
      index === 0
        ? { ...route, residualPriorityNames: displacedClosureNames }
        : route,
    )
    registerCandidate(prioritizedRepaired)
    // ViaLine strings are strictly groups of two or three. If the maximal
    // local assignment leaves one residual member of a bus, free the shortest
    // non-required early drop from that bus as a second candidate so the
    // downstream package-edge phase receives a legal two-route string.
    const viaLineComplete = [...prioritizedRepaired]
    for (const bus of model.input.buses ?? []) {
      const selectedNames = new Set(
        viaLineComplete.map((route) => route.connectionName),
      )
      const residualNames = bus.connectionNames.filter(
        (name) => !selectedNames.has(name),
      )
      if (residualNames.length !== 1) continue
      const removableIndex = viaLineComplete.findIndex(
        (route) =>
          bus.connectionNames.includes(route.connectionName) &&
          !requiredNames.has(route.connectionName),
      )
      if (removableIndex >= 0) {
        const [removed] = viaLineComplete.splice(removableIndex, 1)
        const annotationIndex = viaLineComplete.findIndex(
          (route) => route.residualPriorityNames !== undefined,
        )
        if (removed && viaLineComplete.length > 0) {
          const index = annotationIndex >= 0 ? annotationIndex : 0
          viaLineComplete[index] = {
            ...viaLineComplete[index]!,
            residualPriorityNames: [
              ...(viaLineComplete[index]!.residualPriorityNames ?? []),
              removed.connectionName,
            ],
          }
        }
      }
    }
    registerCandidate(viaLineComplete)
  }
  const routePlans = [
    ...[
      boundaryFirstShallow,
      boundaryFirstDeep,
      baseOrder,
      [...baseOrder].reverse(),
      ...seededOrders(baseOrder, 16, 0x62a10ea1),
    ].map((order) => ({ order, includeBoundarySites: true })),
    ...[
      baseOrder,
      [...baseOrder].reverse(),
      ...seededOrders(baseOrder, 16, 0x62a10ea1),
    ].map((order) => ({ order, includeBoundarySites: false })),
  ]
  for (let planIndex = 0; planIndex < routePlans.length; planIndex++) {
    const { order, includeBoundarySites } = routePlans[planIndex]!
    if (!hasAssignmentBudget()) break
    const accepted: RoutedNet[] = []
    for (const net of order) {
      const selected = yield* assignOne(net, accepted, includeBoundarySites)
      if (selected) accepted.push(selected)
    }
    yield* repairBoundaryLocalDrops(accepted, order)
    registerCandidate(accepted)
    yield {
      action: "complete_early_drop_plan",
      status: "completed",
      processed: planIndex + 1,
      total: routePlans.length,
    }
    for (let removedIndex = 0; removedIndex < accepted.length; removedIndex++) {
      registerCandidate(accepted.filter((_, index) => index !== removedIndex))
    }
  }
  candidateSets.sort(
    (first, second) =>
      first.singletonResidualBuses - second.singletonResidualBuses ||
      second.routes.length - first.routes.length ||
      second.rankSum - first.rankSum ||
      first.topologyPenalty - second.topologyPenalty,
  )
  const candidatesByCount = new Map<number, typeof candidateSets>()
  for (const candidate of candidateSets) {
    const group = candidatesByCount.get(candidate.routes.length) ?? []
    group.push(candidate)
    candidatesByCount.set(candidate.routes.length, group)
  }
  model.earlyRouteCandidates = [...candidatesByCount.keys()]
    .sort((first, second) => second - first)
    .flatMap((count) => candidatesByCount.get(count)!.slice(0, 24))
    .map((candidate) => candidate.routes)
  model.routes = [...(model.earlyRouteCandidates[0] ?? [])]
}

const assignEarlyDrops = (model: GeometryModel) => {
  for (const _step of assignEarlyDropsSteps(model)) {
    // Drain the same incremental implementation for legacy synchronous calls.
  }
}

type GraphPoint = Point & { xi: number; yi: number }

type FindGridPathParams = {
  xs: number[]
  ys: number[]
  starts: Array<{ point: GraphPoint; initialCost: number }>
  isGoal: (point: GraphPoint) => boolean
  pointAllowed: (point: GraphPoint) => boolean
  segmentAllowed: (a: GraphPoint, b: GraphPoint) => boolean
  heuristic: (point: GraphPoint) => number
  visualization: {
    actionScope: "top_layer" | "inner_layer"
    connectionName?: string
    layer: string
    startPoint: Point
    targetPoint: Point
    pathPrefix?: Point[]
  }
}

const findGridPathSteps = function* ({
  xs,
  ys,
  starts,
  isGoal,
  pointAllowed,
  segmentAllowed,
  heuristic,
  visualization,
}: FindGridPathParams): Generator<ReferenceSearchStep, Point[] | null> {
  const width = xs.length
  const height = ys.length
  const nodeAt = (xi: number, yi: number) => yi * width + xi
  const pointFor = (node: number): GraphPoint => ({
    x: xs[node % width]!,
    y: ys[Math.floor(node / width)]!,
    xi: node % width,
    yi: Math.floor(node / width),
  })
  const scores = new Float64Array(width * height)
  const previous = new Int32Array(width * height)
  const closed = new Uint8Array(width * height)
  scores.fill(Number.POSITIVE_INFINITY)
  previous.fill(-2)
  const heap = new MinHeap<{ node: number; score: number }>()
  for (const start of starts) {
    const node = nodeAt(start.point.xi, start.point.yi)
    if (start.initialCost + EPS >= scores[node]!) continue
    scores[node] = start.initialCost
    previous[node] = -1
    heap.push({ node, score: start.initialCost + heuristic(start.point) })
  }
  let goalNode = -1
  const visitedPoints: Point[] = []
  const pathToNode = (node: number) => {
    const reverse: Point[] = []
    for (let cursor = node; cursor >= 0; cursor = previous[cursor]!) {
      const point = pointFor(cursor)
      reverse.push({ x: point.x, y: point.y })
    }
    return [...(visualization.pathPrefix ?? []), ...reverse.reverse()]
  }
  const searchState = (candidateNode: number, expandedNode: number) => ({
    frontierPoints: heap
      .snapshot()
      .map((frontierItem) => pointFor(frontierItem.node)),
    visitedPoints: visitedPoints.slice(-256),
    frontierSize: heap.length,
    visitedCount: visitedPoints.length,
    expandedPoint: pointFor(expandedNode),
    searchStart: visualization.startPoint,
    searchTarget: visualization.targetPoint,
    candidatePath: pathToNode(candidateNode),
    layer: visualization.layer,
  })
  while (heap.length) {
    const item = heap.pop()!
    if (closed[item.node]) continue
    const point = pointFor(item.node)
    closed[item.node] = 1
    visitedPoints.push({ x: point.x, y: point.y })
    const goal = isGoal(point)
    yield {
      action: `pop_${visualization.actionScope}_grid_node`,
      status: goal ? "accepted" : "candidate",
      connectionName: visualization.connectionName,
      candidateId: `${point.x},${point.y}`,
      processed: visitedPoints.length,
      total: width * height,
      point: { x: point.x, y: point.y },
      ...searchState(item.node, item.node),
    }
    if (goal) {
      goalNode = item.node
      break
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const xi = point.xi + dx
      const yi = point.yi + dy
      if (xi < 0 || yi < 0 || xi >= width || yi >= height) {
        yield {
          action: `evaluate_${visualization.actionScope}_neighbor`,
          status: "rejected",
          connectionName: visualization.connectionName,
          candidateId: `${xi},${yi}`,
          reason: "outside_search_grid",
          point: { x: point.x, y: point.y },
          ...searchState(item.node, item.node),
        }
        continue
      }
      const nextNode = nodeAt(xi, yi)
      const next = pointFor(nextNode)
      if (closed[nextNode]) {
        yield {
          action: `evaluate_${visualization.actionScope}_neighbor`,
          status: "rejected",
          connectionName: visualization.connectionName,
          candidateId: `${next.x},${next.y}`,
          reason: "already_visited",
          point: { x: next.x, y: next.y },
          ...searchState(item.node, item.node),
        }
        continue
      }
      if (!isOctilinear(point, next)) {
        yield {
          action: `evaluate_${visualization.actionScope}_neighbor`,
          status: "rejected",
          connectionName: visualization.connectionName,
          candidateId: `${next.x},${next.y}`,
          reason: "non_octilinear_edge",
          point: { x: next.x, y: next.y },
          ...searchState(item.node, item.node),
        }
        continue
      }
      if (!pointAllowed(next)) {
        yield {
          action: `evaluate_${visualization.actionScope}_neighbor`,
          status: "rejected",
          connectionName: visualization.connectionName,
          candidateId: `${next.x},${next.y}`,
          reason: "node_clearance",
          point: { x: next.x, y: next.y },
          ...searchState(item.node, item.node),
        }
        continue
      }
      if (!segmentAllowed(point, next)) {
        yield {
          action: `evaluate_${visualization.actionScope}_neighbor`,
          status: "rejected",
          connectionName: visualization.connectionName,
          candidateId: `${next.x},${next.y}`,
          reason: "edge_clearance",
          point: { x: next.x, y: next.y },
          ...searchState(item.node, item.node),
        }
        continue
      }
      const cost = scores[item.node]! + distance(point, next)
      if (cost + EPS >= scores[nextNode]!) {
        yield {
          action: `evaluate_${visualization.actionScope}_neighbor`,
          status: "rejected",
          connectionName: visualization.connectionName,
          candidateId: `${next.x},${next.y}`,
          reason: "no_lower_cost",
          point: { x: next.x, y: next.y },
          ...searchState(item.node, item.node),
        }
        continue
      }
      scores[nextNode] = cost
      previous[nextNode] = item.node
      heap.push({ node: nextNode, score: cost + heuristic(next) })
      yield {
        action: `evaluate_${visualization.actionScope}_neighbor`,
        status: "accepted",
        connectionName: visualization.connectionName,
        candidateId: `${next.x},${next.y}`,
        point: { x: next.x, y: next.y },
        ...searchState(nextNode, item.node),
      }
    }
  }
  if (goalNode < 0) return null
  const reverse: Point[] = []
  for (let cursor = goalNode; cursor >= 0; cursor = previous[cursor]!) {
    reverse.push(pointFor(cursor))
  }
  return simplifyPath(reverse.reverse())
}

export type ViaLineDepthRanker = (
  groupIndex: number,
  groupCount: number,
) => number

export type ViaLineVerticalDirectionSelector = (
  groupY: number,
  middleY: number,
) => -1 | 1

export type ViaLineSlotIndexer = (
  slotIndex: number,
  slotCount: number,
  verticalDirection: -1 | 1,
) => number

const routeResidualTopDogbonesSteps = function* (
  model: GeometryModel,
  getViaLineDepthRank: ViaLineDepthRanker = (groupIndex) => groupIndex,
  getViaLineVerticalDirection: ViaLineVerticalDirectionSelector = () => -1,
  getViaLineSlotIndex: ViaLineSlotIndexer = (slotIndex) => slotIndex,
): Generator<ReferenceSearchStep, void> {
  let lastViaLineError: unknown
  const acceptCompleteCandidate = (routes: RoutedNet[]) => {
    const trialModel: GeometryModel = {
      ...model,
      routes: routes.map((route) => ({
        ...route,
        topPath: route.topPath.map((point) => ({ ...point })),
        via: { ...route.via },
        innerPath: route.innerPath.map((point) => ({ ...point })),
      })),
    }
    try {
      buildResidualViaLines(
        trialModel,
        getViaLineDepthRank,
        getViaLineVerticalDirection,
        getViaLineSlotIndex,
      )
      if (!validateCompletedTopGeometry(trialModel)) return false
      model.routes = trialModel.routes
      return true
    } catch (error) {
      lastViaLineError = error
      return false
    }
  }
  const allEarlyCandidates =
    model.earlyRouteCandidates.length > 0
      ? model.earlyRouteCandidates
      : [model.routes]
  const leavesSingletonResidualBus = (routes: RoutedNet[]) => {
    const names = new Set(routes.map((route) => route.connectionName))
    return (model.input.buses ?? []).some(
      (bus) =>
        bus.connectionNames.filter((name) => !names.has(name)).length === 1,
    )
  }
  const nonSingletonCandidates = allEarlyCandidates.filter(
    (routes) => !leavesSingletonResidualBus(routes),
  )
  // A locally assigned boundary string can intentionally replace early drops
  // from another row and therefore temporarily leave a one-route bus.  Do not
  // discard that geometrically stronger candidate here; the residual phase
  // still validates whether all 2–3-via strings can be completed.
  const preferredPool = allEarlyCandidates
  const preferredMaximum = Math.max(
    ...preferredPool.map((routes) => routes.length),
  )
  const minimumSourceY = Math.min(...model.nets.map((net) => net.source.y))
  const maximumSourceY = Math.max(...model.nets.map((net) => net.source.y))
  const boundaryTolerance = Math.min(model.pitchX, model.pitchY) / 4
  const boundaryNames = new Set(
    model.nets
      .filter(
        (net) =>
          Math.abs(net.source.y - minimumSourceY) <= boundaryTolerance ||
          Math.abs(net.source.y - maximumSourceY) <= boundaryTolerance,
      )
      .map((net) => net.connectionName),
  )
  const boundaryCompleteCandidates = preferredPool
    .filter((routes) => {
      const names = new Set(routes.map((route) => route.connectionName))
      return [...boundaryNames].every((name) => names.has(name))
    })
    .slice(0, 8)
  const earlyCandidates = [
    ...boundaryCompleteCandidates,
    ...preferredPool.filter((routes) => routes.length >= preferredMaximum - 1),
    ...nonSingletonCandidates.slice(0, 8),
    ...[
      ...new Map(
        allEarlyCandidates.map((routes) => [routes.length, routes]),
      ).values(),
    ],
  ]
    .filter(
      (routes, index, candidates) =>
        candidates.findIndex(
          (candidate) =>
            candidate.length === routes.length &&
            candidate.every(
              (route, routeIndex) =>
                route.connectionName === routes[routeIndex]?.connectionName &&
                pointKey(route.via) === pointKey(routes[routeIndex]!.via),
            ),
        ) === index,
    )
    .slice(0, 16)
  let bestTotal = -1
  let bestResidualCount = 0
  let bestSolved: RoutedNet[] = []

  for (
    let earlyCandidateIndex = 0;
    earlyCandidateIndex < earlyCandidates.length;
    earlyCandidateIndex++
  ) {
    const earlyRoutes = earlyCandidates[earlyCandidateIndex]!
    yield {
      action: "evaluate_early_route_set",
      status: "candidate",
      candidateId: `early-set-${earlyCandidateIndex}`,
      processed: earlyCandidateIndex + 1,
      total: earlyCandidates.length,
    }
    const earlyNames = new Set(earlyRoutes.map((route) => route.connectionName))
    const residual = model.nets.filter(
      (net) => !earlyNames.has(net.connectionName),
    )
    if (residual.length === 0) {
      const accepted = acceptCompleteCandidate([...earlyRoutes])
      yield {
        action: "commit_complete_topology",
        status: accepted ? "accepted" : "rejected",
        candidateId: `early-set-${earlyCandidateIndex}`,
        reason: accepted ? undefined : "reconstructed_geometry_conflict",
      }
      if (accepted) return
      continue
    }

    // The reference algorithm routes every non-early ball to a portal on the
    // permitted package edge before building the exterior 2–3-via strings.
    const stepX = model.pitchX / 2
    const stepY = model.pitchY / 2
    const xs: number[] = []
    const ys: number[] = []
    const minimumSourceX = Math.min(...residual.map((net) => net.source.x))
    for (
      let x = Q(minimumSourceX - stepX);
      x <= model.padBounds.maxX + EPS;
      x = Q(x + stepX)
    ) {
      xs.push(x)
    }
    xs.push(model.padBounds.maxX, ...residual.map((net) => Q(net.source.x)))
    xs.splice(0, xs.length, ...uniqueSorted(xs))
    for (
      let y = Q(model.padBounds.minY);
      y <= model.padBounds.maxY + EPS;
      y = Q(y + stepY)
    ) {
      ys.push(y)
    }
    ys.push(...residual.map((net) => Q(net.source.y)))
    ys.splice(0, ys.length, ...uniqueSorted(ys))

    const routeOne = function* (
      net: FanoutNet,
      accepted: RoutedNet[],
      portalOrderSeed: number,
      preferredPortalY?: number,
    ): Generator<ReferenceSearchStep, RoutedNet | null> {
      const ownPad = getOwnPad(model, net)
      if (!ownPad) return null
      const fixedSegments = accepted.flatMap((route) =>
        pathSegments(route.topPath),
      )
      const fixedVias = [
        ...model.previousVias,
        ...accepted
          .map((route) => route.via)
          .filter((via) => Number.isFinite(via.x) && Number.isFinite(via.y)),
      ]
      const starts: Array<{ point: GraphPoint; initialCost: number }> = []
      for (let yi = 0; yi < ys.length; yi++) {
        for (let xi = 0; xi < xs.length; xi++) {
          const point: GraphPoint = { x: xs[xi]!, y: ys[yi]!, xi, yi }
          const sourceDistance = distance(net.source, point)
          if (
            sourceDistance <= EPS ||
            sourceDistance > Math.hypot(model.pitchX, model.pitchY) + EPS ||
            !isOctilinear(net.source, point)
          ) {
            continue
          }
          if (
            padEdgeDistance(model, point) + EPS <
            model.rules.traceWidth / 2 + model.rules.traceToPadClearance
          ) {
            continue
          }
          if (
            segmentPadEdgeDistance(model, net.source, point, ownPad.id) + EPS <
            model.rules.traceWidth / 2 + model.rules.traceToPadClearance
          ) {
            continue
          }
          if (
            fixedSegments.some(
              (segment) =>
                segmentDistance(net.source, point, segment.a, segment.b) + EPS <
                tracePairCenterDistance(model.rules),
            ) ||
            fixedVias.some(
              (via) =>
                pointSegmentDistance(via, net.source, point) + EPS <
                traceViaCenterDistance(model.rules),
            )
          ) {
            continue
          }
          starts.push({ point, initialCost: sourceDistance })
        }
      }

      const occupiedPortalYs = accepted
        .filter(
          (route) =>
            route.kind === "residual" &&
            Math.abs(
              route.topPath[route.topPath.length - 1]!.x - model.padBounds.maxX,
            ) <= EPS,
        )
        .map((route) => route.topPath[route.topPath.length - 1]!.y)
      const portalCandidates = ys
        .map((y) => ({ x: model.padBounds.maxX, y }))
        .filter(
          (portal) =>
            padEdgeDistance(model, portal) + EPS >=
              model.rules.traceWidth / 2 + model.rules.traceToPadClearance &&
            fixedVias.every(
              (via) =>
                distance(portal, via) + EPS >=
                traceViaCenterDistance(model.rules),
            ) &&
            occupiedPortalYs.every(
              (y) =>
                Math.abs(y - portal.y) + EPS >=
                tracePairCenterDistance(model.rules),
            ),
        )
        .sort(
          (first, second) =>
            Math.abs(first.y - net.source.y) -
              Math.abs(second.y - net.source.y) ||
            Math.abs(first.y - net.target.y) -
              Math.abs(second.y - net.target.y) ||
            first.y - second.y,
        )
      if (portalOrderSeed > 0) {
        let state = (portalOrderSeed + net.rank * 2654435761) >>> 0
        for (let index = portalCandidates.length - 1; index > 0; index--) {
          const upperExclusive = index + 1
          const bucketSize = Math.floor(0x1_0000_0000 / upperExclusive)
          const usableStateCount = bucketSize * upperExclusive
          do {
            state = (state * 1664525 + 1013904223) >>> 0
          } while (state >= usableStateCount)
          const swap = Math.floor(state / bucketSize)
          ;[portalCandidates[index], portalCandidates[swap]] = [
            portalCandidates[swap]!,
            portalCandidates[index]!,
          ]
        }
      }
      const pointAllowed = (point: GraphPoint) =>
        padEdgeDistance(model, point) + EPS >=
          model.rules.traceWidth / 2 + model.rules.traceToPadClearance &&
        fixedVias.every(
          (via) =>
            distance(point, via) + EPS >= traceViaCenterDistance(model.rules),
        )
      const segmentAllowed = (a: GraphPoint, b: GraphPoint) =>
        segmentPadEdgeDistance(model, a, b) + EPS >=
          model.rules.traceWidth / 2 + model.rules.traceToPadClearance &&
        fixedSegments.every(
          (segment) =>
            segmentDistance(a, b, segment.a, segment.b) + EPS >=
            tracePairCenterDistance(model.rules),
        ) &&
        fixedVias.every(
          (via) =>
            pointSegmentDistance(via, a, b) + EPS >=
            traceViaCenterDistance(model.rules),
        )
      const packageCenterY = (model.padBounds.minY + model.padBounds.maxY) / 2
      const outwardPortalY =
        net.source.y + Math.sign(net.source.y - packageCenterY || 1) * stepY
      const preferredPortal =
        preferredPortalY !== undefined
          ? [...portalCandidates].sort(
              (first, second) =>
                Math.abs(first.y - preferredPortalY) -
                Math.abs(second.y - preferredPortalY),
            )[0]
          : portalOrderSeed === -1
            ? [...portalCandidates].sort(
                (first, second) =>
                  Math.abs(first.y - outwardPortalY) -
                  Math.abs(second.y - outwardPortalY),
              )[0]
            : portalOrderSeed > 0
              ? portalCandidates[0]
              : undefined
      const path = yield* findGridPathSteps({
        xs,
        ys,
        starts,
        isGoal: (point) =>
          Math.abs(point.x - model.padBounds.maxX) <= EPS &&
          (preferredPortalY === undefined ||
            Math.abs(point.y - preferredPortalY) <= EPS) &&
          occupiedPortalYs.every(
            (y) =>
              Math.abs(y - point.y) + EPS >=
              tracePairCenterDistance(model.rules),
          ),
        pointAllowed,
        segmentAllowed,
        heuristic: (point) =>
          model.padBounds.maxX -
          point.x +
          (preferredPortal ? Math.abs(preferredPortal.y - point.y) * 0.8 : 0) +
          Math.max(0, minimumSourceX - point.x) * 0.2,
        visualization: {
          actionScope: "top_layer",
          connectionName: net.connectionName,
          layer: "top",
          startPoint: net.source,
          targetPoint: net.target,
          pathPrefix: [net.source],
        },
      })
      if (!path) {
        yield {
          action: "route_top_layer_connection",
          status: "rejected",
          connectionName: net.connectionName,
          reason: "no_legal_grid_path",
        }
        return null
      }
      const routed: RoutedNet = {
        ...net,
        topPath: simplifyPath([net.source, ...path]),
        via: { x: Number.NaN, y: Number.NaN },
        innerPath: [],
        kind: "residual",
      }
      yield {
        action: "route_top_layer_connection",
        status: "accepted",
        connectionName: net.connectionName,
        point: routed.topPath.at(-1),
        route: snapshotRoutedNet(routed),
      }
      return routed
    }

    const atomicGroups: FanoutNet[][] = []
    let atomicGroupingIsValid = true
    const groupedNames = new Set<string>()
    const addAtomicBusGroups = (busRoutes: FanoutNet[]) => {
      if (busRoutes.length === 0) return
      const ordered = [...busRoutes].sort(
        (first, second) =>
          first.source.y - second.source.y ||
          first.source.x - second.source.x ||
          first.busRank - second.busRank,
      )
      const sizes = chunkSizes(ordered.length)
      let offset = 0
      for (const size of sizes) {
        atomicGroups.push(ordered.slice(offset, offset + size))
        offset += size
      }
      if (offset !== ordered.length) atomicGroupingIsValid = false
      for (const route of ordered) groupedNames.add(route.connectionName)
    }
    for (const bus of model.input.buses ?? []) {
      const names = new Set(bus.connectionNames)
      addAtomicBusGroups(
        residual.filter((route) => names.has(route.connectionName)),
      )
    }
    const ungroupedByBus = new Map<string, FanoutNet[]>()
    for (const route of residual) {
      if (groupedNames.has(route.connectionName)) continue
      const routes = ungroupedByBus.get(route.busId) ?? []
      routes.push(route)
      ungroupedByBus.set(route.busId, routes)
    }
    for (const routes of ungroupedByBus.values()) addAtomicBusGroups(routes)
    atomicGroups.sort((first, second) => {
      const firstY =
        first.reduce((sum, route) => sum + route.source.y, 0) / first.length
      const secondY =
        second.reduce((sum, route) => sum + route.source.y, 0) / second.length
      return (
        Math.abs(secondY - (model.padBounds.minY + model.padBounds.maxY) / 2) -
          Math.abs(
            firstY - (model.padBounds.minY + model.padBounds.maxY) / 2,
          ) ||
        firstY - secondY ||
        first[0]!.busId.localeCompare(second[0]!.busId)
      )
    })

    const permuteSmallGroup = (routes: FanoutNet[]) => {
      const permutations: FanoutNet[][] = []
      const build = (prefix: FanoutNet[], remaining: FanoutNet[]) => {
        if (remaining.length === 0) {
          permutations.push(prefix)
          return
        }
        for (let index = 0; index < remaining.length; index++) {
          build(
            [...prefix, remaining[index]!],
            remaining.filter((_, otherIndex) => otherIndex !== index),
          )
        }
      }
      build([], routes)
      return permutations
    }
    const legalPortalYs = ys.filter((y) => {
      const portal = { x: model.padBounds.maxX, y }
      return (
        padEdgeDistance(model, portal) + EPS >=
        model.rules.traceWidth / 2 + model.rules.traceToPadClearance
      )
    })
    const solveAtomicGroup = function* (
      group: FanoutNet[],
      accepted: RoutedNet[],
    ): Generator<ReferenceSearchStep, RoutedNet[][]> {
      const groupCenterY =
        group.reduce((sum, route) => sum + route.source.y, 0) / group.length
      const packageCenterY = (model.padBounds.minY + model.padBounds.maxY) / 2
      const outwardSign = Math.sign(groupCenterY - packageCenterY || 1)
      const desiredCenterY = groupCenterY + outwardSign * stepY
      const windows = legalPortalYs
        .slice(0, Math.max(0, legalPortalYs.length - group.length + 1))
        .map((_, index) => legalPortalYs.slice(index, index + group.length))
        .sort((first, second) => {
          const firstCenter =
            first.reduce((sum, y) => sum + y, 0) / first.length
          const secondCenter =
            second.reduce((sum, y) => sum + y, 0) / second.length
          return (
            Math.abs(firstCenter - desiredCenterY) -
              Math.abs(secondCenter - desiredCenterY) ||
            outwardSign * (secondCenter - firstCenter)
          )
        })
        .slice(0, 12)
      const depthOrder = [...group].sort(
        (first, second) =>
          first.source.x - second.source.x || first.rank - second.rank,
      )
      const routeOrders = permuteSmallGroup(group)
      const solutions: RoutedNet[][] = []
      const signatures = new Set<string>()
      for (const window of windows) {
        const outwardLanes = [...window].sort(
          (first, second) => outwardSign * (second - first),
        )
        for (const lanes of [outwardLanes, [...outwardLanes].reverse()]) {
          const portalByName = new Map(
            depthOrder.map((route, index) => [
              route.connectionName,
              lanes[index]!,
            ]),
          )
          for (const order of routeOrders) {
            const trialAccepted = [...accepted]
            const solved: RoutedNet[] = []
            for (const route of order) {
              const routed = yield* routeOne(
                route,
                trialAccepted,
                -1,
                portalByName.get(route.connectionName),
              )
              if (!routed) break
              trialAccepted.push(routed)
              solved.push(routed)
            }
            if (solved.length !== group.length) continue
            const signature = solved
              .map(
                (route) =>
                  route.connectionName +
                  ":" +
                  pointKey(route.topPath[route.topPath.length - 1]!),
              )
              .sort()
              .join("|")
            if (signatures.has(signature)) continue
            signatures.add(signature)
            solutions.push(solved)
            if (solutions.length >= 4) return solutions
          }
        }
      }
      return solutions
    }

    // Solve the outer source rows as ordered boundary batches before ordinary
    // interior residuals. This mirrors the reference package-edge phase and
    // prevents a shallow greedy dogbone from sealing its deeper neighbor.
    const residualMinY = Math.min(...residual.map((route) => route.source.y))
    const residualMaxY = Math.max(...residual.map((route) => route.source.y))
    const boundaryTolerance = Math.min(model.pitchX, model.pitchY) / 4
    const boundaryByRowAndBus = new Map<string, FanoutNet[]>()
    for (const route of residual) {
      const side =
        Math.abs(route.source.y - residualMinY) <= boundaryTolerance
          ? "bottom"
          : Math.abs(route.source.y - residualMaxY) <= boundaryTolerance
            ? "top"
            : undefined
      if (!side) continue
      const key = `${side}:${route.busId}`
      const routes = boundaryByRowAndBus.get(key) ?? []
      routes.push(route)
      boundaryByRowAndBus.set(key, routes)
    }
    const boundaryGroups = [...boundaryByRowAndBus.values()]
      .filter((group) => group.length >= 2)
      .sort(
        (first, second) =>
          first[0]!.source.y - second[0]!.source.y ||
          first[0]!.busId.localeCompare(second[0]!.busId),
      )
    const solveBoundaryGroup = function* (
      group: FanoutNet[],
      accepted: RoutedNet[],
    ): Generator<ReferenceSearchStep, RoutedNet[][]> {
      const centerY =
        group.reduce((sum, route) => sum + route.source.y, 0) / group.length
      const packageCenterY = (model.padBounds.minY + model.padBounds.maxY) / 2
      const outwardSign = Math.sign(centerY - packageCenterY || 1)
      const depthOrder = [...group].sort(
        (first, second) =>
          first.source.x - second.source.x || first.busRank - second.busRank,
      )
      const solutions: RoutedNet[][] = []
      let exploredAssignments = 0
      const assignOrderedPortals = function* (
        routeIndex: number,
        previousPortalY: number | undefined,
        trialAccepted: RoutedNet[],
        solved: RoutedNet[],
      ): Generator<ReferenceSearchStep, void> {
        if (solutions.length >= 4 || ++exploredAssignments > 256) return
        if (routeIndex === depthOrder.length) {
          solutions.push(solved)
          return
        }
        const route = depthOrder[routeIndex]!
        // Deeper sources get first choice of interior lanes; progressively
        // shallower sources are biased farther outward while preserving order.
        const desiredPortalY =
          route.source.y + outwardSign * stepY * (routeIndex + 1)
        const candidates = [...legalPortalYs]
          .filter(
            (lane) =>
              previousPortalY === undefined ||
              outwardSign * (lane - previousPortalY) + EPS >=
                tracePairCenterDistance(model.rules),
          )
          .sort(
            (first, second) =>
              Math.abs(first - desiredPortalY) -
                Math.abs(second - desiredPortalY) ||
              outwardSign * (second - first),
          )
          .slice(0, 16)
        for (const lane of candidates) {
          const routed = yield* routeOne(route, trialAccepted, -1, lane)
          if (!routed) continue
          yield* assignOrderedPortals(
            routeIndex + 1,
            lane,
            [...trialAccepted, routed],
            [...solved, routed],
          )
          if (solutions.length >= 4) return
        }
      }
      yield* assignOrderedPortals(0, undefined, [...accepted], [])
      return solutions
    }
    if (boundaryGroups.length > 0) {
      const boundaryNames = new Set(
        boundaryGroups.flatMap((group) =>
          group.map((route) => route.connectionName),
        ),
      )
      const interior = residual.filter(
        (route) => !boundaryNames.has(route.connectionName),
      )
      let exploredBoundaryStates = 0
      const fillInterior = function* (
        accepted: RoutedNet[],
        boundarySolved: RoutedNet[],
      ): Generator<ReferenceSearchStep, RoutedNet[] | null> {
        const orders = [
          [...interior].sort(
            (first, second) =>
              first.rank - second.rank || first.source.y - second.source.y,
          ),
          [...interior].sort(
            (first, second) =>
              first.source.y - second.source.y || first.rank - second.rank,
          ),
          ...seededOrders(interior, 6, 0xb0a0da7a),
        ]
        for (let orderIndex = 0; orderIndex < orders.length; orderIndex++) {
          const trialAccepted = [...accepted]
          const solved = [...boundarySolved]
          for (const route of orders[orderIndex]!) {
            const routed = yield* routeOne(
              route,
              trialAccepted,
              orderIndex === 0 ? 0 : orderIndex,
            )
            if (!routed) continue
            trialAccepted.push(routed)
            solved.push(routed)
          }
          if (solved.length === residual.length) return solved
        }
        return null
      }
      const searchBoundaryGroups = function* (
        groupIndex: number,
        accepted: RoutedNet[],
        solved: RoutedNet[],
      ): Generator<ReferenceSearchStep, RoutedNet[] | null> {
        if (++exploredBoundaryStates > 32) return null
        yield {
          action: "search_boundary_group",
          status: "candidate",
          processed: exploredBoundaryStates,
          total: 32,
        }
        if (groupIndex === boundaryGroups.length) {
          return yield* fillInterior(accepted, solved)
        }
        const groupSolutions = yield* solveBoundaryGroup(
          boundaryGroups[groupIndex]!,
          accepted,
        )
        for (const groupSolution of groupSolutions) {
          const result = yield* searchBoundaryGroups(
            groupIndex + 1,
            [...accepted, ...groupSolution],
            [...solved, ...groupSolution],
          )
          if (result) return result
        }
        return null
      }
      const boundarySolution = yield* searchBoundaryGroups(
        0,
        [...earlyRoutes],
        [],
      )
      if (boundarySolution?.length === residual.length) {
        const accepted = acceptCompleteCandidate([
          ...earlyRoutes,
          ...boundarySolution,
        ])
        yield {
          action: "commit_complete_topology",
          status: accepted ? "accepted" : "rejected",
          candidateId: `boundary-solution-${earlyCandidateIndex}`,
          reason: accepted ? undefined : "reconstructed_geometry_conflict",
        }
        if (accepted) {
          return
        }
      }
    }
    let bestForCandidate: RoutedNet[] = []
    const byRank = [...residual].sort(
      (first, second) =>
        first.rank - second.rank ||
        first.source.y - second.source.y ||
        compareCanonicalNetOrder(first, second),
    )
    const bySourceY = [...residual].sort(
      (first, second) =>
        first.source.y - second.source.y ||
        second.source.x - first.source.x ||
        first.rank - second.rank,
    )
    const packageCenterY = (model.padBounds.minY + model.padBounds.maxY) / 2
    const outerRowsDeepestFirst = [...residual].sort(
      (first, second) =>
        Math.abs(second.source.y - packageCenterY) -
          Math.abs(first.source.y - packageCenterY) ||
        first.source.y - second.source.y ||
        first.source.x - second.source.x ||
        first.rank - second.rank,
    )
    const nestedPortalTargets = new Map<string, number>()
    const usedPortalYs: number[] = []
    const routesBySourceRow = new Map<number, FanoutNet[]>()
    for (const route of residual) {
      const routes = routesBySourceRow.get(Q(route.source.y)) ?? []
      routes.push(route)
      routesBySourceRow.set(Q(route.source.y), routes)
    }
    const orderedRows = [...routesBySourceRow.values()].sort(
      (first, second) =>
        Math.abs(second[0]!.source.y - packageCenterY) -
          Math.abs(first[0]!.source.y - packageCenterY) ||
        first[0]!.source.y - second[0]!.source.y,
    )
    for (const rowRoutes of orderedRows) {
      const ordered = [...rowRoutes].sort(
        (first, second) =>
          first.source.x - second.source.x || first.rank - second.rank,
      )
      const outwardSign = Math.sign(ordered[0]!.source.y - packageCenterY || 1)
      const firstLaneOffset =
        ordered.length - (ordered.length % 2 === 0 ? 1 : 0)
      for (let index = 0; index < ordered.length; index++) {
        const desiredY =
          ordered[index]!.source.y +
          outwardSign * (firstLaneOffset - index * 2) * stepY
        const portalY = [...ys]
          .filter((y) =>
            usedPortalYs.every(
              (usedY) =>
                Math.abs(usedY - y) + EPS >=
                tracePairCenterDistance(model.rules),
            ),
          )
          .sort(
            (first, second) =>
              Math.abs(first - desiredY) - Math.abs(second - desiredY),
          )[0]
        if (portalY === undefined) continue
        nestedPortalTargets.set(ordered[index]!.connectionName, portalY)
        usedPortalYs.push(portalY)
      }
    }
    const routeOrders = [
      [...residual].sort((first, second) => {
        const priorityNames = new Set(
          earlyRoutes.flatMap((route) => route.residualPriorityNames ?? []),
        )
        return (
          Number(priorityNames.has(second.connectionName)) -
            Number(priorityNames.has(first.connectionName)) ||
          first.rank - second.rank ||
          first.source.y - second.source.y
        )
      }),
      byRank,
      bySourceY,
      [...bySourceY].reverse(),
      ...seededOrders(residual, 32, 0x62a10e11),
    ]
    const routeAttempts = [
      {
        order: outerRowsDeepestFirst,
        portalSeed: -1,
        portalTargets: nestedPortalTargets,
      },
      ...routeOrders.flatMap((order, orderIndex) => [
        { order, portalSeed: 0, portalTargets: undefined },
        { order, portalSeed: orderIndex + 1, portalTargets: undefined },
      ]),
    ]
    for (
      let routeAttemptIndex = 0;
      routeAttemptIndex < routeAttempts.length;
      routeAttemptIndex++
    ) {
      const { order, portalSeed, portalTargets } =
        routeAttempts[routeAttemptIndex]!
      const accepted = [...earlyRoutes]
      const solved: RoutedNet[] = []
      for (const net of order) {
        const route = yield* routeOne(
          net,
          accepted,
          portalSeed,
          portalTargets?.get(net.connectionName),
        )
        if (!route) continue
        accepted.push(route)
        solved.push(route)
      }
      yield {
        action: "complete_top_route_attempt",
        status: solved.length === residual.length ? "accepted" : "rejected",
        processed: routeAttemptIndex + 1,
        total: routeAttempts.length,
        reason:
          solved.length === residual.length
            ? undefined
            : `routed_${solved.length}_of_${residual.length}`,
      }
      if (solved.length > bestForCandidate.length) bestForCandidate = solved
      if (bestForCandidate.length === residual.length) break
    }
    if (bestForCandidate.length < residual.length && atomicGroupingIsValid) {
      // Greedy routing reveals the small coupled ViaLine groups that need to
      // escape together. Re-route only those groups atomically, then fill the
      // uncoupled residuals. This keeps the search bounded while preventing a
      // locally valid first route from sealing the package-edge lane needed by
      // its two- or three-route partner.
      const greedilySolvedNames = new Set(
        bestForCandidate.map((route) => route.connectionName),
      )
      const missingNames = new Set(
        residual
          .filter((route) => !greedilySolvedNames.has(route.connectionName))
          .map((route) => route.connectionName),
      )
      const repairGroups = atomicGroups.filter((group) =>
        group.some((route) => missingNames.has(route.connectionName)),
      )
      const repairNames = new Set(
        repairGroups.flatMap((group) =>
          group.map((route) => route.connectionName),
        ),
      )
      const uncoupled = residual.filter(
        (route) => !repairNames.has(route.connectionName),
      )
      let exploredRepairStates = 0
      const fillUncoupled = function* (
        accepted: RoutedNet[],
        atomicSolved: RoutedNet[],
      ): Generator<ReferenceSearchStep, RoutedNet[] | null> {
        const orders = [
          [...uncoupled].sort(
            (first, second) =>
              first.rank - second.rank ||
              first.source.y - second.source.y ||
              first.source.x - second.source.x,
          ),
          [...uncoupled].sort(
            (first, second) =>
              first.source.y - second.source.y || first.rank - second.rank,
          ),
          ...seededOrders(uncoupled, 6, 0xa7011c5),
        ]
        for (let orderIndex = 0; orderIndex < orders.length; orderIndex++) {
          const trialAccepted = [...accepted]
          const solved = [...atomicSolved]
          for (const route of orders[orderIndex]!) {
            const routed = yield* routeOne(
              route,
              trialAccepted,
              orderIndex === 0 ? 0 : orderIndex,
            )
            if (!routed) continue
            trialAccepted.push(routed)
            solved.push(routed)
          }
          if (solved.length > bestForCandidate.length) {
            bestForCandidate = solved
          }
          if (solved.length === residual.length) return solved
        }
        return null
      }
      const searchRepairGroups = function* (
        groupIndex: number,
        accepted: RoutedNet[],
        solved: RoutedNet[],
      ): Generator<ReferenceSearchStep, RoutedNet[] | null> {
        if (++exploredRepairStates > 32) return null
        yield {
          action: "search_atomic_repair_group",
          status: "candidate",
          processed: exploredRepairStates,
          total: 32,
        }
        if (groupIndex === repairGroups.length) {
          return yield* fillUncoupled(accepted, solved)
        }
        const groupSolutions = yield* solveAtomicGroup(
          repairGroups[groupIndex]!,
          accepted,
        )
        for (const groupSolution of groupSolutions) {
          const result = yield* searchRepairGroups(
            groupIndex + 1,
            [...accepted, ...groupSolution],
            [...solved, ...groupSolution],
          )
          if (result) return result
        }
        return null
      }
      const repaired = yield* searchRepairGroups(0, [...earlyRoutes], [])
      if (repaired?.length === residual.length) {
        const accepted = acceptCompleteCandidate([...earlyRoutes, ...repaired])
        yield {
          action: "commit_complete_topology",
          status: accepted ? "accepted" : "rejected",
          candidateId: `repair-solution-${earlyCandidateIndex}`,
          reason: accepted ? undefined : "reconstructed_geometry_conflict",
        }
        if (accepted) return
      }
    }
    const total = earlyRoutes.length + bestForCandidate.length
    if (total > bestTotal) {
      bestTotal = total
      bestResidualCount = residual.length
      bestSolved = [...earlyRoutes, ...bestForCandidate]
    }
    if (bestForCandidate.length === residual.length) {
      const accepted = acceptCompleteCandidate([
        ...earlyRoutes,
        ...bestForCandidate,
      ])
      yield {
        action: "commit_complete_topology",
        status: accepted ? "accepted" : "rejected",
        candidateId: `best-solution-${earlyCandidateIndex}`,
        reason: accepted ? undefined : "reconstructed_geometry_conflict",
      }
      if (accepted) {
        return
      }
    }
  }

  const missingNets = model.nets.filter(
    (net) =>
      !bestSolved.some((route) => route.connectionName === net.connectionName),
  )
  const missing = missingNets[0]!
  if (bestTotal === model.nets.length && lastViaLineError) {
    throw lastViaLineError
  }
  throw phaseError(
    "route_top_layer_dogbones",
    missing.connectionName,
    "no early-drop arrangement leaves a complete legal escape topology (" +
      bestTotal +
      "/" +
      model.nets.length +
      " total; best residual set " +
      (bestTotal - (model.nets.length - bestResidualCount)) +
      "/" +
      bestResidualCount +
      "; missing " +
      JSON.stringify(
        missingNets.map((net) => ({
          connectionName: net.connectionName,
          source: net.source,
          freeSpaceDistance: net.rank,
        })),
      ) +
      "; early " +
      JSON.stringify(
        bestSolved
          .filter((route) => route.kind === "early")
          .map((route) => ({
            connectionName: route.connectionName,
            source: route.source,
            via: route.via,
          })),
      ) +
      "; residual " +
      JSON.stringify(
        bestSolved
          .filter((route) => route.kind === "residual")
          .map((route) => ({
            connectionName: route.connectionName,
            source: route.source,
            topPath: route.topPath,
          })),
      ) +
      ")",
  )
}

const routeResidualTopDogbones = (model: GeometryModel) => {
  for (const _step of routeResidualTopDogbonesSteps(model)) {
    // Drain the same incremental implementation for legacy synchronous calls.
  }
}

const chunkSizes = (count: number) => {
  if (count < 2) return []
  const sizes: number[] = []
  let remaining = count
  if (remaining % 3 === 1) {
    sizes.push(2, 2)
    remaining -= 4
  } else if (remaining % 3 === 2) {
    sizes.push(2)
    remaining -= 2
  }
  while (remaining > 0) {
    sizes.push(3)
    remaining -= 3
  }
  return sizes
}

const MAX_SELECTIVE_VIA_CANDIDATES_PER_ROUTE = 32
const MAX_SELECTIVE_VIA_SEARCH_NODES = 16_384

const placeSelectiveResidualVias = (
  model: GeometryModel,
  residual: RoutedNet[],
) => {
  if (model.routeHints.size === 0) {
    return {
      placed: false,
      explored: 0,
      candidateCounts: {},
      blockingSignalNames: [] as string[],
    }
  }
  const minimumOutwardX = Q(
    model.padBounds.maxX +
      model.rules.viaDiameter / 2 +
      model.rules.viaToPadClearance,
  )
  const maximumOutwardX = Q(
    model.routingBounds.maxX - model.rules.viaDiameter / 2,
  )
  const minimumY = Q(model.routingBounds.minY + model.rules.viaDiameter / 2)
  const maximumY = Q(model.routingBounds.maxY - model.rules.viaDiameter / 2)
  const stepX = Math.max(model.pitchX / 2, model.rules.viaToViaCenter)
  const stepY = Math.max(model.pitchY / 2, model.rules.viaToViaCenter)
  const fixedRoutes = model.routes.filter((route) => route.kind === "early")
  type Candidate = { route: RoutedNet; addedLength: number; movement: number }
  const candidatesByName = new Map<string, Candidate[]>()
  const minimumBlockersByName = new Map<string, string[]>()
  const reroutedNames = new Set(model.nets.map((net) => net.connectionName))
  const signalBlockers = (
    route: RoutedNet,
    topPath: readonly Point[],
    via: Point,
  ) => {
    const blockers: string[] = []
    for (const other of model.routeHints.values()) {
      if (
        other.connectionName === route.connectionName ||
        reroutedNames.has(other.connectionName)
      ) {
        continue
      }
      const pathConflicts = pathSegments(topPath).some(
        (segment) =>
          pathSegments(other.topPath).some(
            (otherSegment) =>
              segmentDistance(
                segment.a,
                segment.b,
                otherSegment.a,
                otherSegment.b,
              ) +
                EPS <
              tracePairCenterDistance(model.rules),
          ) ||
          pointSegmentDistance(other.via, segment.a, segment.b) + EPS <
            traceViaCenterDistance(model.rules),
      )
      const viaConflicts =
        distance(via, other.via) + EPS < model.rules.viaToViaCenter ||
        [...pathSegments(other.topPath), ...pathSegments(other.innerPath)].some(
          (segment) =>
            pointSegmentDistance(via, segment.a, segment.b) + EPS <
            traceViaCenterDistance(model.rules),
        )
      if (pathConflicts || viaConflicts) blockers.push(other.connectionName)
    }
    return blockers.sort()
  }
  const rememberBlockers = (connectionName: string, blockers: string[]) => {
    if (blockers.length === 0) return
    const previous = minimumBlockersByName.get(connectionName)
    if (
      !previous ||
      blockers.length < previous.length ||
      (blockers.length === previous.length &&
        blockers.join("|").localeCompare(previous.join("|")) < 0)
    ) {
      minimumBlockersByName.set(connectionName, blockers)
    }
  }
  for (const route of residual) {
    const hint = model.routeHints.get(route.connectionName)
    const portal = route.topPath.at(-1)!
    const points: Point[] = []
    const seen = new Set<string>()
    const addPoint = (point: Point) => {
      const candidate = { x: Q(point.x), y: Q(point.y) }
      const key = pointKey(candidate)
      if (
        seen.has(key) ||
        candidate.x < minimumOutwardX - EPS ||
        candidate.x > maximumOutwardX + EPS ||
        candidate.y < minimumY - EPS ||
        candidate.y > maximumY + EPS
      ) {
        return
      }
      seen.add(key)
      points.push(candidate)
    }
    if (hint) addPoint(hint.via)
    const xSeeds = [
      hint?.via.x ?? minimumOutwardX,
      Math.max(minimumOutwardX, portal.x),
      minimumOutwardX,
    ]
    const ySeeds = [hint?.via.y ?? portal.y, portal.y, route.source.y]
    for (const xSeed of xSeeds) {
      for (let xIndex = 0; xIndex <= 8; xIndex++) {
        const x = Math.max(minimumOutwardX, xSeed) + xIndex * stepX
        for (const ySeed of ySeeds) {
          for (let yIndex = 0; yIndex <= 5; yIndex++) {
            const offset = yIndex === 0 ? 0 : Math.ceil(yIndex / 2) * stepY
            addPoint({
              x,
              y: ySeed + (yIndex % 2 === 0 ? -offset : offset),
            })
          }
        }
      }
    }
    const candidates: Candidate[] = []
    if (hint) {
      const hintedRoute: RoutedNet = {
        ...route,
        topPath: hint.topPath.map((point) => ({ ...point })),
        via: { ...hint.via },
      }
      if (
        !topPathIsLegal(
          model,
          hintedRoute,
          hintedRoute.topPath,
          hintedRoute.via,
          fixedRoutes,
        )
      ) {
        rememberBlockers(
          route.connectionName,
          signalBlockers(route, hintedRoute.topPath, hintedRoute.via),
        )
      } else {
        candidates.push({ route: hintedRoute, addedLength: 0, movement: 0 })
      }
    }
    for (const via of points) {
      const extensionCandidates = [
        simplifyPath([portal, { x: via.x, y: portal.y }, via]),
        ...octilinearCandidates(portal, via),
      ]
      for (const extension of extensionCandidates) {
        const topPath = simplifyPath([...route.topPath, ...extension.slice(1)])
        const candidateRoute: RoutedNet = {
          ...route,
          topPath,
          via: { ...via },
        }
        if (!topPathIsLegal(model, route, topPath, via, fixedRoutes)) {
          rememberBlockers(
            route.connectionName,
            signalBlockers(route, topPath, via),
          )
          continue
        }
        candidates.push({
          route: candidateRoute,
          addedLength: pathSegments(extension).reduce(
            (sum, segment) => sum + distance(segment.a, segment.b),
            0,
          ),
          movement: hint ? distance(via, hint.via) : distance(via, portal),
        })
      }
    }
    candidates.sort(
      (first, second) =>
        first.movement - second.movement ||
        first.addedLength - second.addedLength ||
        first.route.via.x - second.route.via.x ||
        first.route.via.y - second.route.via.y ||
        JSON.stringify(first.route.topPath).localeCompare(
          JSON.stringify(second.route.topPath),
        ),
    )
    const uniqueCandidates = candidates.filter(
      (candidate, index, all) =>
        all.findIndex(
          (other) =>
            pointKey(other.route.via) === pointKey(candidate.route.via) &&
            JSON.stringify(other.route.topPath) ===
              JSON.stringify(candidate.route.topPath),
        ) === index,
    )
    candidatesByName.set(
      route.connectionName,
      uniqueCandidates.slice(0, MAX_SELECTIVE_VIA_CANDIDATES_PER_ROUTE),
    )
  }
  const ordered = [...residual].sort(
    (first, second) =>
      (candidatesByName.get(first.connectionName)?.length ?? 0) -
        (candidatesByName.get(second.connectionName)?.length ?? 0) ||
      compareCanonicalNetOrder(first, second),
  )
  const candidateCounts = Object.fromEntries(
    ordered.map((route) => [
      route.connectionName,
      candidatesByName.get(route.connectionName)?.length ?? 0,
    ]),
  )
  if (Object.values(candidateCounts).some((count) => count === 0)) {
    return {
      placed: false,
      explored: 0,
      candidateCounts,
      blockingSignalNames: [
        ...new Set(
          ordered.flatMap(
            (route) => minimumBlockersByName.get(route.connectionName) ?? [],
          ),
        ),
      ].sort(),
    }
  }
  let explored = 0
  let exhausted = false
  let solution: RoutedNet[] | undefined
  const viableCandidates = (route: RoutedNet, accepted: RoutedNet[]) =>
    (candidatesByName.get(route.connectionName) ?? []).filter((candidate) =>
      topPathIsLegal(
        model,
        candidate.route,
        candidate.route.topPath,
        candidate.route.via,
        [...fixedRoutes, ...accepted],
      ),
    )
  const search = (remaining: RoutedNet[], accepted: RoutedNet[]) => {
    if (solution) return
    if (++explored > MAX_SELECTIVE_VIA_SEARCH_NODES) {
      exhausted = true
      return
    }
    if (remaining.length === 0) {
      solution = accepted
      return
    }
    const rankedRemaining = remaining
      .map((route) => ({
        route,
        candidates: viableCandidates(route, accepted),
      }))
      .sort(
        (first, second) =>
          first.candidates.length - second.candidates.length ||
          compareCanonicalNetOrder(first.route, second.route),
      )
    const next = rankedRemaining[0]!
    if (next.candidates.length === 0) return
    const rest = remaining.filter(
      (route) => route.connectionName !== next.route.connectionName,
    )
    for (const candidate of next.candidates) {
      const nextAccepted = [...accepted, candidate.route]
      if (
        rest.some((route) => viableCandidates(route, nextAccepted).length === 0)
      ) {
        continue
      }
      search(rest, nextAccepted)
      if (solution) return
    }
  }
  search(ordered, [])
  if (!solution) {
    return {
      placed: false,
      explored,
      exhausted,
      candidateCounts,
      blockingSignalNames: [] as string[],
    }
  }
  const byName = new Map(solution.map((route) => [route.connectionName, route]))
  for (let index = 0; index < model.routes.length; index++) {
    const replacement = byName.get(model.routes[index]!.connectionName)
    if (replacement) model.routes[index] = replacement
  }
  return {
    placed: true,
    explored,
    exhausted,
    candidateCounts,
    blockingSignalNames: [] as string[],
  }
}

const buildResidualViaLines = (
  model: GeometryModel,
  getViaLineDepthRank: ViaLineDepthRanker,
  getViaLineVerticalDirection: ViaLineVerticalDirectionSelector,
  getViaLineSlotIndex: ViaLineSlotIndexer,
) => {
  const residual = model.routes.filter((route) => route.kind === "residual")
  if (residual.length === 0) return
  if (model.routeHints.size > 0) {
    const selective = placeSelectiveResidualVias(model, residual)
    if (selective.placed) return
    model.selectiveViaLineBlockingSignals = new Set(
      selective.blockingSignalNames,
    )
    throw phaseError(
      "build_residual_via_lines",
      "all",
      `bounded selective ViaLine search ${selective.exhausted ? "exhausted" : "found no compatible assignment"} after ${selective.explored} nodes; candidates ${JSON.stringify(selective.candidateCounts)}`,
    )
  }

  // Match the reference ViaLine phase: keep each bus atomic, order its edge
  // portals, and partition it into horizontal strings of two or three vias.
  const groups: RoutedNet[][] = []
  const groupedNames = new Set<string>()
  const addBusGroups = (routes: RoutedNet[]) => {
    if (routes.length === 0) return
    const ordered = [...routes].sort(
      (first, second) =>
        first.topPath[first.topPath.length - 1]!.y -
          second.topPath[second.topPath.length - 1]!.y ||
        first.rank - second.rank,
    )
    const sizes = chunkSizes(ordered.length)
    let offset = 0
    for (const size of sizes) {
      groups.push(ordered.slice(offset, offset + size))
      offset += size
    }
    if (offset !== ordered.length) {
      throw phaseError(
        "build_residual_via_lines",
        ordered[offset]!.connectionName,
        "bus leaves one residual route outside a 2–3-via string",
      )
    }
    for (const route of ordered) groupedNames.add(route.connectionName)
  }
  for (const bus of model.input.buses ?? []) {
    const names = new Set(bus.connectionNames)
    addBusGroups(residual.filter((route) => names.has(route.connectionName)))
  }
  const ungroupedByBus = new Map<string, RoutedNet[]>()
  for (const route of residual) {
    if (groupedNames.has(route.connectionName)) continue
    const routes = ungroupedByBus.get(route.busId) ?? []
    routes.push(route)
    ungroupedByBus.set(route.busId, routes)
  }
  for (const routes of ungroupedByBus.values()) addBusGroups(routes)

  const verticalPosition = (group: RoutedNet[]) =>
    Math.min(
      ...group.map((route) => route.topPath[route.topPath.length - 1]!.y),
    )
  const stableKey = (group: RoutedNet[]) =>
    group
      .map((route) => route.connectionName)
      .sort()
      .join("|")
  groups.sort(
    (first, second) =>
      verticalPosition(first) - verticalPosition(second) ||
      stableKey(first).localeCompare(stableKey(second)),
  )
  const viaLineDepthRanks = groups.map((_, groupIndex) =>
    getViaLineDepthRank(groupIndex, groups.length),
  )

  const slotPitch = Math.max(
    model.rules.viaToViaCenter,
    model.rules.viaDiameter + model.rules.traceClearance,
  )
  const edgeOffset =
    model.rules.viaDiameter / 2 +
    model.rules.traceToViaClearance +
    model.rules.traceWidth / 2 +
    Math.max(model.pitchX / 2, slotPitch / 2)
  const firstLineX = Q(model.padBounds.maxX + edgeOffset)
  const maximumSlots = Math.max(...groups.map((group) => group.length))
  const lineStride =
    (maximumSlots - 1) * slotPitch +
    Math.max(model.pitchX, model.rules.viaToViaCenter)
  const lineSpacing = Math.max(
    model.rules.viaToViaCenter,
    model.rules.viaToViaCenter + tracePairCenterDistance(model.rules),
  )
  const lineDrop = Math.max(
    model.pitchY / 2,
    traceViaCenterDistance(model.rules),
  )
  const groupPortalBounds = groups.map((group) => {
    const portalYs = group.map(
      (route) => route.topPath[route.topPath.length - 1]!.y,
    )
    return {
      minY: Math.min(...portalYs),
      maxY: Math.max(...portalYs),
      centerY: (Math.min(...portalYs) + Math.max(...portalYs)) / 2,
    }
  })
  const portalBundleMiddleY =
    (Math.min(...groupPortalBounds.map(({ centerY }) => centerY)) +
      Math.max(...groupPortalBounds.map(({ centerY }) => centerY))) /
    2
  const groupVerticalDirections = groupPortalBounds.map(({ centerY }) =>
    getViaLineVerticalDirection(centerY, portalBundleMiddleY),
  )
  const lineYs: number[] = []
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const bounds = groupPortalBounds[groupIndex]!
    const verticalDirection = groupVerticalDirections[groupIndex]!
    const desired =
      verticalDirection < 0 ? bounds.minY - lineDrop : bounds.maxY + lineDrop
    lineYs.push(
      Q(
        lineYs.length === 0
          ? Math.max(
              desired,
              model.routingBounds.minY + model.rules.viaDiameter / 2,
            )
          : Math.max(desired, lineYs[lineYs.length - 1]! + lineSpacing),
      ),
    )
  }
  const maximumLineY = model.routingBounds.maxY - model.rules.viaDiameter / 2
  if (lineYs[lineYs.length - 1]! > maximumLineY) {
    const shift = lineYs[lineYs.length - 1]! - maximumLineY
    for (let index = 0; index < lineYs.length; index++) {
      lineYs[index] = Q(lineYs[index]! - shift)
    }
  }
  const minimumLineY = model.routingBounds.minY + model.rules.viaDiameter / 2
  if (lineYs[0]! < minimumLineY - EPS) {
    throw phaseError(
      "build_residual_via_lines",
      "all",
      "SRJ routing bounds cannot hold the ordered horizontal ViaLines",
    )
  }

  const occupiedVias: Point[] = [
    ...model.previousVias,
    ...model.routes
      .filter((route) => route.kind === "early")
      .map((route) => route.via),
  ]
  const requiredMaxX = Math.max(
    ...groups.map(
      (group, groupIndex) =>
        firstLineX +
        viaLineDepthRanks[groupIndex]! * lineStride +
        (group.length - 1) * slotPitch +
        model.rules.viaDiameter / 2,
    ),
  )
  if (requiredMaxX > model.routingBounds.maxX + EPS) {
    throw phaseError(
      "build_residual_via_lines",
      "all",
      "SRJ routing maxX " +
        model.routingBounds.maxX.toFixed(6) +
        " mm is below the ordered ViaLine requirement " +
        requiredMaxX.toFixed(6) +
        " mm (" +
        groups.length +
        " bus-preserving strings; short by " +
        (requiredMaxX - model.routingBounds.maxX).toFixed(6) +
        " mm)",
    )
  }
  groups.forEach((group, groupIndex) => {
    const lineX = Q(firstLineX + viaLineDepthRanks[groupIndex]! * lineStride)
    const verticalDirection = groupVerticalDirections[groupIndex]!
    group.forEach((route, slotIndex) => {
      const mirroredSlotIndex = getViaLineSlotIndex(
        slotIndex,
        group.length,
        verticalDirection,
      )
      const via = {
        x: Q(lineX + mirroredSlotIndex * slotPitch),
        y: lineYs[groupIndex]!,
      }
      if (
        via.x + model.rules.viaDiameter / 2 > model.routingBounds.maxX + EPS ||
        via.y - model.rules.viaDiameter / 2 < model.routingBounds.minY - EPS ||
        via.y + model.rules.viaDiameter / 2 > model.routingBounds.maxY + EPS
      ) {
        throw phaseError(
          "build_residual_via_lines",
          route.connectionName,
          "SRJ routing maxX " +
            model.routingBounds.maxX.toFixed(6) +
            " mm is below the ordered ViaLine requirement " +
            (via.x + model.rules.viaDiameter / 2).toFixed(6) +
            " mm (" +
            groups.length +
            " bus-preserving strings)",
        )
      }
      if (
        padEdgeDistance(model, via) + EPS <
        model.rules.viaDiameter / 2 + model.rules.viaToPadClearance
      ) {
        throw phaseError(
          "build_residual_via_lines",
          route.connectionName,
          "ViaLine slot overlaps a BGA pad or violates its clearance",
        )
      }
      if (
        occupiedVias.some(
          (other) => distance(via, other) + EPS < model.rules.viaToViaCenter,
        )
      ) {
        throw phaseError(
          "build_residual_via_lines",
          route.connectionName,
          "ViaLine slot violates through-via clearance",
        )
      }
      route.via = via
      route.viaLineId = `residual-${route.busId}-${groupIndex}`
      occupiedVias.push(via)
    })
  })

  for (const group of groups) {
    for (const route of group) {
      const portal = route.topPath[route.topPath.length - 1]!
      const elbow = { x: route.via.x, y: portal.y }
      const extension = simplifyPath([portal, elbow, route.via])
      const completeTopPath = simplifyPath([
        ...route.topPath,
        ...extension.slice(1),
      ])
      if (
        !topPathIsLegal(
          model,
          route,
          completeTopPath,
          route.via,
          model.routes.filter((other) => other !== route),
        )
      ) {
        throw phaseError(
          "build_residual_via_lines",
          route.connectionName,
          "deterministic outward-bending connection from the package-edge portal to its ViaLine slot is illegal",
        )
      }
      route.topPath = completeTopPath
    }
  }
}

const assignPreferredLayers = (model: GeometryModel) => {
  const routeByName = new Map(
    model.routes
      .filter((route) => route.target.layer === "top")
      .map((route) => [route.connectionName, route]),
  )
  const globalLayerLoads = new Map<string, number>()
  const multiLayerBuses = (model.input.buses ?? []).filter(
    (bus) =>
      !bus.preferredLayer &&
      bus.termination?.type !== "plane" &&
      (bus.preferredLayers?.length ?? 0) > 2,
  )
  const commonLayers = multiLayerBuses[0]?.preferredLayers
  if (
    commonLayers &&
    multiLayerBuses.length === (model.input.buses ?? []).length &&
    multiLayerBuses.every(
      (bus) =>
        JSON.stringify(bus.preferredLayers) === JSON.stringify(commonLayers),
    )
  ) {
    const lastTargetY = commonLayers.map(() => Number.NEGATIVE_INFINITY)
    const loads = commonLayers.map(() => 0)
    const routes = [...routeByName.values()].sort(
      (first, second) =>
        first.via.y - second.via.y || first.via.x - second.via.x,
    )
    for (const route of routes) {
      const layerIndex = commonLayers
        .map((_, index) => index)
        .filter((index) => route.target.y + EPS >= lastTargetY[index]!)
        .sort(
          (first, second) =>
            loads[first]! - loads[second]! ||
            lastTargetY[second]! - lastTargetY[first]! ||
            first - second,
        )[0]
      if (layerIndex === undefined) {
        throw phaseError(
          "build_residual_via_lines",
          route.connectionName,
          `target permutation needs more than ${commonLayers.length} prescribed layers`,
        )
      }
      route.selectedLayer = commonLayers[layerIndex]!
      lastTargetY[layerIndex] = route.target.y
      loads[layerIndex] = loads[layerIndex]! + 1
    }
    return
  }
  for (const bus of model.input.buses ?? []) {
    if (bus.preferredLayer || bus.termination?.type === "plane") continue
    const layers = bus.preferredLayers ?? bus.allowedLayers ?? []
    if (layers.length <= 1) continue
    const routes = bus.connectionNames
      .map((name) => routeByName.get(name))
      .filter((route): route is RoutedNet => Boolean(route))
      .sort(
        (first, second) =>
          first.via.y - second.via.y || first.via.x - second.via.x,
      )
    const assignment = new Map<string, number>()
    const lastTargetY = layers.map(() => Number.NEGATIVE_INFINITY)
    if (layers.length > 2) {
      for (const route of routes) {
        const eligible = layers
          .map((_, index) => index)
          .filter((index) => route.target.y + EPS >= lastTargetY[index]!)
          .sort(
            (first, second) =>
              (globalLayerLoads.get(layers[first]!) ?? 0) -
                (globalLayerLoads.get(layers[second]!) ?? 0) ||
              lastTargetY[second]! - lastTargetY[first]! ||
              first - second,
          )
        const layerIndex =
          eligible[0] ??
          layers
            .map((_, index) => index)
            .sort(
              (first, second) =>
                lastTargetY[first]! - lastTargetY[second]! || first - second,
            )[0]!
        assignment.set(route.connectionName, layerIndex)
        lastTargetY[layerIndex] = route.target.y
        globalLayerLoads.set(
          layers[layerIndex]!,
          (globalLayerLoads.get(layers[layerIndex]!) ?? 0) + 1,
        )
      }
      for (const route of routes) {
        route.selectedLayer = layers[assignment.get(route.connectionName) ?? 0]!
      }
      continue
    }
    const search = (routeIndex: number): boolean => {
      if (routeIndex === routes.length) return true
      const route = routes[routeIndex]!
      for (const layerIndex of layers.map((_, index) => index)) {
        if (route.target.y + EPS < lastTargetY[layerIndex]!) continue
        const previousLast = lastTargetY[layerIndex]!
        assignment.set(route.connectionName, layerIndex)
        lastTargetY[layerIndex] = route.target.y
        if (search(routeIndex + 1)) return true
        lastTargetY[layerIndex] = previousLast
        assignment.delete(route.connectionName)
      }
      return false
    }
    if (!search(0)) {
      // The target permutation can require limited weaving even after the
      // coordinated solver has supplied multiple layers. Keep the split
      // deterministic so mirrored breakouts choose identical layers.
      assignment.clear()
      bus.connectionNames.forEach((name, index) => {
        assignment.set(name, index % layers.length)
      })
    }
    for (const route of routes) {
      route.selectedLayer = layers[assignment.get(route.connectionName) ?? 0]!
    }
  }
}

const exhaustiveOrders = function* <T>(items: readonly T[]): Generator<T[]> {
  const order: T[] = []
  const used = new Uint8Array(items.length)

  const visit = function* (): Generator<T[]> {
    if (order.length === items.length) {
      yield [...order]
      return
    }

    for (let index = 0; index < items.length; index++) {
      if (used[index]) continue
      used[index] = 1
      order.push(items[index]!)
      yield* visit()
      order.pop()
      used[index] = 0
    }
  }

  yield* visit()
}

const seededOrders = function* <T>(
  items: readonly T[],
  attempts: number,
  seed: number,
): Generator<T[]> {
  let state = seed >>> 0
  const seenSchedules = new Set<string>()
  for (let attempt = 0; attempt < attempts; attempt++) {
    const orderIndexes = items.map((_, index) => index)
    if (attempt > 0) {
      for (let index = orderIndexes.length - 1; index > 0; index--) {
        const upperExclusive = index + 1
        const bucketSize = Math.floor(0x1_0000_0000 / upperExclusive)
        const usableStateCount = bucketSize * upperExclusive
        do {
          state = (state * 1664525 + 1013904223) >>> 0
        } while (state >= usableStateCount)
        const swap = Math.floor(state / bucketSize)
        ;[orderIndexes[index], orderIndexes[swap]] = [
          orderIndexes[swap]!,
          orderIndexes[index]!,
        ]
      }
    }
    const scheduleKey = orderIndexes.join(",")
    if (seenSchedules.has(scheduleKey)) continue
    seenSchedules.add(scheduleKey)
    yield orderIndexes.map((index) => items[index]!)
  }
}

const routeInnerLayersAtCurrentTargetsSteps = function* (
  model: GeometryModel,
): Generator<ReferenceSearchStep, void> {
  const routedLayers = [
    ...new Set(model.routes.map((route) => route.selectedLayer)),
  ]
  for (const layer of routedLayers) {
    const layerRoutes = model.routes.filter(
      (route) => route.selectedLayer === layer,
    )
    if (layer === "top") {
      for (const route of layerRoutes) {
        let extension: Point[] | undefined
        const candidates = octilinearCandidates(route.via, route.target)
        for (
          let candidateIndex = 0;
          candidateIndex < candidates.length;
          candidateIndex++
        ) {
          const candidate = candidates[candidateIndex]!
          const candidatePath = simplifyPath([
            ...route.topPath,
            ...candidate.slice(1),
          ])
          const legal = topPathIsLegal(
            model,
            route,
            candidatePath,
            route.via,
            model.routes.filter((other) => other !== route),
          )
          yield {
            action: "evaluate_top_layer_target_extension",
            status: legal ? "accepted" : "rejected",
            connectionName: route.connectionName,
            candidateId: `target_extension_${candidateIndex}`,
            reason: legal ? undefined : "top_layer_clearance",
            point: candidate.at(-1),
            searchStart: route.via,
            searchTarget: route.target,
            candidatePath,
            layer: "top",
          }
          if (legal) {
            extension = candidate
            break
          }
        }
        if (!extension) {
          throw phaseError(
            "route_prescribed_inner_layers",
            route.connectionName,
            "top-layer target cannot be reached with legal octilinear copper",
          )
        }
        route.topPath = simplifyPath([...route.topPath, ...extension.slice(1)])
        route.innerPath = [{ ...route.via }, { ...route.target }]
        yield {
          action: "commit_top_layer_target_extension",
          status: "accepted",
          connectionName: route.connectionName,
          point: route.target,
          searchStart: route.via,
          searchTarget: route.target,
          candidatePath: route.topPath,
          layer: "top",
          route: snapshotRoutedNet(route),
        }
      }
      continue
    }

    const step = Math.min(
      Math.min(model.pitchX, model.pitchY) / 2,
      tracePairCenterDistance(model.rules),
    )
    const regularXs: number[] = []
    const regularYs: number[] = []
    for (
      let x = Q(model.padBounds.minX - step);
      x <= model.routingBounds.maxX + EPS;
      x = Q(x + step)
    ) {
      regularXs.push(x)
    }
    for (
      let y = Q(model.routingBounds.minY);
      y <= model.routingBounds.maxY + EPS;
      y = Q(y + step)
    ) {
      regularYs.push(y)
    }
    const allVias = [
      ...model.previousVias.filter((via) =>
        viaTouchesLayer(via, layer, model.input.layerCount),
      ),
      ...model.routes
        .filter(() =>
          viaTouchesLayer(
            { fromLayer: "top", toLayer: "bottom" },
            layer,
            model.input.layerCount,
          ),
        )
        .map((route) => route.via),
    ]
    const canonicalLayerRoutes = [...layerRoutes].sort(compareCanonicalNetOrder)
    const routesByTargetY = [...canonicalLayerRoutes].sort(
      (first, second) =>
        first.target.y - second.target.y ||
        compareCanonicalNetOrder(first, second),
    )
    const xs = uniqueSorted([
      ...regularXs,
      ...layerRoutes.flatMap((route) => [route.via.x, route.target.x]),
    ])
    const ys = uniqueSorted([
      ...regularYs,
      ...layerRoutes.flatMap((route) => [route.via.y, route.target.y]),
    ])
    const xIndex = new Map(xs.map((value, index) => [Q(value), index]))
    const yIndex = new Map(ys.map((value, index) => [Q(value), index]))
    let best: Array<{ route: RoutedNet; path: Point[] }> = []
    const constrainedOrders = [
      routesByTargetY,
      [...routesByTargetY].reverse(),
      ...seededOrders(canonicalLayerRoutes, 64, 0x62a10000 + layer.length),
    ]
    let unconstrainedOrders: Iterable<RoutedNet[]>
    if (canonicalLayerRoutes.length <= 6) {
      unconstrainedOrders = exhaustiveOrders(canonicalLayerRoutes)
    } else {
      unconstrainedOrders = seededOrders(
        canonicalLayerRoutes,
        512,
        0x62a1f000 + layer.length,
      )
    }
    for (const [useTargetBands, layerRouteOrders] of [
      [true, constrainedOrders],
      [false, unconstrainedOrders],
    ] as const) {
      for (const order of layerRouteOrders) {
        const accepted: Array<{ route: RoutedNet; path: Point[] }> = []
        for (const route of order) {
          const startXi = xIndex.get(Q(route.via.x))
          const startYi = yIndex.get(Q(route.via.y))
          if (startXi === undefined || startYi === undefined) {
            yield {
              action: "route_inner_layer_connection",
              status: "rejected",
              connectionName: route.connectionName,
              reason: "start_outside_search_grid",
              searchStart: route.via,
              searchTarget: route.target,
              layer,
            }
            continue
          }
          const occupiedSegments = [
            ...model.previousSegments.filter(
              (segment) =>
                segment.layer === layer &&
                segment.connectionName !== route.connectionName,
            ),
            ...accepted.flatMap((item) =>
              pathSegments(item.path).map((segment) => ({ ...segment, layer })),
            ),
          ]
          const otherVias = allVias.filter(
            (via) => distance(via, route.via) > EPS,
          )
          const routeIndex = routesByTargetY.indexOf(route)
          const previousRoute = routesByTargetY[routeIndex - 1]
          const nextRoute = routesByTargetY[routeIndex + 1]
          const referenceY = (referenceRoute: RoutedNet, x: number) => {
            const span = referenceRoute.target.x - referenceRoute.via.x
            if (Math.abs(span) <= EPS) return referenceRoute.target.y
            const progress = clamp((x - referenceRoute.via.x) / span, 0, 1)
            return (
              referenceRoute.via.y +
              (referenceRoute.target.y - referenceRoute.via.y) * progress
            )
          }
          const path = yield* findGridPathSteps({
            xs,
            ys,
            starts: [
              {
                point: {
                  x: route.via.x,
                  y: route.via.y,
                  xi: startXi,
                  yi: startYi,
                },
                initialCost: 0,
              },
            ],
            isGoal: (point) => distance(point, route.target) <= EPS,
            pointAllowed: (point) => {
              const routeReferenceY = referenceY(route, point.x)
              const minimumY =
                useTargetBands && previousRoute
                  ? (referenceY(previousRoute, point.x) + routeReferenceY) / 2
                  : model.routingBounds.minY
              const maximumY =
                useTargetBands && nextRoute
                  ? (routeReferenceY + referenceY(nextRoute, point.x)) / 2
                  : model.routingBounds.maxY
              return (
                point.x >= model.routingBounds.minX - EPS &&
                point.x <= model.routingBounds.maxX + EPS &&
                point.y >= minimumY - EPS &&
                point.y <= maximumY + EPS &&
                (distance(point, route.target) <= EPS ||
                  otherVias.every(
                    (via) =>
                      distance(point, via) + EPS >=
                      traceViaCenterDistance(model.rules),
                  ))
              )
            },
            segmentAllowed: (a, b) =>
              otherVias.every(
                (via) =>
                  pointSegmentDistance(via, a, b) + EPS >=
                  traceViaCenterDistance(model.rules),
              ) &&
              occupiedSegments.every(
                (segment) =>
                  segmentDistance(a, b, segment.a, segment.b) + EPS >=
                  tracePairCenterDistance(model.rules),
              ),
            heuristic: (point) =>
              Math.abs(route.target.x - point.x) +
              Math.abs(route.target.y - point.y) +
              Math.max(0, point.x - route.target.x) * 0.2,
            visualization: {
              actionScope: "inner_layer",
              connectionName: route.connectionName,
              layer,
              startPoint: route.via,
              targetPoint: route.target,
            },
          })
          if (path) {
            accepted.push({ route, path })
            yield {
              action: "route_inner_layer_connection",
              status: "accepted",
              connectionName: route.connectionName,
              point: path.at(-1),
              searchStart: route.via,
              searchTarget: route.target,
              candidatePath: path,
              layer,
              route: {
                ...snapshotRoutedNet(route),
                innerPath: path.map((point) => ({ ...point })),
              },
            }
          } else {
            yield {
              action: "route_inner_layer_connection",
              status: "rejected",
              connectionName: route.connectionName,
              reason: "no_legal_grid_path",
              searchStart: route.via,
              searchTarget: route.target,
              layer,
            }
          }
        }
        const improved = accepted.length > best.length
        if (improved) best = accepted
        yield {
          action: "complete_inner_layer_order",
          status: improved ? "accepted" : "rejected",
          reason: improved ? "new_best_schedule" : "not_better_than_best",
          processed: accepted.length,
          total: layerRoutes.length,
          layer,
        }
        if (best.length === layerRoutes.length) break
      }
      if (best.length === layerRoutes.length) break
    }
    if (best.length !== layerRoutes.length) {
      const missing = layerRoutes.find(
        (route) => !best.some((item) => item.route === route),
      )!
      throw phaseError(
        "route_prescribed_inner_layers",
        missing.connectionName,
        `${layer} exact target routing solved ${best.length}/${layerRoutes.length} connections; ${JSON.stringify(
          layerRoutes.map((route) => ({
            connectionName: route.connectionName,
            via: route.via,
            target: route.target,
          })),
        )}`,
      )
    }
    for (let itemIndex = 0; itemIndex < best.length; itemIndex++) {
      const item = best[itemIndex]!
      item.route.innerPath = item.path
      yield {
        action: "commit_inner_layer_route",
        status: "accepted",
        connectionName: item.route.connectionName,
        processed: itemIndex + 1,
        total: best.length,
        point: item.path.at(-1),
        searchStart: item.route.via,
        searchTarget: item.route.target,
        candidatePath: item.path,
        layer,
        route: snapshotRoutedNet(item.route),
      }
    }
  }
}

const minimumDistinctTargetSpacing = (routes: readonly RoutedNet[]) => {
  const ys = uniqueSorted(routes.map((route) => route.target.y))
  let minimum = Number.POSITIVE_INFINITY
  for (let index = 1; index < ys.length; index++) {
    const spacing = ys[index]! - ys[index - 1]!
    if (spacing > EPS) minimum = Math.min(minimum, spacing)
  }
  return minimum
}

const innerPathIsLegal = (
  model: GeometryModel,
  route: RoutedNet,
  path: readonly Point[],
  pathsByName: ReadonlyMap<string, readonly Point[]>,
) => {
  if (
    path.length < 2 ||
    distance(path[0]!, route.via) > EPS ||
    distance(path.at(-1)!, route.target) > EPS
  ) {
    return false
  }
  const segments = pathSegments(path)
  if (
    segments.some(
      (segment) =>
        !isOctilinear(segment.a, segment.b) ||
        segment.a.x < model.routingBounds.minX - EPS ||
        segment.a.x > model.routingBounds.maxX + EPS ||
        segment.a.y < model.routingBounds.minY - EPS ||
        segment.a.y > model.routingBounds.maxY + EPS ||
        segment.b.x < model.routingBounds.minX - EPS ||
        segment.b.x > model.routingBounds.maxX + EPS ||
        segment.b.y < model.routingBounds.minY - EPS ||
        segment.b.y > model.routingBounds.maxY + EPS,
    )
  ) {
    return false
  }
  const blockingSegments = [
    ...model.previousSegments.filter(
      (segment) =>
        segment.layer === route.selectedLayer &&
        segment.connectionName !== route.connectionName,
    ),
    ...[...pathsByName.entries()]
      .filter(
        ([connectionName]) =>
          connectionName !== route.connectionName &&
          model.routes.find((other) => other.connectionName === connectionName)
            ?.selectedLayer === route.selectedLayer,
      )
      .flatMap(([connectionName, otherPath]) =>
        pathSegments(otherPath).map((segment) => ({
          ...segment,
          layer: route.selectedLayer,
          connectionName,
        })),
      ),
  ]
  const blockingVias = [
    ...model.previousVias.filter((via) =>
      viaTouchesLayer(via, route.selectedLayer, model.input.layerCount),
    ),
    ...model.routes
      .filter((other) => other.connectionName !== route.connectionName)
      .map((other) => other.via),
  ]
  return segments.every(
    (segment) =>
      blockingSegments.every(
        (other) =>
          segmentDistance(segment.a, segment.b, other.a, other.b) + EPS >=
          tracePairCenterDistance(model.rules),
      ) &&
      blockingVias.every(
        (via) =>
          pointSegmentDistance(via, segment.a, segment.b) + EPS >=
          traceViaCenterDistance(model.rules),
      ),
  )
}

/**
 * Normalize a selectively repaired inner tail before it is committed. Ordinary
 * routes are mitered by the later pipeline stage; repaired tails must also prove
 * that every new right-angle replacement is legal against the frozen geometry,
 * otherwise the bounded repair search must try its next candidate.
 */
const normalizeRepairedInnerPath = (
  model: GeometryModel,
  route: RoutedNet,
  path: readonly Point[],
  occupiedPaths: ReadonlyMap<string, readonly Point[]>,
): Point[] | undefined => {
  const blockingSegments = [
    ...model.previousSegments.filter(
      (segment) =>
        segment.layer === route.selectedLayer &&
        segment.connectionName !== route.connectionName,
    ),
    ...[...occupiedPaths.entries()]
      .filter(
        ([connectionName]) =>
          connectionName !== route.connectionName &&
          model.routes.find((other) => other.connectionName === connectionName)
            ?.selectedLayer === route.selectedLayer,
      )
      .flatMap(([connectionName, otherPath]) =>
        pathSegments(otherPath).map((segment) => ({
          ...segment,
          layer: route.selectedLayer,
          connectionName,
        })),
      ),
  ]
  const blockingVias = [
    ...model.previousVias.filter((via) =>
      viaTouchesLayer(via, route.selectedLayer, model.input.layerCount),
    ),
    ...model.routes
      .filter((other) => other.connectionName !== route.connectionName)
      .map((other) => other.via),
  ]
  const normalized = miterRightAngleTurns(
    path,
    model.rules,
    (start, end) =>
      blockingSegments.every(
        (segment) =>
          segmentDistance(start, end, segment.a, segment.b) + EPS >=
          tracePairCenterDistance(model.rules),
      ) &&
      blockingVias.every(
        (via) =>
          pointSegmentDistance(via, start, end) + EPS >=
          traceViaCenterDistance(model.rules),
      ),
  )
  if (
    normalized.some(
      (point, index) =>
        index > 0 &&
        index < normalized.length - 1 &&
        isRightAngleTurn(normalized[index - 1]!, point, normalized[index + 1]!),
    ) ||
    !innerPathIsLegal(model, route, normalized, occupiedPaths)
  ) {
    return undefined
  }
  return normalized
}

const MAX_LOCAL_TARGET_REPAIR_ROUTES = 8
const MAX_LOCAL_TARGET_REPAIR_ORDERS = 16
const MAX_LOCAL_TARGET_REPAIR_PIVOTS = 16
const MAX_LOCAL_TARGET_REPAIR_GRID_EVENTS = 250_000
const MAX_LOCAL_VIA_RELOCATION_STEPS = 6
const MAX_LOCAL_VIA_RELOCATION_PIVOTS = 12

const relocateExpandedTargetBlockingVias = (
  model: GeometryModel,
  blockingRouteNames: ReadonlySet<string>,
) => {
  const relocated: string[] = []
  for (const connectionName of [...blockingRouteNames].sort()) {
    const route = model.routes.find(
      (candidate) => candidate.connectionName === connectionName,
    )
    if (!route) continue
    const step = Math.max(
      model.rules.viaToViaCenter,
      traceViaCenterDistance(model.rules),
    )
    const sites = generateBoundedSignalViaRelocationSites({
      origin: route.via,
      step,
      maximumSteps: MAX_LOCAL_VIA_RELOCATION_STEPS,
    })
    let selected: { via: Point; topPath: Point[] } | undefined
    for (const via of sites) {
      const radius = model.rules.viaDiameter / 2
      if (
        via.x - radius < model.routingBounds.minX - EPS ||
        via.x + radius > model.routingBounds.maxX + EPS ||
        via.y - radius < model.routingBounds.minY - EPS ||
        via.y + radius > model.routingBounds.maxY + EPS ||
        padEdgeDistance(model, via) + EPS <
          radius + model.rules.viaToPadClearance ||
        model.routes.some(
          (other) =>
            other.connectionName !== route.connectionName &&
            distance(via, other.via) + EPS < model.rules.viaToViaCenter,
        ) ||
        model.routes.some(
          (other) =>
            other.connectionName !== route.connectionName &&
            distance(via, other.target) + EPS <
              traceViaCenterDistance(model.rules),
        ) ||
        model.routes.some(
          (other) =>
            other.connectionName !== route.connectionName &&
            pathSegments(other.innerPath).some(
              (segment) =>
                pointSegmentDistance(via, segment.a, segment.b) + EPS <
                traceViaCenterDistance(model.rules),
            ),
        )
      ) {
        continue
      }
      const minimumPivot = Math.max(
        0,
        route.topPath.length - MAX_LOCAL_VIA_RELOCATION_PIVOTS,
      )
      const pathCandidates: Point[][] = []
      for (
        let pivotIndex = route.topPath.length - 2;
        pivotIndex >= minimumPivot;
        pivotIndex--
      ) {
        const prefix = route.topPath.slice(0, pivotIndex + 1)
        const pivot = prefix.at(-1)!
        for (const tail of octilinearCandidates(pivot, via)) {
          pathCandidates.push(simplifyPath([...prefix, ...tail.slice(1)]))
        }
      }
      const topPath = [
        ...new Map(
          pathCandidates.map((path) => [JSON.stringify(path), path]),
        ).values(),
      ]
        .sort(
          (first, second) =>
            pathSegments(first).reduce(
              (sum, segment) => sum + distance(segment.a, segment.b),
              0,
            ) -
              pathSegments(second).reduce(
                (sum, segment) => sum + distance(segment.a, segment.b),
                0,
              ) || JSON.stringify(first).localeCompare(JSON.stringify(second)),
        )
        .find((path) =>
          topPathIsLegal(
            model,
            route,
            path,
            via,
            model.routes.filter(
              (other) => other.connectionName !== route.connectionName,
            ),
          ),
        )
      if (topPath) {
        selected = { via, topPath }
        break
      }
    }
    if (!selected) {
      throw phaseError(
        "route_prescribed_inner_layers",
        route.connectionName,
        "bounded all-direction signal ViaLine relocation found no legal site",
      )
    }
    route.via = selected.via
    route.topPath = selected.topPath
    relocated.push(route.connectionName)
  }
  return relocated
}

const repairExpandedTargetPaths = (
  model: GeometryModel,
  actualTargets: ReadonlyMap<string, Point & { layer: string }>,
) => {
  for (const route of model.routes) {
    const target = actualTargets.get(route.connectionName)
    if (!target) {
      throw phaseError(
        "route_prescribed_inner_layers",
        route.connectionName,
        "expanded-target adaptation lost the exact fixed target",
      )
    }
    route.target = { ...route.target, ...target }
  }
  const candidatePaths = new Map(
    model.routes.map((route) => [
      route.connectionName,
      simplifyPath([...route.innerPath, { ...route.target }]),
    ]),
  )
  const reusableNames = new Set<string>()
  for (const route of model.routes) {
    const path = candidatePaths.get(route.connectionName)!
    if (!innerPathIsLegal(model, route, path, candidatePaths)) continue
    const normalized = normalizeRepairedInnerPath(
      model,
      route,
      path,
      candidatePaths,
    )
    if (!normalized) continue
    candidatePaths.set(route.connectionName, normalized)
    reusableNames.add(route.connectionName)
  }
  const initiallyAffected = model.routes.filter(
    (route) => !reusableNames.has(route.connectionName),
  )
  const blockingViaRouteNames = new Set<string>()
  for (const route of initiallyAffected) {
    const path = candidatePaths.get(route.connectionName)!
    for (const other of model.routes) {
      if (other.connectionName === route.connectionName) continue
      if (
        pathSegments(path).some(
          (segment) =>
            pointSegmentDistance(other.via, segment.a, segment.b) + EPS <
            traceViaCenterDistance(model.rules),
        )
      ) {
        blockingViaRouteNames.add(other.connectionName)
      }
    }
  }
  const relocatedViaRouteNames = relocateExpandedTargetBlockingVias(
    model,
    blockingViaRouteNames,
  )
  const affectedNames = new Set([
    ...initiallyAffected.map((route) => route.connectionName),
    ...relocatedViaRouteNames,
  ])
  const affected = model.routes.filter((route) =>
    affectedNames.has(route.connectionName),
  )
  if (affected.length > MAX_LOCAL_TARGET_REPAIR_ROUTES) {
    throw phaseError(
      "route_prescribed_inner_layers",
      "all",
      `expanded-target local repair needs ${affected.length} routes, above bounded limit ${MAX_LOCAL_TARGET_REPAIR_ROUTES}`,
    )
  }
  const frozenPaths = new Map(
    [...candidatePaths.entries()].filter(
      ([name]) => reusableNames.has(name) && !affectedNames.has(name),
    ),
  )
  let repairSearchAttempts = 0
  const repairedNames: string[] = []
  const affectedByLayer = new Map<string, RoutedNet[]>()
  for (const route of affected) {
    const group = affectedByLayer.get(route.selectedLayer) ?? []
    group.push(route)
    affectedByLayer.set(route.selectedLayer, group)
  }
  for (const layerRoutes of affectedByLayer.values()) {
    const canonical = [...layerRoutes].sort(
      (first, second) =>
        first.target.y - second.target.y ||
        compareCanonicalNetOrder(first, second),
    )
    const orders = [
      canonical,
      [...canonical].reverse(),
      ...seededOrders(
        canonical,
        Math.max(0, MAX_LOCAL_TARGET_REPAIR_ORDERS - 2),
        0x62a12500 + canonical.length,
      ),
    ].slice(0, MAX_LOCAL_TARGET_REPAIR_ORDERS)
    let layerSolution:
      | Map<string, { route: RoutedNet; path: Point[] }>
      | undefined
    for (const order of orders) {
      const accepted = new Map<string, { route: RoutedNet; path: Point[] }>()
      const occupiedPaths = new Map(frozenPaths)
      for (const route of order) {
        const pathVariants: Point[][] = []
        const minimumPivot = Math.max(
          0,
          route.innerPath.length - MAX_LOCAL_TARGET_REPAIR_PIVOTS,
        )
        for (
          let pivotIndex = route.innerPath.length - 1;
          pivotIndex >= minimumPivot;
          pivotIndex--
        ) {
          const prefix = route.innerPath.slice(0, pivotIndex + 1)
          const pivot = prefix.at(-1)!
          for (const tail of octilinearCandidates(pivot, route.target)) {
            pathVariants.push(simplifyPath([...prefix, ...tail.slice(1)]))
          }
        }
        const uniqueVariants = [
          ...new Map(
            pathVariants.map((path) => [JSON.stringify(path), path]),
          ).values(),
        ].sort(
          (first, second) =>
            pathSegments(first).reduce(
              (sum, segment) => sum + distance(segment.a, segment.b),
              0,
            ) -
              pathSegments(second).reduce(
                (sum, segment) => sum + distance(segment.a, segment.b),
                0,
              ) || JSON.stringify(first).localeCompare(JSON.stringify(second)),
        )
        let selected: Point[] | undefined
        for (const path of uniqueVariants) {
          repairSearchAttempts++
          if (!innerPathIsLegal(model, route, path, occupiedPaths)) continue
          selected = normalizeRepairedInnerPath(
            model,
            route,
            path,
            occupiedPaths,
          )
          if (selected) break
        }
        if (!selected) {
          const step = Math.min(
            Math.min(model.pitchX, model.pitchY) / 2,
            tracePairCenterDistance(model.rules),
          )
          const regularXs: number[] = []
          const regularYs: number[] = []
          for (
            let x = Q(model.padBounds.minX - step);
            x <= model.routingBounds.maxX + EPS;
            x = Q(x + step)
          ) {
            regularXs.push(x)
          }
          for (
            let y = Q(model.routingBounds.minY);
            y <= model.routingBounds.maxY + EPS;
            y = Q(y + step)
          ) {
            regularYs.push(y)
          }
          const xs = uniqueSorted([...regularXs, route.via.x, route.target.x])
          const ys = uniqueSorted([...regularYs, route.via.y, route.target.y])
          const xIndex = new Map(xs.map((value, index) => [Q(value), index]))
          const yIndex = new Map(ys.map((value, index) => [Q(value), index]))
          const startXi = xIndex.get(Q(route.via.x))!
          const startYi = yIndex.get(Q(route.via.y))!
          const blockingSegments = [
            ...model.previousSegments.filter(
              (segment) =>
                segment.layer === route.selectedLayer &&
                segment.connectionName !== route.connectionName,
            ),
            ...[...occupiedPaths.entries()]
              .filter(
                ([connectionName]) =>
                  model.routes.find(
                    (other) => other.connectionName === connectionName,
                  )?.selectedLayer === route.selectedLayer,
              )
              .flatMap(([connectionName, path]) =>
                pathSegments(path).map((segment) => ({
                  ...segment,
                  layer: route.selectedLayer,
                  connectionName,
                })),
              ),
          ]
          const blockingVias = [
            ...model.previousVias.filter((via) =>
              viaTouchesLayer(via, route.selectedLayer, model.input.layerCount),
            ),
            ...model.routes
              .filter((other) => other.connectionName !== route.connectionName)
              .map((other) => other.via),
          ]
          const gridSearch = findGridPathSteps({
            xs,
            ys,
            starts: [
              {
                point: {
                  x: route.via.x,
                  y: route.via.y,
                  xi: startXi,
                  yi: startYi,
                },
                initialCost: 0,
              },
            ],
            isGoal: (point) => distance(point, route.target) <= EPS,
            pointAllowed: (point) =>
              point.x >= model.routingBounds.minX - EPS &&
              point.x <= model.routingBounds.maxX + EPS &&
              point.y >= model.routingBounds.minY - EPS &&
              point.y <= model.routingBounds.maxY + EPS &&
              (distance(point, route.target) <= EPS ||
                blockingVias.every(
                  (via) =>
                    distance(point, via) + EPS >=
                    traceViaCenterDistance(model.rules),
                )),
            segmentAllowed: (a, b) =>
              blockingVias.every(
                (via) =>
                  pointSegmentDistance(via, a, b) + EPS >=
                  traceViaCenterDistance(model.rules),
              ) &&
              blockingSegments.every(
                (segment) =>
                  segmentDistance(a, b, segment.a, segment.b) + EPS >=
                  tracePairCenterDistance(model.rules),
              ),
            heuristic: (point) =>
              Math.abs(route.target.x - point.x) +
              Math.abs(route.target.y - point.y),
            visualization: {
              actionScope: "inner_layer",
              connectionName: route.connectionName,
              layer: route.selectedLayer,
              startPoint: route.via,
              targetPoint: route.target,
            },
          })
          let gridEvents = 0
          while (gridEvents < MAX_LOCAL_TARGET_REPAIR_GRID_EVENTS) {
            const event = gridSearch.next()
            if (event.done) {
              if (
                event.value &&
                innerPathIsLegal(model, route, event.value, occupiedPaths)
              ) {
                selected = normalizeRepairedInnerPath(
                  model,
                  route,
                  event.value,
                  occupiedPaths,
                )
              }
              break
            }
            gridEvents++
          }
          repairSearchAttempts += gridEvents
        }
        if (!selected) break
        accepted.set(route.connectionName, { route, path: selected })
        occupiedPaths.set(route.connectionName, selected)
      }
      if (accepted.size === layerRoutes.length) {
        layerSolution = accepted
        break
      }
    }
    if (!layerSolution) {
      throw phaseError(
        "route_prescribed_inner_layers",
        canonical.map((route) => route.connectionName).join("/"),
        `bounded expanded-target local repair exhausted ${repairSearchAttempts} path candidates`,
      )
    }
    for (const { route, path } of layerSolution.values()) {
      route.innerPath = path
      frozenPaths.set(route.connectionName, path)
      repairedNames.push(route.connectionName)
    }
  }
  for (const route of model.routes) {
    if (
      reusableNames.has(route.connectionName) &&
      !affectedNames.has(route.connectionName)
    ) {
      route.innerPath = candidatePaths.get(route.connectionName)!
    }
  }
  return {
    initiallyReusableRouteNames: [...reusableNames].sort(),
    reusedRouteNames: [...frozenPaths.keys()]
      .filter((name) => !repairedNames.includes(name))
      .sort(),
    repairedRouteNames: initiallyAffected
      .map((route) => route.connectionName)
      .sort(),
    relocatedViaRouteNames,
    repairSearchAttempts,
  }
}

const routeInnerLayersSteps = function* (
  model: GeometryModel,
): Generator<ReferenceSearchStep, void> {
  const actualSpacing = minimumDistinctTargetSpacing(model.routes)
  const compactSpacing =
    model.rules.viaDiameter / 2 +
    model.rules.traceWidth +
    model.rules.traceClearance
  const expandable =
    Number.isFinite(actualSpacing) &&
    actualSpacing > compactSpacing + EPS &&
    model.routes.every((route) => route.selectedLayer !== "top")
  if (!expandable) {
    yield* routeInnerLayersAtCurrentTargetsSteps(model)
    return
  }

  const actualTargets = new Map(
    model.routes.map((route) => [route.connectionName, { ...route.target }]),
  )
  const ys = model.routes.map((route) => route.target.y)
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2
  const compression = compactSpacing / actualSpacing
  for (const route of model.routes) {
    route.target = {
      ...route.target,
      y: Q(centerY + (route.target.y - centerY) * compression),
    }
  }

  try {
    // The compact reference solve is known-feasible but emits very detailed
    // neighbor telemetry. Batch those events so expanded rails cannot consume
    // the parent pipeline's iteration budget before local tail repair begins.
    const compactSolver = routeInnerLayersAtCurrentTargetsSteps(model)
    let internalEvents = 0
    while (true) {
      const event = compactSolver.next()
      if (event.done) break
      internalEvents++
      if (internalEvents % 128 === 0) {
        yield {
          ...event.value,
          action: "route_compact_target_reference",
          processed: internalEvents,
        }
      }
    }
  } catch (error) {
    for (const route of model.routes) {
      route.target = {
        ...route.target,
        ...actualTargets.get(route.connectionName)!,
      }
    }
    throw error
  }

  const repaired = repairExpandedTargetPaths(model, actualTargets)
  model.targetSpacingAdaptation = {
    applied: true,
    actualSpacing: Q(actualSpacing),
    compactSpacing: Q(compactSpacing),
    scale: Q(actualSpacing / compactSpacing),
    requiredSignalCount: model.routes.length,
    ...repaired,
  }
  yield {
    action: "commit_expanded_target_local_repairs",
    status: "completed",
    processed:
      repaired.reusedRouteNames.length + repaired.repairedRouteNames.length,
    total: model.routes.length,
    reason: `${repaired.reusedRouteNames.length} reused; ${repaired.repairedRouteNames.length} locally repaired`,
  }
}

const routeInnerLayers = (model: GeometryModel) => {
  for (const _step of routeInnerLayersSteps(model)) {
    // Drain the same incremental implementation for legacy synchronous calls.
  }
}

const sameNet = (first?: string, second?: string) =>
  Boolean(first && second && first === second)

const validateGeometry = (model: GeometryModel) => {
  if (model.routes.length !== model.nets.length) {
    throw phaseError(
      "validate_reconstructed_geometry",
      "all",
      `routed ${model.routes.length}/${model.nets.length} connections`,
    )
  }
  const traceSegments: LayeredSegment[] = []
  for (const route of model.routes) {
    if (!route.sourceTraceId) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "source_trace_id was not preserved",
      )
    }
    if (!Number.isFinite(route.via.x) || !Number.isFinite(route.via.y)) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "no via was assigned",
      )
    }
    if (distance(route.topPath[0]!, route.source) > EPS) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "top dogbone does not start at the source ball",
      )
    }
    if (distance(route.topPath[route.topPath.length - 1]!, route.via) > EPS) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "top dogbone does not terminate at its via",
      )
    }
    if (distance(route.innerPath[0]!, route.via) > EPS) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "prescribed-layer path does not start at its via",
      )
    }
    if (
      distance(route.innerPath[route.innerPath.length - 1]!, route.target) > EPS
    ) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "prescribed-layer path does not end at the exact Core breakout point",
      )
    }
    for (const [path, layer] of [
      [route.topPath, "top"],
      [route.innerPath, route.selectedLayer],
    ] as const) {
      for (let index = 1; index < path.length - 1; index++) {
        if (
          isRightAngleTurn(path[index - 1]!, path[index]!, path[index + 1]!)
        ) {
          throw phaseError(
            "validate_reconstructed_geometry",
            route.connectionName,
            layer +
              " copper contains an unmitered 90-degree corner " +
              JSON.stringify({
                previous: path[index - 1],
                corner: path[index],
                next: path[index + 1],
              }),
          )
        }
      }
    }
    const ownPad = getOwnPad(model, route)
    if (!ownPad) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "cannot revalidate the mitered source escape against its own pad",
      )
    }
    for (const segment of pathSegments(route.topPath)) {
      if (!isOctilinear(segment.a, segment.b)) {
        throw phaseError(
          "validate_reconstructed_geometry",
          route.connectionName,
          "top copper contains a non-straight/non-45-degree segment",
        )
      }
      if (
        segmentPadEdgeDistance(model, segment.a, segment.b, ownPad.id) + EPS <
        model.rules.traceWidth / 2 + model.rules.traceToPadClearance
      ) {
        throw phaseError(
          "validate_reconstructed_geometry",
          route.connectionName,
          "mitered top copper violates the SRJ trace-to-pad clearance",
        )
      }
      traceSegments.push({
        ...segment,
        layer: "top",
        connectionName: route.connectionName,
      })
    }
    for (const segment of pathSegments(route.innerPath)) {
      if (!isOctilinear(segment.a, segment.b)) {
        throw phaseError(
          "validate_reconstructed_geometry",
          route.connectionName,
          "inner copper contains a non-straight/non-45-degree segment " +
            JSON.stringify(segment),
        )
      }
      traceSegments.push({
        ...segment,
        layer: route.selectedLayer,
        connectionName: route.connectionName,
      })
    }
    if (
      padEdgeDistance(model, route.via) + EPS <
      model.rules.viaDiameter / 2 + model.rules.viaToPadClearance
    ) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "via-to-pad clearance is below the SRJ rule",
      )
    }
  }

  for (let firstIndex = 0; firstIndex < model.routes.length; firstIndex++) {
    const first = model.routes[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < model.routes.length;
      secondIndex++
    ) {
      const second = model.routes[secondIndex]!
      if (distance(first.via, second.via) + EPS < model.rules.viaToViaCenter) {
        throw phaseError(
          "validate_reconstructed_geometry",
          `${first.connectionName}/${second.connectionName}`,
          "via-to-via clearance is below the SRJ rule",
        )
      }
    }
  }

  for (let firstIndex = 0; firstIndex < traceSegments.length; firstIndex++) {
    const first = traceSegments[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < traceSegments.length;
      secondIndex++
    ) {
      const second = traceSegments[secondIndex]!
      if (
        first.layer !== second.layer ||
        sameNet(first.connectionName, second.connectionName)
      )
        continue
      if (
        segmentDistance(first.a, first.b, second.a, second.b) + EPS <
        tracePairCenterDistance(model.rules)
      ) {
        throw phaseError(
          "validate_reconstructed_geometry",
          `${first.connectionName}/${second.connectionName}`,
          `${first.layer} trace-to-trace clearance is below the SRJ-derived rule`,
        )
      }
    }
  }

  for (const segment of traceSegments) {
    for (const route of model.routes) {
      if (sameNet(segment.connectionName, route.connectionName)) continue
      if (
        !viaTouchesLayer(
          { fromLayer: "top", toLayer: "bottom" },
          segment.layer,
          model.input.layerCount,
        )
      ) {
        continue
      }
      if (
        pointSegmentDistance(route.via, segment.a, segment.b) + EPS <
        traceViaCenterDistance(model.rules)
      ) {
        throw phaseError(
          "validate_reconstructed_geometry",
          `${segment.connectionName}/${route.connectionName}`,
          "trace-to-via clearance is below the SRJ-derived rule",
        )
      }
    }
  }

  const connectionNames = new Set(model.nets.map((net) => net.connectionName))
  for (const bus of model.input.buses ?? []) {
    const original = bus.connectionNames.filter((name) =>
      connectionNames.has(name),
    )
    const reconstructed = model.nets
      .filter((net) => net.busId === bus.busId)
      .sort((first, second) => first.busRank - second.busRank)
      .map((net) => net.connectionName)
    if (original.some((name, index) => reconstructed[index] !== name)) {
      throw phaseError(
        "validate_reconstructed_geometry",
        bus.busId,
        "atomic bus connection order changed",
      )
    }
  }
}

const buildTrace = (
  model: GeometryModel,
  route: RoutedNet,
): SimplifiedPcbTrace => {
  const source = fromCanonical(model.axisSign, route.source)
  const topPath = route.topPath.map((point) =>
    fromCanonical(model.axisSign, point),
  )
  const via = fromCanonical(model.axisSign, route.via)
  const innerPath = route.innerPath.map((point) =>
    fromCanonical(model.axisSign, point),
  )
  const wire = (
    point: Point,
    layer: string,
    extra?: Record<string, string>,
  ) => ({
    route_type: "wire" as const,
    x: point.x,
    y: point.y,
    width:
      route.connection.nominalTraceWidth ??
      route.connection.width ??
      model.rules.traceWidth,
    layer,
    ...extra,
  })
  const traceRoute: SimplifiedPcbTrace["route"] = topPath.map((point, index) =>
    wire(
      point,
      "top",
      index === 0 && route.source.pcb_port_id
        ? { start_pcb_port_id: route.source.pcb_port_id }
        : undefined,
    ),
  )
  if (route.selectedLayer !== "top") {
    traceRoute.push({
      route_type: "via",
      x: via.x,
      y: via.y,
      from_layer: "top",
      to_layer: "bottom",
      via_diameter: model.rules.viaDiameter,
      via_hole_diameter: model.rules.viaHoleDiameter,
    })
    traceRoute.push(
      ...innerPath.map((point) => wire(point, route.selectedLayer)),
    )
  } else if (distance(topPath[topPath.length - 1]!, source) > EPS) {
    // The top-only path was already extended to the target.
  }
  return {
    type: "pcb_trace",
    pcb_trace_id: `am62l-free-space:${route.connectionName}`,
    connection_name: route.connectionName,
    connectsTo: [
      ...(route.source.pointId ? [route.source.pointId] : []),
      ...(route.source.pcb_port_id ? [route.source.pcb_port_id] : []),
      ...(route.target.pointId ? [route.target.pointId] : []),
    ],
    route: traceRoute,
  }
}

const buildOutput = (model: GeometryModel): InProcessAutorouterResult => {
  const traces = model.routes
    .sort((first, second) => first.rank - second.rank)
    .map((route) => buildTrace(model, route))
  const routeByName = new Map(
    model.routes.map((route) => [route.connectionName, route]),
  )
  const connections = model.input.connections.map((connection) => {
    const route = routeByName.get(connection.name)
    if (!route) return connection
    const targetIndex = connection.pointsToConnect.findIndex(
      (point) => point.pointId === route.target.pointId,
    )
    if (targetIndex < 0) {
      throw phaseError(
        "validate_reconstructed_geometry",
        route.connectionName,
        "cannot identify the exact Core breakout point in the output connection",
      )
    }
    return {
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((point, index) =>
        index === targetIndex
          ? {
              ...point,
              layer: route.selectedLayer,
              x: fromCanonical(model.axisSign, route.target).x,
              y: route.target.y,
            }
          : { ...point },
      ),
    }
  })
  return {
    traces,
    outputSimpleRouteJson: {
      ...model.input,
      connections,
      traces: [...(model.input.traces ?? []), ...traces],
      buses: model.input.buses?.map((bus) => ({
        ...bus,
        connectionNames: [...bus.connectionNames],
        ...(bus.connectionExitTargets
          ? { connectionExitTargets: { ...bus.connectionExitTargets } }
          : {}),
      })),
    },
  }
}

const miterRouteCorners = (model: GeometryModel, route: RoutedNet) => {
  const ownPad = getOwnPad(model, route)
  const topReplacementAllowed = (start: Point, end: Point) =>
    Boolean(ownPad) &&
    segmentPadEdgeDistance(model, start, end, ownPad!.id) + EPS >=
      model.rules.traceWidth / 2 + model.rules.traceToPadClearance &&
    model.routes.every(
      (other) =>
        other.connectionName === route.connectionName ||
        (pointSegmentDistance(other.via, start, end) + EPS >=
          traceViaCenterDistance(model.rules) &&
          pathSegments(other.topPath).every(
            (segment) =>
              segmentDistance(start, end, segment.a, segment.b) + EPS >=
              tracePairCenterDistance(model.rules),
          )),
    ) &&
    model.previousSegments
      .filter((segment) => segment.layer === "top")
      .every(
        (segment) =>
          segmentDistance(start, end, segment.a, segment.b) + EPS >=
          tracePairCenterDistance(model.rules),
      )
  route.topPath = miterRightAngleTurns(
    route.topPath,
    model.rules,
    topReplacementAllowed,
  )
  route.innerPath = miterRightAngleTurns(
    route.innerPath,
    model.rules,
    (start, end) =>
      model.routes.every(
        (other) =>
          other.connectionName === route.connectionName ||
          (pointSegmentDistance(other.via, start, end) + EPS >=
            traceViaCenterDistance(model.rules) &&
            (other.selectedLayer !== route.selectedLayer ||
              pathSegments(other.innerPath).every(
                (segment) =>
                  segmentDistance(start, end, segment.a, segment.b) + EPS >=
                  tracePairCenterDistance(model.rules),
              ))),
      ) &&
      model.previousSegments
        .filter((segment) => segment.layer === route.selectedLayer)
        .every(
          (segment) =>
            segmentDistance(start, end, segment.a, segment.b) + EPS >=
            tracePairCenterDistance(model.rules),
        ),
  )
}

export type ReferenceRouteSnapshot = {
  connectionName: string
  selectedLayer: string
  source: Point
  target: Point
  topPath: Point[]
  via: Point
  innerPath: Point[]
  kind: "early" | "residual"
}

export type TemporaryPowerReservation = {
  path: Point[]
  via: Point
  netKey: string
}

/**
 * Stateful access to the validated reference algorithm. Every method mutates
 * the same geometry model, so public preprocessing and routing are one honest
 * dataflow rather than a parallel visualization-only pipeline.
 */
export class IncrementalReferenceFanoutSession {
  private readonly model: GeometryModel
  private readonly computeClock = new ActiveComputeClock()
  private earlyDropGenerator: Generator<ReferenceSearchStep, void> | null = null
  private topRouteGenerator: Generator<ReferenceSearchStep, void> | null = null
  private innerRouteGenerator: Generator<ReferenceSearchStep, void> | null =
    null
  private lastSearchStep: ReferenceSearchStep | null = null
  private miterCursor = 0
  private temporaryReservationSegmentCount = 0
  private temporaryReservationViaCount = 0
  private powerSignalCoRouting: PowerSignalCoRoutingSummary | undefined

  constructor(rankedModel: RankedFanoutModel) {
    this.model = {
      ...rankedModel.model,
      freeCells: rankedModel.freeCells,
      freeRegions: rankedModel.freeRegions,
      earlyRouteCandidates: [],
      routes: [],
      routeHints: new Map(),
      selectiveViaLineBlockingSignals: new Set(),
    }
  }

  stepIndependentEarlyDropVias(): boolean {
    this.earlyDropGenerator ??= assignEarlyDropsSteps(
      this.model,
      this.computeClock,
    )
    return this.advanceSearch(
      this.earlyDropGenerator,
      "place_independent_early_drop_vias",
    )
  }

  stepResidualTopDogbones(
    getViaLineDepthRank?: ViaLineDepthRanker,
    getViaLineVerticalDirection?: ViaLineVerticalDirectionSelector,
    getViaLineSlotIndex?: ViaLineSlotIndexer,
  ): boolean {
    this.topRouteGenerator ??= routeResidualTopDogbonesSteps(
      this.model,
      getViaLineDepthRank,
      getViaLineVerticalDirection,
      getViaLineSlotIndex,
    )
    return this.advanceSearch(
      this.topRouteGenerator,
      "complete_top_layer_routes",
    )
  }

  stepPrescribedInnerLayers(): boolean {
    this.innerRouteGenerator ??= routeInnerLayersSteps(this.model)
    return this.advanceSearch(
      this.innerRouteGenerator,
      "route_prescribed_inner_layers",
    )
  }

  getLastSearchStep(): ReferenceSearchStep | null {
    return this.lastSearchStep
  }

  private advanceSearch(
    generator: Generator<ReferenceSearchStep, void>,
    completedAction: string,
  ): boolean {
    this.computeClock.beginStep()
    let result: IteratorResult<ReferenceSearchStep, void>
    try {
      result = generator.next()
    } finally {
      this.computeClock.endStep()
    }
    if (result.done) {
      this.lastSearchStep = {
        action: completedAction,
        status: "completed",
      }
      return true
    }
    this.lastSearchStep = result.value
    return false
  }

  assignPreferredLayers() {
    assignPreferredLayers(this.model)
  }

  setRouteHints(routes: readonly ReferenceRouteSnapshot[]) {
    if (this.model.routes.length > 0) {
      throw new Error("route hints must be set before routing starts")
    }
    this.model.routeHints = new Map(
      routes.map((route) => [route.connectionName, structuredClone(route)]),
    )
  }

  getSelectiveViaLineBlockingSignals() {
    return [...this.model.selectiveViaLineBlockingSignals].sort()
  }

  routePrescribedLayers() {
    routeInnerLayers(this.model)
  }

  miterNextRoute(): ReferenceRouteSnapshot | null {
    const route = this.model.routes[this.miterCursor]
    if (!route) return null
    miterRouteCorners(this.model, route)
    this.miterCursor++
    return this.snapshotRoute(route)
  }

  validate() {
    validateGeometry(this.model)
  }

  /**
   * Installs a complete set of already-routed snapshots into a fresh session.
   * This is used to revalidate a bounded selective reroute together with the
   * preserved routes it did not disturb.
   */
  replaceRoutesWithSnapshots(routes: readonly ReferenceRouteSnapshot[]) {
    if (
      this.earlyDropGenerator ||
      this.topRouteGenerator ||
      this.innerRouteGenerator
    ) {
      throw new Error("cannot replace routes after routing has started")
    }
    const snapshotByName = new Map(
      routes.map((route) => [route.connectionName, route]),
    )
    if (
      snapshotByName.size !== routes.length ||
      snapshotByName.size !== this.model.nets.length
    ) {
      throw new Error(
        `replacement route count ${snapshotByName.size} does not match ${this.model.nets.length} required nets`,
      )
    }
    this.model.routes = this.model.nets.map((net) => {
      const route = snapshotByName.get(net.connectionName)
      if (!route) {
        throw new Error(`replacement route is missing ${net.connectionName}`)
      }
      return {
        ...net,
        selectedLayer: route.selectedLayer,
        topPath: route.topPath.map((point) => ({ ...point })),
        via: { ...route.via },
        innerPath: route.innerPath.map((point) => ({ ...point })),
        kind: route.kind,
      }
    })
    this.miterCursor = this.model.routes.length
  }

  reserveTemporaryPowerCorridors(
    reservations: readonly TemporaryPowerReservation[],
  ) {
    if (
      this.temporaryReservationSegmentCount !== 0 ||
      this.temporaryReservationViaCount !== 0
    ) {
      throw new Error("temporary power corridors are already reserved")
    }
    for (const reservation of reservations) {
      for (const segment of pathSegments(reservation.path)) {
        this.model.previousSegments.push({
          ...segment,
          layer: "top",
          connectionName: `power-reservation:${reservation.netKey}`,
        })
        this.temporaryReservationSegmentCount++
      }
      this.model.previousVias.push({
        ...reservation.via,
        fromLayer: "top",
        toLayer: "bottom",
      })
      this.temporaryReservationViaCount++
    }
  }

  clearTemporaryPowerCorridors() {
    if (this.temporaryReservationSegmentCount > 0) {
      this.model.previousSegments.splice(
        this.model.previousSegments.length -
          this.temporaryReservationSegmentCount,
        this.temporaryReservationSegmentCount,
      )
    }
    if (this.temporaryReservationViaCount > 0) {
      this.model.previousVias.splice(
        this.model.previousVias.length - this.temporaryReservationViaCount,
        this.temporaryReservationViaCount,
      )
    }
    this.temporaryReservationSegmentCount = 0
    this.temporaryReservationViaCount = 0
  }

  setPowerSignalCoRoutingSummary(summary: PowerSignalCoRoutingSummary) {
    this.powerSignalCoRouting = structuredClone(summary)
  }

  getPowerSignalCoRoutingSummary() {
    return this.powerSignalCoRouting
      ? structuredClone(this.powerSignalCoRouting)
      : undefined
  }

  getTargetSpacingAdaptationSummary() {
    return this.model.targetSpacingAdaptation
      ? structuredClone(this.model.targetSpacingAdaptation)
      : undefined
  }

  buildOutput(): InProcessAutorouterResult {
    return buildOutput(this.model)
  }

  /** Commits additive power geometry after mandatory signal validation. */
  commitPowerPlaneModel(committed: FanoutModel) {
    this.model.input = structuredClone(committed.input)
    this.model.previousSegments = committed.previousSegments.map((segment) => ({
      ...segment,
      a: { ...segment.a },
      b: { ...segment.b },
    }))
    this.model.previousVias = committed.previousVias.map((via) => ({ ...via }))
    this.model.powerPlanePlan = committed.powerPlanePlan
      ? structuredClone(committed.powerPlanePlan)
      : undefined
  }

  get routeCount() {
    return this.model.routes.length
  }

  get miteredRouteCount() {
    return this.miterCursor
  }

  getRoutes(): ReferenceRouteSnapshot[] {
    return this.model.routes.map((route) => this.snapshotRoute(route))
  }

  getVisualizationContext(): RankedFanoutModel {
    return {
      model: this.model,
      freeCells: this.model.freeCells,
      freeRegions: this.model.freeRegions,
      legalCellCount: this.model.freeCells.length,
    }
  }

  private snapshotRoute(route: RoutedNet): ReferenceRouteSnapshot {
    return snapshotRoutedNet(route)
  }
}

/**
 * Pure SRJ-to-SRJ port of the 0hmx AM62L free-space fanout strategy. Geometry
 * is normalized so that both the right-escaping SoC and left-escaping RAM use
 * the same solver without fixture coordinates.
 */
export const solveAm62lFreeSpaceFanout = (
  input: SimpleRouteJson,
  reportProgress: (event: AutorouterProgressEvent) => void,
): InProcessAutorouterResult => {
  const model = buildModel(input)
  reportPhase(reportProgress, 0)
  if (model.nets.length === 0) return buildOutput(model)

  buildFreeSpace(model)
  reportPhase(reportProgress, 1)

  numberByFreeSpaceDistance(model)
  reportPhase(reportProgress, 2)

  assignEarlyDrops(model)
  reportPhase(reportProgress, 3)

  routeResidualTopDogbones(model)
  assignPreferredLayers(model)
  reportPhase(reportProgress, 4)

  reportPhase(reportProgress, 5)

  routeInnerLayers(model)
  reportPhase(reportProgress, 6)

  for (const route of model.routes) miterRouteCorners(model, route)
  validateGeometry(model)
  reportPhase(reportProgress, 7)

  return buildOutput(model)
}
