import type {
  Obstacle,
  SimpleRouteJson,
  SimpleRoutePoint,
} from "@tscircuit/core"
import type {
  Circle,
  GraphicsObject,
  Line,
  Point,
  Polygon,
  Rect,
} from "graphics-debug"
import {
  getCopperLayerColor,
  getCopperLayerNames,
  getGraphicsLayer,
  getLayerIndex,
  getLayerSpan,
  safeTransparentize,
} from "./layerVisuals"

const JUMPER_DIMENSIONS = {
  "0603": { padLength: 0.8, padWidth: 0.95 },
  "1206": { padLength: 0.6, padWidth: 1.6 },
  "1206x4_pair": { padLength: 0.8, padWidth: 0.5 },
} as const

type VisualCollections = {
  circles: Circle[]
  lines: Line[]
  points: Point[]
  polygons: Polygon[]
  rects: Rect[]
}

export const LOCAL_CONNECTION_GUIDE_LABEL =
  "local breakout connection (source to routed endpoint)"

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

const firstFiniteNumber = (
  ...values: Array<number | undefined>
): number | undefined =>
  values.find((value) => typeof value === "number" && Number.isFinite(value))

const getViaPadDiameter = (input: SimpleRouteJson): number => {
  const holeDiameter = firstFiniteNumber(
    input.min_via_hole_diameter,
    input.minViaHoleDiameter,
  )
  const padDiameter = firstFiniteNumber(
    input.min_via_pad_diameter,
    input.minViaPadDiameter,
    input.minViaDiameter,
  )
  return Math.max(padDiameter ?? 0.3, holeDiameter ?? 0)
}

const getPointLayers = (point: SimpleRoutePoint): string[] =>
  point.layers && point.layers.length > 0 ? point.layers : [point.layer]

const getObstacleLayerIndexes = (
  obstacle: Obstacle,
  layerNames: readonly string[],
): number[] => {
  if (obstacle.zLayers && obstacle.zLayers.length > 0) {
    const layerIndexes = unique(obstacle.zLayers).sort(
      (first, second) => first - second,
    )
    if (
      layerIndexes.some(
        (layerIndex) =>
          !Number.isInteger(layerIndex) ||
          layerIndex < 0 ||
          layerIndex >= layerNames.length,
      )
    ) {
      throw new Error(
        `cannot visualize obstacle "${obstacle.obstacleId ?? "unknown"}" with invalid zLayers`,
      )
    }
    return layerIndexes
  }
  return unique(
    obstacle.layers.map((layerName) => getLayerIndex(layerNames, layerName)),
  ).sort((first, second) => first - second)
}

const getConnectionColors = (input: SimpleRouteJson): Map<string, string> => {
  const identifiers = input.connections.map((connection) => connection.name)
  return new Map(
    identifiers.map((identifier, index) => [
      identifier,
      `hsl(${(index * 340) / Math.max(1, identifiers.length)}, 100%, 50%)`,
    ]),
  )
}

