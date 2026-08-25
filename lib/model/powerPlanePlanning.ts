import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core"
import { distance, EPS, fromCanonical, Q, toCanonical } from "./geometry"
import type {
  CopperPourViaDrop,
  FanoutModel,
  LayeredSegment,
  LayeredVia,
  Point,
  PowerPlanePad,
  PowerPlanePlan,
  PowerPlanePour,
  SameNetPadLink,
} from "./types"

type RouteObstacle = SimpleRouteJson["obstacles"][number] & {
  obstacleId?: string
  isCopperPour?: boolean
  netIsAssignable?: boolean
  offBoardConnectsTo?: string[]
  ccwRotationDegrees?: number
  circuitJsonMetadata?: {
    pcb_smtpad_id?: string
    pcb_port_id?: string
    source_port_name?: string
    pcb_copper_pour_id?: string
  }
}

export type PowerPlaneCandidateGeometry = {
  path: Point[]
  via?: Point
  netKey: string
}

const sortedUnique = (values: readonly string[]) =>
  [...new Set(values.filter(Boolean))].sort()

const electricalIdentity = (obstacle: RouteObstacle) => {
  const offBoard = sortedUnique(obstacle.offBoardConnectsTo ?? [])
  if (offBoard.length > 0) {
    return {
      netKey: `off-board:${offBoard.join("|")}`,
      identityTokens: offBoard.map((token) => `off-board:${token}`),
      isStrong: true,
    }
  }
  const connectivity = sortedUnique(obstacle.connectedTo ?? [])
  return {
    netKey: connectivity.length > 0 ? `connectivity:${connectivity[0]}` : "",
    identityTokens: connectivity.map((token) => `connectivity:${token}`),
    isStrong: false,
  }
}

const identitiesOverlap = (
  first: ReturnType<typeof electricalIdentity>,
  second: ReturnType<typeof electricalIdentity>,
) => {
  if (first.isStrong || second.isStrong) {
    if (!first.isStrong || !second.isStrong) return false
    return first.netKey === second.netKey
  }
  const secondTokens = new Set(second.identityTokens)
  return first.identityTokens.some((token) => secondTokens.has(token))
}

const obstacleId = (obstacle: RouteObstacle, index: number) =>
  obstacle.circuitJsonMetadata?.pcb_smtpad_id ??
  obstacle.circuitJsonMetadata?.pcb_copper_pour_id ??
  obstacle.obstacleId ??
  `obstacle-${index}`

/**
 * Discovers assignable pads only on the BGA selected by the fixed-target
 * signal model. Strong off-board identities take precedence; connectivity
 * membership is used only when neither side has a strong identity.
 */
