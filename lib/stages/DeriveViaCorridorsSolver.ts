import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { Q } from "../model/geometry"
import type {
  CorridorAnalysis,
  FreeCell,
  FreeSpaceAnalysis,
  ViaCorridor,
} from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

export class DeriveViaCorridorsSolver extends BaseSolver {
  private readonly analysis: FreeSpaceAnalysis
  private readonly corridors: ViaCorridor[] = []
  private regionCursor = 0
  private activeCells: FreeCell[] = []
  private output: CorridorAnalysis | null = null

  constructor(analysis: FreeSpaceAnalysis) {
    super()
    this.analysis = analysis
    this.MAX_ITERATIONS = analysis.freeRegions.length + 2
  }

  override getConstructorParams() {
    return [this.analysis]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const region = this.analysis.freeRegions[this.regionCursor]
    if (!region) {
      if (this.corridors.length === 0 && this.analysis.model.nets.length > 0) {
        throw new Error(
          "[derive_via_corridors/all] discovered free space contains no legal exterior via corridor",
        )
      }
      this.output = {
        ...this.analysis,
        viaCorridors: this.corridors.map((corridor) => ({
          ...corridor,
          cells: corridor.cells.map((cell) => ({ ...cell })),
        })),
      }
      this.solved = true
      this.updateStats()
      return
    }

    const model = this.analysis.model
    const viaRadius = model.rules.viaDiameter / 2
    const exteriorMinX = Q(
      model.padBounds.maxX + viaRadius + model.rules.viaToPadClearance,
    )
    this.activeCells = region.filter((cell) => cell.x >= exteriorMinX)
    if (this.activeCells.length > 0) {
      const halfCellX = model.pitchX / 4
      const halfCellY = model.pitchY / 4
      const regionId = region[0]?.regionId ?? `free-region-${this.regionCursor}`
      this.corridors.push({
        id: `via-corridor-${this.corridors.length}`,
        regionId,
        minX: Math.max(
          exteriorMinX,
          Q(Math.min(...this.activeCells.map((cell) => cell.x)) - halfCellX),
        ),
        maxX: Math.min(
          model.routingBounds.maxX - viaRadius,
          Q(Math.max(...this.activeCells.map((cell) => cell.x)) + halfCellX),
        ),
        minY: Math.max(
          model.routingBounds.minY + viaRadius,
          Q(Math.min(...this.activeCells.map((cell) => cell.y)) - halfCellY),
        ),
        maxY: Math.min(
          model.routingBounds.maxY - viaRadius,
          Q(Math.max(...this.activeCells.map((cell) => cell.y)) + halfCellY),
        ),
        cells: this.activeCells.map((cell) => ({ ...cell })),
      })
    }
    this.regionCursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "deriveViaCorridors",
      processedRegions: this.regionCursor,
      totalRegions: this.analysis.freeRegions.length,
      derivedCorridors: this.corridors.length,
      activeExteriorCells: this.activeCells.length,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.regionCursor / Math.max(1, this.analysis.freeRegions.length)
  }

  override getOutput(): CorridorAnalysis {
    if (!this.solved || !this.output) {
      throw new Error(
        "DeriveViaCorridorsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.analysis.model,
      corridors: this.corridors,
      stage: "derive via corridors",
      progress: this.computeProgress(),
      counts: `${this.corridors.length} corridors · ${this.activeCells.length} active cells`,
    })
  }
}
