import type { AutorouterProgressEvent, SimpleRouteJson } from "@tscircuit/core"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  FixedTargetBgaFanoutOutput,
  RankedFanoutModel,
} from "../model/types"
import { layerColor } from "../visualize/modelVisuals"
import { solveAm62lFreeSpaceFanout } from "./reference/solve-am62l-free-space-fanout"

type CompatibilityRouteSolverParams = {
  input: SimpleRouteJson
  rankedModel: RankedFanoutModel
}

/**
 * Temporary parity boundary for routing phases that have not yet been split
 * into BaseSolver leaf stages. It intentionally performs one honest, atomic
 * compatibility step and is private so consumers cannot depend on it.
 */
export class CompatibilityRouteSolver extends BaseSolver {
  private readonly input: SimpleRouteJson
  private readonly rankedModel: RankedFanoutModel
  private output: FixedTargetBgaFanoutOutput | null = null
  private readonly completedPhases: string[] = []

  constructor({ input, rankedModel }: CompatibilityRouteSolverParams) {
    super()
    this.input = structuredClone(input)
    this.rankedModel = rankedModel
    this.MAX_ITERATIONS = 1
  }

  override getConstructorParams() {
    return [
      { input: structuredClone(this.input), rankedModel: this.rankedModel },
    ]
  }

  override _setup() {
    this.stats = {
      extractionBoundary: "private monolithic parity oracle",
      completedPhases: 0,
      totalConnections: this.input.connections.length,
    }
  }

  override _step() {
    const result = solveAm62lFreeSpaceFanout(
      structuredClone(this.input),
      (event: AutorouterProgressEvent) => {
        if (event.type === "progress" && event.phase) {
          this.completedPhases.push(event.phase)
        }
      },
    )
    this.output = {
      ...result,
      phases: [...this.completedPhases],
    }
    this.stats = {
      extractionBoundary: "private monolithic parity oracle",
      completedPhases: this.completedPhases.length,
      totalConnections: this.input.connections.length,
      traces: result.traces.length,
    }
    this.solved = true
  }

  computeProgress() {
    return this.solved ? 1 : 0
  }

  override getOutput(): FixedTargetBgaFanoutOutput {
    if (!this.solved || !this.output) {
      throw new Error(
        "CompatibilityRouteSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    const traces = this.output?.traces ?? []
    const circles: NonNullable<GraphicsObject["circles"]> = [
      ...this.rankedModel.model.pads.map((pad) => ({
        center: {
          x: this.rankedModel.model.axisSign * pad.x,
          y: pad.y,
        },
        radius: pad.radius,
        fill: "#e2e8f0",
        stroke: "#64748b",
      })),
    ]
    const lines: NonNullable<GraphicsObject["lines"]> = []
    for (const trace of traces) {
      let priorWire:
        | { route_type: "wire"; x: number; y: number; layer: string }
        | undefined
      for (const routePoint of trace.route) {
        if (routePoint.route_type === "wire") {
          if (priorWire && priorWire.layer === routePoint.layer) {
            lines.push({
              points: [priorWire, routePoint],
              strokeWidth: Math.max(
                0.025,
                "width" in routePoint ? routePoint.width : 0.08,
              ),
              strokeColor: layerColor(routePoint.layer),
              layer: routePoint.layer,
              label: trace.connection_name,
            })
          }
          priorWire = routePoint
        } else if (routePoint.route_type === "via") {
          circles.push({
            center: routePoint,
            radius:
              ("via_diameter" in routePoint
                ? (routePoint.via_diameter ??
                  this.rankedModel.model.rules.viaDiameter)
                : this.rankedModel.model.rules.viaDiameter) / 2,
            fill: "#f59e0b",
            stroke: "#78350f",
            label: trace.connection_name,
          })
          priorWire = undefined
        } else {
          priorWire = undefined
        }
      }
    }
    return { coordinateSystem: "cartesian", circles, lines }
  }
}