export const discoverPowerPlaneTopology = (
  model: FanoutModel,
): Pick<PowerPlanePlan, "pours" | "pads"> => {
  const pours = model.input.obstacles
    .map((rawObstacle, obstacleIndex) => ({
      obstacle: rawObstacle as RouteObstacle,
      obstacleIndex,
    }))
    .filter(
      ({ obstacle }) =>
        obstacle.isCopperPour === true &&
        obstacle.netIsAssignable === true &&
        obstacle.layers.length > 0,
    )
    .map(({ obstacle, obstacleIndex }) => {
      const identity = electricalIdentity(obstacle)
      if (!identity.netKey) return null
      const center = toCanonical(model.axisSign, obstacle.center)
      return {
        id: obstacleId(obstacle, obstacleIndex),
        obstacleIndex,
        center,
        width: obstacle.width,
        height: obstacle.height,
        ccwRotationDegrees: model.axisSign * (obstacle.ccwRotationDegrees ?? 0),
        layers: [...obstacle.layers].sort(compareLayers),
        netKey: identity.netKey,
        identityTokens: identity.identityTokens,
        identity,
      }
    })
    .filter(
      (
        pour,
      ): pour is PowerPlanePour & {
        identity: ReturnType<typeof electricalIdentity>
      } => pour !== null,
    )
    .sort(
      (first, second) =>
        first.netKey.localeCompare(second.netKey) ||
        compareLayers(first.layers[0] ?? "", second.layers[0] ?? "") ||
        first.id.localeCompare(second.id),
    )

  const sourceIdentifiers = new Set<string>()
  for (const net of model.nets) {
    if (net.source.pointId) sourceIdentifiers.add(net.source.pointId)
    if (net.source.pcb_port_id) sourceIdentifiers.add(net.source.pcb_port_id)
    const sourceObstacle = model.input.obstacles.find(
      (obstacle) =>
        obstacle.componentId === model.componentId &&
        obstacle.layers.includes("top") &&
        Math.abs(obstacle.center.x - model.axisSign * net.source.x) <= EPS &&
        Math.abs(obstacle.center.y - net.source.y) <= EPS,
    ) as RouteObstacle | undefined
    if (sourceObstacle) {
      const metadata = sourceObstacle.circuitJsonMetadata
      if (metadata?.pcb_smtpad_id) sourceIdentifiers.add(metadata.pcb_smtpad_id)
      if (metadata?.pcb_port_id) sourceIdentifiers.add(metadata.pcb_port_id)
    }
  }

  const pads = model.input.obstacles
    .map((rawObstacle, index) => ({
      obstacle: rawObstacle as RouteObstacle,
      index,
    }))
    .filter(
      ({ obstacle }) =>
        obstacle.componentId === model.componentId &&
        obstacle.layers.includes("top") &&
        obstacle.netIsAssignable === true,
    )
    .map(({ obstacle, index }): PowerPlanePad | null => {
      const id = obstacleId(obstacle, index)
      const metadata = obstacle.circuitJsonMetadata
      if (
        sourceIdentifiers.has(id) ||
        (metadata?.pcb_port_id &&
          sourceIdentifiers.has(metadata.pcb_port_id)) ||
        obstacle.connectedTo.some((token) => sourceIdentifiers.has(token))
      ) {
        return null
      }
      const identity = electricalIdentity(obstacle)
      if (!identity.netKey) return null
      const matchingPours = pours.filter((pour) =>
        identitiesOverlap(identity, pour.identity),
      )
      const matchingNetKeys = sortedUnique(
        matchingPours.map((pour) => pour.netKey),
      )
      // A fallback connectivity closure that reaches multiple electrical
      // identities is ambiguous. It must not be guessed into either plane.
      if (matchingNetKeys.length !== 1) return null
      const center = toCanonical(model.axisSign, obstacle.center)
      const topologyPad = model.pads.find((pad) => distance(pad, center) <= EPS)
      if (!topologyPad) return null
      return {
        ...topologyPad,
        id,
        componentId: model.componentId,
        pointId: metadata?.pcb_smtpad_id ?? id,
        pcbPortId: metadata?.pcb_port_id,
        sourcePortName: metadata?.source_port_name,
        netKey: matchingNetKeys[0]!,
        identityTokens: identity.identityTokens,
        matchingPourIds: matchingPours.map((pour) => pour.id).sort(),
      }
    })
    .filter((pad): pad is PowerPlanePad => pad !== null)
    .sort(
      (first, second) =>
        first.netKey.localeCompare(second.netKey) ||
        first.row - second.row ||
        first.column - second.column ||
        first.id.localeCompare(second.id),
    )

  return {
    pours: pours.map(({ identity: _, ...pour }) => pour),
    pads,
  }
}

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const pointSegmentDistance = (
  point: Point,
  start: Point,
  end: Point,
) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const amount =
    lengthSquared <= EPS
      ? 0
      : clamp(
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
          0,
          1,
        )
  return Math.hypot(
    point.x - start.x - amount * dx,
    point.y - start.y - amount * dy,
  )
}

const cross = (first: Point, second: Point, third: Point) =>
  (second.x - first.x) * (third.y - first.y) -
  (second.y - first.y) * (third.x - first.x)