const getObstacleLabel = (
  obstacle: Obstacle,
  layerIndexes: readonly number[],
  layerNames: readonly string[],
): string =>
  [
    obstacle.isCopperPour ? "copper pour" : "obstacle",
    obstacle.obstacleId,
    obstacle.componentId,
    layerIndexes.map((layerIndex) => layerNames[layerIndex]).join(", "),
    obstacle.connectedTo.length > 0
      ? `connected to ${obstacle.connectedTo.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")

const addObstacle = ({
  collections,
  input,
  obstacle,
  fill,
  stroke,
  label,
}: {
  collections: VisualCollections
  input: SimpleRouteJson
  obstacle: Obstacle
  fill?: string
  stroke?: string
  label?: string
}) => {
  const layerNames = getCopperLayerNames(input.layerCount)
  const layerIndexes = getObstacleLayerIndexes(obstacle, layerNames)
  if (layerIndexes.length === 0) {
    throw new Error(
      `cannot visualize obstacle "${obstacle.obstacleId ?? "unknown"}" without a copper layer`,
    )
  }
  const primaryLayer = layerNames[layerIndexes[0]!]!
  const onlyLayer =
    layerIndexes.length === 1 ? layerNames[layerIndexes[0]!] : undefined
  const obstacleColor = onlyLayer === "bottom" ? "blue" : "red"
  const primaryColor = getCopperLayerColor(primaryLayer)
  const common = {
    center: obstacle.center,
    fill:
      fill ??
      safeTransparentize(
        obstacle.isCopperPour ? primaryColor : obstacleColor,
        obstacle.isCopperPour ? 0.72 : 0.5 ** layerIndexes.length,
      ),
    stroke:
      stroke ??
      (obstacle.isCopperPour
        ? safeTransparentize(primaryColor, 0.2)
        : undefined),
    layer: `z${layerIndexes.join(",")}`,
    label: label ?? getObstacleLabel(obstacle, layerIndexes, layerNames),
  }
  if (obstacle.shape === "circle") {
    collections.circles.push({
      ...common,
      radius: Math.min(obstacle.width, obstacle.height) / 2,
    })
  } else {
    collections.rects.push({
      ...common,
      width: obstacle.width,
      height: obstacle.height,
      ccwRotationDegrees: obstacle.ccwRotationDegrees,
    })
  }
}

const addBoardGeometry = (
  input: SimpleRouteJson,
  collections: VisualCollections,
) => {
  const { bounds } = input
  collections.rects.push({
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    },
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    fill: "rgba(15, 23, 42, 0)",
    stroke: "rgba(71, 85, 105, 0.7)",
    label: "SimpleRouteJson routing bounds",
  })

  if (!input.outline || input.outline.length < 2) return
  if (input.outline.length === 2) {
    collections.lines.push({
      points: input.outline,
      strokeWidth: 0.035,
      strokeColor: "#0f172a",
      label: "board outline",
    })
    return
  }
  collections.polygons.push({
    points: input.outline,
    fill: "rgba(15, 23, 42, 0.025)",
    stroke: "#0f172a",
    strokeWidth: 0.035,
    label: "board outline",
  })
}

const addConnectionPoints = (
  input: SimpleRouteJson,
  collections: VisualCollections,
  connectionColors: ReadonlyMap<string, string>,
) => {
  const layerNames = getCopperLayerNames(input.layerCount)
  const fallbackViaDiameter = getViaPadDiameter(input)
  for (const connection of input.connections) {
    const color = connectionColors.get(connection.name) ?? "#475569"
    for (const point of connection.pointsToConnect) {
      const pointLayers = getPointLayers(point)
      collections.points.push({
        x: point.x,
        y: point.y,
        color,
        layer: getGraphicsLayer(layerNames, pointLayers),
        label: [
          connection.name,
          point.pointId,
          point.port_selector,
          pointLayers.join(", "),
        ]
          .filter(Boolean)
          .join("\n"),
      })

      if (!point.terminalVia) continue
      const viaLayers = getLayerSpan(
        layerNames,
        point.layer,
        point.terminalVia.toLayer,
      )
      collections.circles.push({
        center: point,
        radius: (point.terminalVia.viaDiameter ?? fallbackViaDiameter) / 2,
        fill: "blue",
        stroke: "none",
        layer: getGraphicsLayer(layerNames, viaLayers),
        label: `${connection.name}\nterminal via ${point.layer} → ${point.terminalVia.toLayer}`,
      })
    }
  }
}

const addLocalConnectionGuides = (
  input: SimpleRouteJson,
  collections: VisualCollections,
  connectionColors: ReadonlyMap<string, string>,
) => {
  for (const connection of input.connections) {
    const source = connection.pointsToConnect[0]
    const localTarget = connection.pointsToConnect[1]
    if (!source || !localTarget || isSamePoint(source, localTarget)) continue
    const color = connectionColors.get(connection.name) ?? "#475569"
    collections.lines.push({
      points: [source, localTarget],
      strokeColor: safeTransparentize(color, 0.25),
      strokeWidth: 0.02,
      strokeDash: [0.06, 0.05],
      label: `${LOCAL_CONNECTION_GUIDE_LABEL}\n${connection.name}`,
    })
  }
}

const isSamePoint = (
  first: { x: number; y: number },
  second: { x: number; y: number },
): boolean =>
  Math.abs(first.x - second.x) < 0.01 && Math.abs(first.y - second.y) < 0.01

const addTraces = (
  input: SimpleRouteJson,
  collections: VisualCollections,
  connectionColors: ReadonlyMap<string, string>,
) => {
  const layerNames = getCopperLayerNames(input.layerCount)
  const fallbackViaDiameter = getViaPadDiameter(input)

  for (const trace of input.traces ?? []) {
    const traceName = trace.connection_name ?? trace.pcb_trace_id
    const connectionColor = connectionColors.get(traceName)
    const routeJumpers = trace.route.filter(
      (routePoint) => routePoint.route_type === "jumper",
    )
    const isWireInsideJumper = (
      start: { x: number; y: number },
      end: { x: number; y: number },
    ) =>
      routeJumpers.some(
        (jumper) =>
          (isSamePoint(start, jumper.start) && isSamePoint(end, jumper.end)) ||
          (isSamePoint(start, jumper.end) && isSamePoint(end, jumper.start)),
      )

    for (const routePoint of trace.route) {
      if (routePoint.route_type === "via") {
        const viaLayers = getLayerSpan(
          layerNames,
          routePoint.from_layer,
          routePoint.to_layer,
        )
        const viaLayer = getGraphicsLayer(layerNames, viaLayers)
        const viaDiameter = routePoint.via_diameter ?? fallbackViaDiameter
        collections.circles.push({
          center: routePoint,
          radius: viaDiameter / 2,
          fill: "blue",
          stroke: "none",
          layer: viaLayer,
          label: `${traceName}\nvia ${routePoint.from_layer} → ${routePoint.to_layer}`,
        })
        continue
      }

      if (routePoint.route_type === "through_obstacle") {
        collections.lines.push({
          points: [routePoint.start, routePoint.end],
          strokeColor: safeTransparentize(connectionColor ?? "purple", 0.35),
          strokeWidth: routePoint.width,
          strokeDash: [0.1, 0.1],
          layer: getGraphicsLayer(layerNames, [
            routePoint.from_layer,
            routePoint.to_layer,
          ]),
          label: `${traceName}\nthrough obstacle ${routePoint.from_layer} → ${routePoint.to_layer}`,
        })
        continue
      }

      if (routePoint.route_type === "jumper") {
        const jumperColor = connectionColor ?? "rgba(255, 165, 0, 0.8)"
        const dimensions = JUMPER_DIMENSIONS[routePoint.footprint]
        const horizontal =
          Math.abs(routePoint.end.x - routePoint.start.x) >
          Math.abs(routePoint.end.y - routePoint.start.y)
        const padWidth = horizontal ? dimensions.padLength : dimensions.padWidth
        const padHeight = horizontal
          ? dimensions.padWidth
          : dimensions.padLength
        const layer = getGraphicsLayer(layerNames, [routePoint.layer])
        for (const center of [routePoint.start, routePoint.end]) {
          collections.rects.push({
            center,
            width: padWidth,
            height: padHeight,
            fill: safeTransparentize(jumperColor, 0.5),
            stroke: "rgba(0, 0, 0, 0.5)",
            layer,
            label: `${traceName}\n${routePoint.footprint} jumper pad`,
          })
        }
        collections.lines.push({
          points: [routePoint.start, routePoint.end],
          strokeColor: "rgba(100, 100, 100, 0.8)",
          strokeWidth: dimensions.padWidth * 0.3,
          layer,
          label: `${traceName}\n${routePoint.footprint} jumper`,
        })
      }
    }

    let currentWireLine: Line | undefined
    for (let index = 0; index < trace.route.length - 1; index++) {
      const routePoint = trace.route[index]!
      const nextRoutePoint = trace.route[index + 1]!
      if (
        routePoint.route_type !== "wire" ||
        nextRoutePoint.route_type !== "wire" ||
        routePoint.layer !== nextRoutePoint.layer ||
        isWireInsideJumper(routePoint, nextRoutePoint)
      ) {
        currentWireLine = undefined
        continue
      }
      const layerIndex = getLayerIndex(layerNames, routePoint.layer)
      const layer = `z${layerIndex}`
      if (
        currentWireLine &&
        currentWireLine.layer === layer &&
        currentWireLine.strokeWidth === routePoint.width
      ) {
        currentWireLine.points.push(nextRoutePoint)
        continue
      }
      const isTopLayer = routePoint.layer === "top"
      const baseColor = getCopperLayerColor(routePoint.layer)
      currentWireLine = {
        points: [routePoint, nextRoutePoint],
        strokeWidth: routePoint.width,
        strokeColor: isTopLayer
          ? baseColor
          : safeTransparentize(baseColor, 0.5),
        layer,
        ...(isTopLayer ? {} : { strokeDash: [0.2, 0.2] }),
      }
      collections.lines.push(currentWireLine)
    }
  }
}

const addStandaloneJumpers = (
  input: SimpleRouteJson,
  collections: VisualCollections,
) => {
  for (const jumper of input.jumpers ?? []) {
    for (const pad of jumper.pads) {
      addObstacle({
        collections,
        input,
        obstacle: pad,
        fill: "rgba(255, 165, 0, 0.3)",
        stroke: "rgba(255, 165, 0, 0.8)",
        label: `${jumper.jumper_footprint} standalone jumper pad`,
      })
    }
  }
}

export const visualizeSimpleRouteJson = (
  input: SimpleRouteJson,
): GraphicsObject => {
  const collections: VisualCollections = {
    circles: [],
    lines: [],
    points: [],
    polygons: [],
    rects: [],
  }
  const connectionColors = getConnectionColors(input)

  addBoardGeometry(input, collections)
  for (const obstacle of input.obstacles) {
    addObstacle({ collections, input, obstacle })
  }
  addConnectionPoints(input, collections, connectionColors)
  addLocalConnectionGuides(input, collections, connectionColors)
  addTraces(input, collections, connectionColors)
  addStandaloneJumpers(input, collections)

  return {
    coordinateSystem: "cartesian",
    title: `SimpleRouteJson · ${input.layerCount} layers`,
    ...collections,
  }
}
