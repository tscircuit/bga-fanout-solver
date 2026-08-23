import type { SimpleRouteJson } from "@tscircuit/core"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import {
  compareCanonicalNetOrder,
  getPointObstacle,
  getRules,
  inferPitch,
  Q,
  toCanonical,
} from "../model/geometry"
import type {
  FanoutModel,
  FanoutNet,
  FanoutPad,
  LayeredSegment,
  LayeredVia,
} from "../model/types"
import { visualizeInput } from "../visualize/inputVisuals"
import { visualizeModel } from "../visualize/modelVisuals"

type Phase =
  | "identify-component"
  | "collect-pads"
  | "build-nets"
  | "collect-copper"
  | "finalize"

type SourceAndTarget = {
  connection: SimpleRouteJson["connections"][number]
  source: SimpleRouteJson["connections"][number]["pointsToConnect"][number]
  target: SimpleRouteJson["connections"][number]["pointsToConnect"][number]
}

export class BuildFanoutModelSolver extends BaseSolver {
  private readonly input: SimpleRouteJson
  private phase: Phase = "identify-component"
  private cursor = 0
  private readonly sourceComponents = new Map<string, number>()
  private componentId = ""
  private axisSign: 1 | -1 = 1
  private sourceAndTarget: SourceAndTarget[] = []
  private componentObstacles: SimpleRouteJson["obstacles"] = []
  private readonly canonicalObstacleCenters: Array<{
    obstacle: SimpleRouteJson["obstacles"][number]
    x: number
    y: number
  }> = []
  private readonly pads: FanoutPad[] = []
  private readonly nets: FanoutNet[] = []
  private readonly previousSegments: LayeredSegment[] = []
  private readonly previousVias: LayeredVia[] = []
  private pitchX = 1
  private pitchY = 1
  private output: FanoutModel | null = null

  constructor(input: SimpleRouteJson) {
    super()
    this.input = structuredClone(input)
    this.MAX_ITERATIONS =
      input.connections.length * 3 + input.obstacles.length + 100
  }

  override getConstructorParams() {
    return [structuredClone(this.input)]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    if (this.phase === "identify-component") {
      this.identifyComponentStep()
    } else if (this.phase === "collect-pads") {
      this.collectPadStep()
    } else if (this.phase === "build-nets") {
      this.buildNetStep()
    } else if (this.phase === "collect-copper") {
      this.collectCopperStep()
    } else {
      this.finalizeModel()
    }
    this.updateStats()
  }

  private identifyComponentStep() {
    const connection = this.input.connections[this.cursor]
    if (connection) {
      for (const point of connection.pointsToConnect) {
        const componentId = getPointObstacle(this.input, point)?.componentId
        if (componentId) {
          this.sourceComponents.set(
            componentId,
            (this.sourceComponents.get(componentId) ?? 0) + 1,
          )
        }
      }
      this.cursor++
      return
    }

    if (this.input.connections.length === 0) {
      this.componentId = "empty"
      this.phase = "finalize"
      this.cursor = 0
      return
    }

    this.componentId =
      [...this.sourceComponents].sort(
        ([firstId, firstCount], [secondId, secondCount]) =>
          secondCount - firstCount || firstId.localeCompare(secondId),
      )[0]?.[0] ?? ""
    if (!this.componentId) {
      throw new Error(
        "[build_pad_topology/all] no source BGA component can be identified from connection point IDs",
      )
    }

    this.sourceAndTarget = this.input.connections.map((item) => {
      if (item.pointsToConnect.length !== 2) {
        throw new Error(
          `[build_pad_topology/${item.name}] expected exactly two connection points, got ${item.pointsToConnect.length}`,
        )
      }
      const sourceIndex = item.pointsToConnect.findIndex(
        (point) =>
          getPointObstacle(this.input, point)?.componentId === this.componentId,
      )
      if (sourceIndex < 0) {
        throw new Error(
          `[build_pad_topology/${item.name}] cannot identify the BGA source point`,
        )
      }
      return {
        connection: item,
        source: item.pointsToConnect[sourceIndex]!,
        target: item.pointsToConnect[sourceIndex === 0 ? 1 : 0]!,
      }
    })
    const averageSourceX =
      this.sourceAndTarget.reduce((sum, item) => sum + item.source.x, 0) /
      this.sourceAndTarget.length
    const averageTargetX =
      this.sourceAndTarget.reduce((sum, item) => sum + item.target.x, 0) /
      this.sourceAndTarget.length
    this.axisSign = averageTargetX >= averageSourceX ? 1 : -1
    this.componentObstacles = this.input.obstacles.filter(
      (obstacle) =>
        obstacle.componentId === this.componentId &&
        obstacle.layers.includes("top"),
    )
    if (this.componentObstacles.length < this.sourceAndTarget.length) {
      throw new Error(
        `[build_pad_topology/all] identified only ${this.componentObstacles.length} top-layer pads for ${this.sourceAndTarget.length} sources`,
      )
    }
    this.cursor = 0
    this.phase = "collect-pads"
  }

