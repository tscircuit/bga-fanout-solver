import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { distance, EPS, gridKey, Q } from "../model/geometry"
import type { FanoutModel, FreeCell, FreeSpaceAnalysis } from "../model/types"
import { pointSegmentDistance } from "../routing/routeGeometry"
import { visualizeModel } from "../visualize/modelVisuals"

type Phase = "sample" | "seed" | "flood" | "pack" | "finish"

export class FindFreeSpaceSolver extends BaseSolver {
  private readonly model: FanoutModel
  private phase: Phase = "sample"
  private row = 0
  private column = 0
  private readonly rowCount: number
  private readonly columnCount: number
  private readonly samplePitchX: number
  private readonly samplePitchY: number
  private readonly sampleMinX: number
  private readonly sampleMinY: number
  private readonly legalByGrid = new Map<string, FreeCell>()
  private legalSeeds: FreeCell[] = []
  private seedCursor = 0
  private readonly visited = new Set<string>()
  private queue: FreeCell[] = []
  private queueHead = 0
  private regionCells: FreeCell[] = []
  private packCandidates: FreeCell[] = []
  private packCursor = 0
  private packed: FreeCell[] = []
  private readonly qualifyingRegions: FreeCell[][] = []
  private activeCell: FreeCell | undefined
  private output: FreeSpaceAnalysis | null = null

  constructor(model: FanoutModel) {
    super()
    this.model = model
    this.samplePitchX = model.pitchX / 2
    this.samplePitchY = model.pitchY / 2
    const viaRadius = model.rules.viaDiameter / 2
    this.sampleMinX = Q(model.routingBounds.minX + viaRadius)
    this.sampleMinY = Q(model.routingBounds.minY + viaRadius)
    const sampleMaxX = model.routingBounds.maxX - viaRadius
    const sampleMaxY = model.routingBounds.maxY - viaRadius
    this.rowCount =
      Math.floor((sampleMaxY - this.sampleMinY) / this.samplePitchY) + 1
    this.columnCount =
      Math.floor((sampleMaxX - this.sampleMinX) / this.samplePitchX) + 1
    this.MAX_ITERATIONS =
      Math.max(1, this.rowCount * this.columnCount * 5) + 100
  }

  override getConstructorParams() {
    return [this.model]
  }

  override _setup() {
    if (this.model.nets.length === 0) this.phase = "finish"
    this.updateStats()
  }

  override _step() {
    if (this.phase === "sample") this.sampleCell()
    else if (this.phase === "seed") this.seedRegion()
    else if (this.phase === "flood") this.floodCell()
    else if (this.phase === "pack") this.packCell()
    else this.finish()
    this.updateStats()
  }

  private sampleCell() {
    if (this.row >= this.rowCount) {
      this.legalSeeds = [...this.legalByGrid.values()]
      this.activeCell = undefined
      this.phase = "seed"
      return
    }
    const cell: FreeCell = {
      x: Q(this.sampleMinX + this.column * this.samplePitchX),
      y: Q(this.sampleMinY + this.row * this.samplePitchY),
      row: this.row,
      column: this.column,
      clearance: 0,
    }
    cell.clearance =
      this.model.pads.reduce(
        (minimum, pad) => Math.min(minimum, distance(cell, pad) - pad.radius),
        Number.POSITIVE_INFINITY,
      ) -
      this.model.rules.viaDiameter / 2
    const previousViaLegal = this.model.previousVias.every(
      (via) => distance(cell, via) + EPS >= this.model.rules.viaToViaCenter,
    )
    const requiredTraceCenterDistance =
      this.model.rules.viaDiameter / 2 +
      this.model.rules.traceWidth / 2 +
      this.model.rules.traceToViaClearance
    const previousTraceLegal = this.model.previousSegments.every(
      (segment) =>
        pointSegmentDistance(cell, segment.a, segment.b) + EPS >=
        requiredTraceCenterDistance,
    )
    this.activeCell = cell
    if (
      cell.clearance + EPS >= this.model.rules.viaToPadClearance &&
      previousViaLegal &&
      previousTraceLegal
    ) {
      this.legalByGrid.set(gridKey(cell.row, cell.column), cell)
    }
    this.column++
    if (this.column >= this.columnCount) {
      this.column = 0
      this.row++
    }
  }

