import type { SimpleRouteJson } from "@tscircuit/core"
import {
  compareCanonicalNetOrder,
  getPointObstacle,
  getRules,
  inferPitch,
  Q,
  toCanonical,
} from "./geometry"
import type {
  FanoutModel,
  FanoutNet,
  FanoutPad,
  LayeredSegment,
  LayeredVia,
} from "./types"

export const buildFanoutModel = (sourceInput: SimpleRouteJson): FanoutModel => {
  const input = structuredClone(sourceInput)
  const rules = getRules(input)

  if (input.connections.length === 0) {
    return {
      input,
      rules,
      nets: [],
      pads: [],
      componentId: "empty",
      axisSign: 1,
      pitchX: 1,
      pitchY: 1,
      padBounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      routingBounds: { ...input.bounds },
      previousSegments: [],
      previousVias: [],
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
    throw new Error(
      "[build_pad_topology/all] no source BGA component can be identified from connection point IDs",
    )
  }

  const sourceAndTarget = input.connections.map((connection) => {
    if (connection.pointsToConnect.length !== 2) {
      throw new Error(
        `[build_pad_topology/${connection.name}] expected exactly two connection points, got ${connection.pointsToConnect.length}`,
      )
    }
    const sourceIndex = connection.pointsToConnect.findIndex(
      (point) => getPointObstacle(input, point)?.componentId === componentId,
    )
    if (sourceIndex < 0) {
      throw new Error(
        `[build_pad_topology/${connection.name}] cannot identify the BGA source point`,
      )
    }
    return {
      connection,
      source: connection.pointsToConnect[sourceIndex]!,
      target: connection.pointsToConnect[sourceIndex === 0 ? 1 : 0]!,
    }
  })

  const averageSourceX =
    sourceAndTarget.reduce((sum, item) => sum + item.source.x, 0) /
    sourceAndTarget.length
  const averageTargetX =
    sourceAndTarget.reduce((sum, item) => sum + item.target.x, 0) /
    sourceAndTarget.length
  const axisSign: 1 | -1 = averageTargetX >= averageSourceX ? 1 : -1

  const componentObstacles = input.obstacles.filter(
    (obstacle) =>
      obstacle.componentId === componentId && obstacle.layers.includes("top"),
  )
  if (componentObstacles.length < sourceAndTarget.length) {
    throw new Error(
      `[build_pad_topology/all] identified only ${componentObstacles.length} top-layer pads for ${sourceAndTarget.length} sources`,
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
  const pads: FanoutPad[] = canonicalObstacleCenters.map(
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
        throw new Error(
          `[build_pad_topology/${connectionName}] connection belongs to more than one fanout bus`,
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
        throw new Error(
          `[build_pad_topology/${connection.name}] no prescribed fanout layer is present in the SRJ`,
        )
      }
      return {
        connection,
        connectionName: connection.name,
        source: { ...source, ...toCanonical(axisSign, source) },
        target: { ...target, ...toCanonical(axisSign, target) },
        selectedLayer,
        busId: bus?.busId ?? `ungrouped:${connection.name}`,
        sourceTraceId: connection.source_trace_id,
        busRank: bus?.connectionNames.indexOf(connection.name) ?? rank,
        rank,
      }
    },
  )
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
    previousSegments,
    previousVias,
  }
}