  private collectPadStep() {
    const obstacle = this.componentObstacles[this.cursor]
    if (obstacle) {
      this.canonicalObstacleCenters.push({
        obstacle,
        ...toCanonical(this.axisSign, obstacle.center),
      })
      this.cursor++
      return
    }

    this.pitchX = inferPitch(
      this.canonicalObstacleCenters.map((pad) => pad.x),
      "x",
    )
    this.pitchY = inferPitch(
      this.canonicalObstacleCenters.map((pad) => pad.y),
      "y",
    )
    const minPadX = Math.min(
      ...this.canonicalObstacleCenters.map((pad) => pad.x),
    )
    const minPadY = Math.min(
      ...this.canonicalObstacleCenters.map((pad) => pad.y),
    )
    this.pads.push(
      ...this.canonicalObstacleCenters.map(
        ({ obstacle: item, x, y }, index) => ({
          id:
            item.circuitJsonMetadata?.pcb_smtpad_id ??
            item.obstacleId ??
            `pad-${index}`,
          x,
          y,
          radius: Math.max(item.width, item.height) / 2,
          column: Math.round((x - minPadX) / this.pitchX),
          row: Math.round((y - minPadY) / this.pitchY),
        }),
      ),
    )
    this.cursor = 0
    this.phase = "build-nets"
  }

  private buildNetStep() {
    const item = this.sourceAndTarget[this.cursor]
    if (!item) {
      this.nets.sort(compareCanonicalNetOrder)
      this.cursor = 0
      this.phase = "collect-copper"
      return
    }

    const buses = (this.input.buses ?? []).filter((bus) =>
      bus.connectionNames.includes(item.connection.name),
    )
    if (buses.length > 1) {
      throw new Error(
        `[build_pad_topology/${item.connection.name}] connection belongs to more than one fanout bus`,
      )
    }
    const bus = buses[0]
    const selectedLayer =
      bus?.termination?.type === "plane"
        ? bus.termination.layer
        : item.target.layer !== "top"
          ? item.target.layer
          : (bus?.preferredLayer ??
            bus?.preferredLayers?.[0] ??
            item.target.layer)
    if (!selectedLayer) {
      throw new Error(
        `[build_pad_topology/${item.connection.name}] no prescribed fanout layer is present in the SRJ`,
      )
    }
    const source = {
      ...item.source,
      ...toCanonical(this.axisSign, item.source),
    }
    const target = {
      ...item.target,
      ...toCanonical(this.axisSign, item.target),
    }
    this.nets.push({
      connection: item.connection,
      connectionName: item.connection.name,
      source,
      target,
      selectedLayer,
      busId: bus?.busId ?? `ungrouped:${item.connection.name}`,
      sourceTraceId: item.connection.source_trace_id,
      busRank:
        bus?.connectionNames.indexOf(item.connection.name) ?? this.cursor,
      rank: this.cursor,
    })
    this.cursor++
  }

