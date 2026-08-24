import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { distance, EPS, gridKey, Q } from "../model/geometry"
import type {
  FanoutModel,
  FreeCell,
  FreeSpaceAnalysis,
  FreeSpaceRegions,
  FreeSpaceSample,
} from "../model/types"
import { visualizeModel } from "../visualize/modelVisuals"

/** Samples exactly one lattice/interstitial cell per step. */
export class SampleFreeSpaceCellsSolver extends BaseSolver {
  private row = 0
  private column = 0
  private readonly rowCount: number
  private readonly columnCount: number
  private readonly samplePitchX: number
  private readonly samplePitchY: number
  private readonly legalByGrid = new Map<string, FreeCell>()
  private activeCell: FreeCell | undefined
  private output: FreeSpaceSample | null = null

  constructor(private readonly model: FanoutModel) {
    super()
    this.samplePitchX = model.pitchX / 2
    this.samplePitchY = model.pitchY / 2
    this.rowCount =
      Math.round(
        (model.padBounds.maxY - model.padBounds.minY - model.pitchY) /
          this.samplePitchY,
      ) + 1
    this.columnCount =
      Math.round(
        (model.padBounds.maxX - model.padBounds.minX - model.pitchX) /
          this.samplePitchX,
      ) + 1
    this.MAX_ITERATIONS = Math.max(2, this.rowCount * this.columnCount + 2)
  }

  override getConstructorParams() {
    return [this.model]
  }

  override _setup() {
    this.updateStats("ready")
  }