  private seedRegion() {
    while (this.seedCursor < this.legalSeeds.length) {
      const seed = this.legalSeeds[this.seedCursor++]!
      const seedKey = gridKey(seed.row, seed.column)
      if (this.visited.has(seedKey)) continue
      this.visited.add(seedKey)
      this.queue = [seed]
      this.queueHead = 0
      this.regionCells = []
      this.activeCell = seed
      this.phase = "flood"
      return
    }
    this.activeCell = undefined
    this.phase = "finish"
  }

  private floodCell() {
    const cell = this.queue[this.queueHead]
    if (!cell) {
      this.packCandidates = [...this.regionCells].sort(
        (first, second) =>
          second.clearance - first.clearance ||
          first.row - second.row ||
          first.column - second.column,
      )
      this.packCursor = 0
      this.packed = []
      this.activeCell = undefined
      this.phase = "pack"
      return
    }
    this.queueHead++
    this.regionCells.push(cell)
    this.activeCell = cell
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const key = gridKey(cell.row + dr, cell.column + dc)
      const next = this.legalByGrid.get(key)
      if (!next || this.visited.has(key)) continue
      this.visited.add(key)
      this.queue.push(next)
    }
  }

  private packCell() {
    const cell = this.packCandidates[this.packCursor]
    if (cell) {
      this.packCursor++
      this.activeCell = cell
      if (
        this.packed.every(
          (other) =>
            distance(cell, other) + EPS >= this.model.rules.viaToViaCenter,
        )
      ) {
        this.packed.push(cell)
      }
      return
    }
    if (this.packed.length >= 2) {
      const regionId = `free-region-${this.qualifyingRegions.length}`
      for (const item of this.regionCells) item.regionId = regionId
      this.qualifyingRegions.push(this.regionCells)
    }
    this.activeCell = undefined
    this.phase = "seed"
  }

  private finish() {
    if (this.qualifyingRegions.length === 0 && this.model.nets.length > 0) {
      const requiredPadEdge =
        this.model.rules.viaDiameter / 2 + this.model.rules.viaToPadClearance
      throw new Error(
        `[find_two_via_free_space/all] no connected free-space region can hold two vias (required pad-edge distance ${requiredPadEdge.toFixed(4)} mm)`,
      )
    }
    this.output = {
      model: this.model,
      freeCells: this.qualifyingRegions.flat(),
      freeRegions: this.qualifyingRegions,
      legalCellCount: this.legalByGrid.size,
    }
    this.solved = true
  }

  private updateStats() {
    this.stats = {
      phase: this.phase,
      sampled: Math.min(
        this.rowCount * this.columnCount,
        this.row * this.columnCount + this.column,
      ),
      legalCells: this.legalByGrid.size,
      connectedRegions: this.qualifyingRegions.length,
      floodedCells: this.visited.size,
      packedCandidates: this.packed.length,
    }
  }

  computeProgress() {
    const samples = Math.max(1, this.rowCount * this.columnCount)
    if (this.solved) return 1
    if (this.phase === "sample") {
      return (this.row * this.columnCount + this.column) / (samples * 2)
    }
    const explored = this.visited.size + this.packCursor
    return Math.min(0.99, 0.5 + explored / Math.max(1, samples * 3))
  }

  override getOutput(): FreeSpaceAnalysis {
    if (!this.solved || !this.output) {
      throw new Error("FindFreeSpaceSolver output requested before completion")
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeModel({
      model: this.model,
      freeCells: [...this.legalByGrid.values()],
      activeCell: this.activeCell,
      stage: `find free space · ${this.phase}`,
      progress: this.computeProgress(),
      counts: `${this.legalByGrid.size} legal · ${this.qualifyingRegions.length} regions`,
    })
  }
}