  private collectCopperStep() {
    const trace = (this.input.traces ?? [])[this.cursor]
    if (!trace) {
      this.cursor = 0
      this.phase = "finalize"
      return
    }
    let priorWire:
      | { route_type: "wire"; x: number; y: number; layer: string }
      | undefined
    for (const routePoint of trace.route) {
      if (routePoint.route_type === "wire") {
        if (priorWire && priorWire.layer === routePoint.layer) {
          this.previousSegments.push({
            a: toCanonical(this.axisSign, priorWire),
            b: toCanonical(this.axisSign, routePoint),
            layer: routePoint.layer,
            connectionName: trace.connection_name,
          })
        }
        priorWire = routePoint
      } else if (routePoint.route_type === "via") {
        this.previousVias.push({
          ...toCanonical(this.axisSign, routePoint),
          fromLayer: routePoint.from_layer,
          toLayer: routePoint.to_layer,
        })
        priorWire = undefined
      } else {
        priorWire = undefined
      }
    }
    this.cursor++
  }

  private finalizeModel() {
    const canonicalBounds = [
      toCanonical(this.axisSign, {
        x: this.input.bounds.minX,
        y: this.input.bounds.minY,
      }),
      toCanonical(this.axisSign, {
        x: this.input.bounds.maxX,
        y: this.input.bounds.maxY,
      }),
    ]
    const padXs = this.canonicalObstacleCenters.map((pad) => pad.x)
    const padYs = this.canonicalObstacleCenters.map((pad) => pad.y)
    const minPadX = padXs.length ? Math.min(...padXs) : 0
    const maxPadX = padXs.length ? Math.max(...padXs) : 0
    const minPadY = padYs.length ? Math.min(...padYs) : 0
    const maxPadY = padYs.length ? Math.max(...padYs) : 0
    this.output = {
      input: structuredClone(this.input),
      rules: getRules(this.input),
      nets: this.nets,
      pads: this.pads,
      componentId: this.componentId,
      axisSign: this.axisSign,
      pitchX: this.pitchX,
      pitchY: this.pitchY,
      padBounds: {
        minX: Q(minPadX - this.pitchX / 2),
        maxX: Q(maxPadX + this.pitchX / 2),
        minY: Q(minPadY - this.pitchY / 2),
        maxY: Q(maxPadY + this.pitchY / 2),
      },
      routingBounds: {
        minX: Math.min(...canonicalBounds.map((point) => point.x)),
        maxX: Math.max(...canonicalBounds.map((point) => point.x)),
        minY: this.input.bounds.minY,
        maxY: this.input.bounds.maxY,
      },
      previousSegments: this.previousSegments,
      previousVias: this.previousVias,
    }
    this.solved = true
  }

  private updateStats() {
    this.stats = {
      phase: this.phase,
      scannedConnections:
        this.phase === "identify-component"
          ? this.cursor
          : this.input.connections.length,
      pads: this.pads.length,
      nets: this.nets.length,
      existingSegments: this.previousSegments.length,
      existingVias: this.previousVias.length,
    }
  }

  computeProgress() {
    const connectionWork = Math.max(1, this.input.connections.length)
    const padWork = Math.max(1, this.componentObstacles.length)
    const traceWork = Math.max(1, (this.input.traces ?? []).length)
    const total = connectionWork * 2 + padWork + traceWork + 1
    const completed =
      this.phase === "identify-component"
        ? this.cursor
        : this.phase === "collect-pads"
          ? connectionWork + this.cursor
          : this.phase === "build-nets"
            ? connectionWork + padWork + this.cursor
            : this.phase === "collect-copper"
              ? connectionWork * 2 + padWork + this.cursor
              : total - 1
    return this.solved ? 1 : Math.min(0.99, completed / total)
  }

  override getOutput(): FanoutModel {
    if (!this.solved || !this.output) {
      throw new Error(
        "BuildFanoutModelSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    if (!this.output) return visualizeInput(this.input)
    return visualizeModel({ model: this.output })
  }
}