  override _step() {
    if (this.model.nets.length === 0 || this.row >= this.rowCount) {
      this.output = {
        model: this.model,
        legalCells: [...this.legalByGrid.values()],
        rowCount: this.rowCount,
        columnCount: this.columnCount,
      }
      this.activeCell = undefined
      this.updateStats("completed")
      this.solved = true
      return
    }

    const cell: FreeCell = {
      x: Q(
        this.model.padBounds.minX +
          this.model.pitchX / 2 +
          this.column * this.samplePitchX,
      ),
      y: Q(
        this.model.padBounds.minY +
          this.model.pitchY / 2 +
          this.row * this.samplePitchY,
      ),
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
    const legal = cell.clearance + EPS >= this.model.rules.viaToPadClearance
    this.activeCell = cell
    if (legal) this.legalByGrid.set(gridKey(cell.row, cell.column), cell)

    this.column++
    if (this.column >= this.columnCount) {
      this.column = 0
      this.row++
    }
    this.updateStats(legal ? "accepted" : "rejected")
  }

  private updateStats(status: string) {
    this.stats = {
      action: "sample_cell",
      status,
      activeCell: this.activeCell
        ? gridKey(this.activeCell.row, this.activeCell.column)
        : null,
      sampled: Math.min(
        this.rowCount * this.columnCount,
        this.row * this.columnCount + this.column,
      ),
      totalCells: this.rowCount * this.columnCount,
      legalCells: this.legalByGrid.size,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : (this.row * this.columnCount + this.column) /
          Math.max(1, this.rowCount * this.columnCount)
  }

  override getOutput(): FreeSpaceSample {
    if (!this.solved || !this.output) {
      throw new Error(
        "SampleFreeSpaceCellsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeModel({
      model: this.model,
      freeCells: [...this.legalByGrid.values()],
      activeCell: this.activeCell,
    })
  }
}

/** Flood-fills exactly one accepted free-space cell per step. */
export class DiscoverFreeSpaceRegionsSolver extends BaseSolver {
  private readonly legalByGrid: Map<string, FreeCell>
  private readonly legalSeeds: FreeCell[]
  private readonly visited = new Set<string>()
  private readonly candidateRegions: FreeCell[][] = []
  private seedCursor = 0
  private queue: FreeCell[] = []
  private queueHead = 0
  private regionCells: FreeCell[] = []
  private activeCell: FreeCell | undefined
  private output: FreeSpaceRegions | null = null

  constructor(private readonly sample: FreeSpaceSample) {
    super()
    this.legalSeeds = sample.legalCells
    this.legalByGrid = new Map(
      sample.legalCells.map((cell) => [gridKey(cell.row, cell.column), cell]),
    )
    this.MAX_ITERATIONS = Math.max(2, sample.legalCells.length * 3 + 2)
  }

  override getConstructorParams() {
    return [this.sample]
  }

  override _setup() {
    this.updateStats("ready")
  }

  override _step() {
    const cell = this.queue[this.queueHead]
    if (cell) {
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
      this.updateStats("flood_cell")
      return
    }

    if (this.regionCells.length > 0) {
      this.candidateRegions.push(this.regionCells)
      this.regionCells = []
      this.queue = []
      this.queueHead = 0
      this.activeCell = undefined
      this.updateStats("complete_region")
      return
    }

    while (this.seedCursor < this.legalSeeds.length) {
      const seed = this.legalSeeds[this.seedCursor++]!
      const key = gridKey(seed.row, seed.column)
      if (this.visited.has(key)) continue
      this.visited.add(key)
      this.queue = [seed]
      this.queueHead = 0
      this.activeCell = seed
      this.updateStats("seed_region")
      return
    }

    this.output = {
      ...this.sample,
      candidateRegions: this.candidateRegions,
    }
    this.activeCell = undefined
    this.updateStats("completed")
    this.solved = true
  }

  private updateStats(action: string) {
    this.stats = {
      action,
      activeCell: this.activeCell
        ? gridKey(this.activeCell.row, this.activeCell.column)
        : null,
      visitedCells: this.visited.size,
      totalCells: this.legalSeeds.length,
      candidateRegions: this.candidateRegions.length,
      activeRegionCells: this.regionCells.length,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.visited.size / Math.max(1, this.legalSeeds.length)
  }

  override getOutput(): FreeSpaceRegions {
    if (!this.solved || !this.output) {
      throw new Error(
        "DiscoverFreeSpaceRegionsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeModel({
      model: this.sample.model,
      freeCells: this.sample.legalCells,
      activeCell: this.activeCell,
    })
  }
}

/** Tests exactly one cell for via-to-via packing per step. */
export class PackFreeSpaceRegionsSolver extends BaseSolver {
  private regionCursor = 0
  private packCandidates: FreeCell[] = []
  private packCursor = 0
  private packed: FreeCell[] = []
  private activeCell: FreeCell | undefined
  private readonly qualifyingRegions: FreeCell[][] = []
  private output: FreeSpaceAnalysis | null = null

  constructor(private readonly regions: FreeSpaceRegions) {
    super()
    this.MAX_ITERATIONS = Math.max(
      2,
      regions.candidateRegions.reduce((sum, region) => sum + region.length, 0) +
        regions.candidateRegions.length * 2 +
        2,
    )
  }

  override getConstructorParams() {
    return [this.regions]
  }

  override _setup() {
    this.updateStats("ready")
  }

  override _step() {
    if (this.packCandidates.length === 0) {
      const region = this.regions.candidateRegions[this.regionCursor]
      if (!region) {
        if (
          this.qualifyingRegions.length === 0 &&
          this.regions.model.nets.length > 0
        ) {
          const requiredPadEdge =
            this.regions.model.rules.viaDiameter / 2 +
            this.regions.model.rules.viaToPadClearance
          throw new Error(
            `[find_two_via_free_space/all] no connected free-space region can hold two vias (required pad-edge distance ${requiredPadEdge.toFixed(4)} mm)`,
          )
        }
        this.output = {
          model: this.regions.model,
          freeCells: this.qualifyingRegions.flat(),
          freeRegions: this.qualifyingRegions,
          legalCellCount: this.regions.legalCells.length,
        }
        this.activeCell = undefined
        this.updateStats("completed")
        this.solved = true
        return
      }
      this.packCandidates = [...region].sort(
        (first, second) =>
          second.clearance - first.clearance ||
          first.row - second.row ||
          first.column - second.column,
      )
      this.packCursor = 0
      this.packed = []
      this.updateStats("start_region")
      return
    }

    const cell = this.packCandidates[this.packCursor]
    if (cell) {
      this.packCursor++
      this.activeCell = cell
      const accepted = this.packed.every(
        (other) =>
          distance(cell, other) + EPS >=
          this.regions.model.rules.viaToViaCenter,
      )
      if (accepted) this.packed.push(cell)
      this.updateStats(accepted ? "accepted" : "rejected")
      return
    }

    const region = this.regions.candidateRegions[this.regionCursor]!
    if (this.packed.length >= 2) {
      const regionId = `free-region-${this.qualifyingRegions.length}`
      for (const item of region) item.regionId = regionId
      this.qualifyingRegions.push(region)
    }
    this.regionCursor++
    this.packCandidates = []
    this.packCursor = 0
    this.packed = []
    this.activeCell = undefined
    this.updateStats("complete_region")
  }

  private updateStats(action: string) {
    this.stats = {
      action,
      activeCell: this.activeCell
        ? gridKey(this.activeCell.row, this.activeCell.column)
        : null,
      processedRegions: this.regionCursor,
      totalRegions: this.regions.candidateRegions.length,
      qualifyingRegions: this.qualifyingRegions.length,
      packedCandidates: this.packed.length,
    }
  }

  computeProgress() {
    if (this.solved) return 1
    const totalRegions = Math.max(1, this.regions.candidateRegions.length)
    return Math.min(
      0.99,
      this.regionCursor / totalRegions +
        this.packCursor /
          Math.max(1, this.packCandidates.length) /
          totalRegions,
    )
  }

  override getOutput(): FreeSpaceAnalysis {
    if (!this.solved || !this.output) {
      throw new Error(
        "PackFreeSpaceRegionsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeModel({
      model: this.regions.model,
      freeCells: this.regions.legalCells,
      activeCell: this.activeCell,
    })
  }
}