export const segmentDistance = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) => {
  const firstCrossStart = cross(firstStart, firstEnd, secondStart)
  const firstCrossEnd = cross(firstStart, firstEnd, secondEnd)
  const secondCrossStart = cross(secondStart, secondEnd, firstStart)
  const secondCrossEnd = cross(secondStart, secondEnd, firstEnd)
  if (
    ((firstCrossStart > EPS && firstCrossEnd < -EPS) ||
      (firstCrossStart < -EPS && firstCrossEnd > EPS)) &&
    ((secondCrossStart > EPS && secondCrossEnd < -EPS) ||
      (secondCrossStart < -EPS && secondCrossEnd > EPS))
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

export const pathSegments = (path: readonly Point[]) =>
  path.slice(1).map((point, index) => ({ a: path[index]!, b: point }))

const simplifyPath = (path: readonly Point[]) => {
  const result: Point[] = []
  for (const point of path) {
    const quantized = { x: Q(point.x), y: Q(point.y) }
    if (
      result.length === 0 ||
      distance(result[result.length - 1]!, quantized) > EPS
    ) {
      result.push(quantized)
    }
  }
  return result
}

export const octilinearCandidates = (start: Point, end: Point): Point[][] => {
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
  const xSign = Math.sign(dx)
  const ySign = Math.sign(dy)
  return [
    [
      start,
      {
        x: Q(start.x + xSign * diagonal),
        y: Q(start.y + ySign * diagonal),
      },
      end,
    ],
    [
      start,
      {
        x: Q(end.x - xSign * diagonal),
        y: Q(end.y - ySign * diagonal),
      },
      end,
    ],
  ].map(simplifyPath)
}

export const pathLength = (path: readonly Point[]) =>
  path
    .slice(1)
    .reduce((sum, point, index) => sum + distance(path[index]!, point), 0)

export const isTopPathLegal = ({
  model,
  path,
  netKey,
  ignoredPadIds,
  powerPads,
  committedGeometry,
}: {
  model: FanoutModel
  path: readonly Point[]
  netKey: string
  ignoredPadIds: ReadonlySet<string>
  powerPads: readonly PowerPlanePad[]
  committedGeometry: readonly PowerPlaneCandidateGeometry[]
}) => {
  const powerPadById = new Map(powerPads.map((pad) => [pad.id, pad]))
  const tracePadDistance =
    model.rules.traceWidth / 2 + model.rules.traceToPadClearance
  for (const segment of pathSegments(path)) {
    for (const pad of model.pads) {
      if (ignoredPadIds.has(pad.id)) continue
      if (
        pointSegmentDistance(pad, segment.a, segment.b) + EPS <
        pad.radius + tracePadDistance
      ) {
        return false
      }
    }
    for (const previous of model.previousSegments) {
      if (previous.layer !== "top") continue
      if (previous.connectionName === powerConnectionName(netKey)) continue
      if (
        segmentDistance(segment.a, segment.b, previous.a, previous.b) + EPS <
        model.rules.traceWidth + model.rules.traceClearance
      ) {
        return false
      }
    }
    for (const previousVia of model.previousVias) {
      if (
        pointSegmentDistance(previousVia, segment.a, segment.b) + EPS <
        model.rules.viaDiameter / 2 +
          model.rules.traceWidth / 2 +
          model.rules.traceToViaClearance
      ) {
        return false
      }
    }
    for (const geometry of committedGeometry) {
      if (geometry.netKey !== netKey) {
        for (const other of pathSegments(geometry.path)) {
          if (
            segmentDistance(segment.a, segment.b, other.a, other.b) + EPS <
            model.rules.traceWidth + model.rules.traceClearance
          ) {
            return false
          }
        }
      }
      if (
        geometry.via &&
        pointSegmentDistance(geometry.via, segment.a, segment.b) + EPS <
          model.rules.viaDiameter / 2 +
            model.rules.traceWidth / 2 +
            model.rules.traceToViaClearance
      ) {
        return false
      }
    }
  }
  // Ensure ignored identifiers really belong to known pads. This catches
  // malformed planning state instead of silently skipping unrelated copper.
  return [...ignoredPadIds].every(
    (id) => model.pads.some((pad) => pad.id === id) || powerPadById.has(id),
  )
}

export const isViaLegal = ({
  model,
  via,
  netKey,
  committedGeometry,
}: {
  model: FanoutModel
  via: Point
  netKey: string
  committedGeometry: readonly PowerPlaneCandidateGeometry[]
}) => {
  const requiredPadDistance =
    model.rules.viaDiameter / 2 + model.rules.viaToPadClearance
  if (
    model.pads.some(
      (pad) => distance(pad, via) + EPS < pad.radius + requiredPadDistance,
    )
  ) {
    return false
  }
  if (
    model.previousVias.some(
      (previousVia) =>
        distance(previousVia, via) + EPS < model.rules.viaToViaCenter,
    )
  ) {
    return false
  }
  if (
    committedGeometry.some(
      (geometry) =>
        geometry.via &&
        distance(geometry.via, via) + EPS < model.rules.viaToViaCenter,
    )
  ) {
    return false
  }
  const requiredTraceDistance =
    model.rules.viaDiameter / 2 +
    model.rules.traceWidth / 2 +
    model.rules.traceToViaClearance
  if (
    model.previousSegments
      .filter(
        (segment) =>
          segment.layer === "top" &&
          segment.connectionName !== powerConnectionName(netKey),
      )
      .some(
        (segment) =>
          pointSegmentDistance(via, segment.a, segment.b) + EPS <
          requiredTraceDistance,
      )
  ) {
    return false
  }
  return !committedGeometry.some((geometry) =>
    pathSegments(geometry.path).some(
      (segment) =>
        pointSegmentDistance(via, segment.a, segment.b) + EPS <
        requiredTraceDistance,
    ),
  )
}

export const containsPoint = (pour: PowerPlanePour, point: Point) => {
  const radians = (-pour.ccwRotationDegrees * Math.PI) / 180
  const dx = point.x - pour.center.x
  const dy = point.y - pour.center.y
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians)
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians)
  return (
    Math.abs(localX) <= pour.width / 2 + EPS &&
    Math.abs(localY) <= pour.height / 2 + EPS
  )
}

export const layerIndex = (layer: string, layerCount: number) => {
  if (layer === "top") return 0
  if (layer === "bottom") return layerCount - 1
  const match = /^inner(\d+)$/.exec(layer)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

export const compareLayers = (first: string, second: string) => {
  const firstMatch = /^inner(\d+)$/.exec(first)
  const secondMatch = /^inner(\d+)$/.exec(second)
  const firstRank =
    first === "top"
      ? 0
      : first === "bottom"
        ? Number.MAX_SAFE_INTEGER
        : firstMatch
          ? Number(firstMatch[1])
          : Number.MAX_SAFE_INTEGER - 1
  const secondRank =
    second === "top"
      ? 0
      : second === "bottom"
        ? Number.MAX_SAFE_INTEGER
        : secondMatch
          ? Number(secondMatch[1])
          : Number.MAX_SAFE_INTEGER - 1
  return firstRank - secondRank || first.localeCompare(second)
}

export const powerConnectionName = (netKey: string) => `power-plane:${netKey}`

export const powerTraceIdPrefix = "bga-power-plane:"

const worldPath = (model: FanoutModel, path: readonly Point[]) =>
  path.map((point) => fromCanonical(model.axisSign, point))

export const buildLinkTrace = (
  model: FanoutModel,
  link: SameNetPadLink,
  pads: readonly PowerPlanePad[],
): SimplifiedPcbTrace => {
  const padById = new Map(pads.map((pad) => [pad.id, pad]))
  const first = padById.get(link.firstPadId)
  const second = padById.get(link.secondPadId)
  return {
    type: "pcb_trace",
    pcb_trace_id: `${powerTraceIdPrefix}link:${link.id}`,
    connection_name: powerConnectionName(link.netKey),
    connectsTo: sortedUnique(
      [
        first?.pointId,
        first?.pcbPortId,
        second?.pointId,
        second?.pcbPortId,
        ...((first?.identityTokens ?? []).map((token) =>
          token.replace(/^off-board:/, ""),
        ) ?? []),
      ].filter((value): value is string => Boolean(value)),
    ),
    route: worldPath(model, link.path).map((point) => ({
      route_type: "wire" as const,
      ...point,
      width: model.rules.traceWidth,
      layer: "top",
    })),
  }
}

export const buildDropTrace = (
  model: FanoutModel,
  drop: CopperPourViaDrop,
  pads: readonly PowerPlanePad[],
): SimplifiedPcbTrace => {
  const sourcePad = pads.find((pad) => pad.id === drop.sourcePadId)
  const topPath = worldPath(model, drop.topPath)
  const worldVia = fromCanonical(model.axisSign, drop.via)
  return {
    type: "pcb_trace",
    pcb_trace_id: `${powerTraceIdPrefix}drop:${drop.id}`,
    connection_name: powerConnectionName(drop.netKey),
    connectsTo: sortedUnique(
      [
        sourcePad?.pointId,
        sourcePad?.pcbPortId,
        drop.pourId,
        ...((sourcePad?.identityTokens ?? []).map((token) =>
          token.replace(/^off-board:/, ""),
        ) ?? []),
      ].filter((value): value is string => Boolean(value)),
    ),
    route: [
      ...topPath.map((point) => ({
        route_type: "wire" as const,
        ...point,
        width: model.rules.traceWidth,
        layer: "top",
      })),
      {
        route_type: "via" as const,
        ...worldVia,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: model.rules.viaDiameter,
        via_hole_diameter: model.rules.viaHoleDiameter,
      },
      {
        route_type: "wire" as const,
        ...worldVia,
        width: model.rules.traceWidth,
        layer: drop.terminationLayer,
      },
    ],
  }
}

export const traceSegments = (
  model: FanoutModel,
  path: readonly Point[],
  netKey: string,
): LayeredSegment[] =>
  pathSegments(path).map((segment) => ({
    ...segment,
    layer: "top",
    connectionName: powerConnectionName(netKey),
  }))

export const dropVia = (drop: CopperPourViaDrop): LayeredVia => ({
  ...drop.via,
  fromLayer: "top",
  toLayer: "bottom",
})

export const buildViaObstacle = (
  model: FanoutModel,
  drop: CopperPourViaDrop,
): SimpleRouteJson["obstacles"][number] => {
  const worldVia = fromCanonical(model.axisSign, drop.via)
  const layerCount = model.input.layerCount ?? 2
  const layers = Array.from({ length: layerCount }, (_, index) => {
    if (index === 0) return "top"
    if (index === layerCount - 1) return "bottom"
    return `inner${index}`
  })
  return {
    type: "rect",
    shape: "circle",
    center: worldVia,
    width: model.rules.viaDiameter,
    height: model.rules.viaDiameter,
    layers,
    connectedTo: [
      powerConnectionName(drop.netKey),
      drop.pourId,
      drop.sourcePadId,
    ],
    obstacleId: `${powerTraceIdPrefix}via:${drop.id}`,
  } as SimpleRouteJson["obstacles"][number]
}
