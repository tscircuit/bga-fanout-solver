import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type { CorridorAnalysis, RankedFanoutModel } from "../model/types"
import { visualizeModel } from "../visualize/modelVisuals"

export class RankFanoutNetsSolver extends BaseSolver {
  private readonly analysis: CorridorAnalysis
  private cursor = 0
  private output: RankedFanoutModel | null = null

  constructor(analysis: CorridorAnalysis) {
    super()
    this.analysis = {
      ...analysis,
      model: {
        ...analysis.model,
        nets: analysis.model.nets.map((net) => ({ ...net })),
      },
    }
    this.MAX_ITERATIONS = analysis.model.nets.length + 2
  }

  override getConstructorParams() {
    return [this.analysis]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const net = this.analysis.model.nets[this.cursor]
    if (net) {
      const row = Math.round(
        (net.source.y -
          (this.analysis.model.padBounds.minY +
            this.analysis.model.pitchY / 2)) /
          (this.analysis.model.pitchY / 2),
      )
      const column = Math.round(
        (net.source.x -
          (this.analysis.model.padBounds.minX +
            this.analysis.model.pitchX / 2)) /
          (this.analysis.model.pitchX / 2),
      )
      net.rank = Math.min(
        ...this.analysis.freeCells.map(
          (cell) => Math.abs(cell.row - row) + Math.abs(cell.column - column),
        ),
      )
      this.cursor++
      this.updateStats()
      return
    }
    this.output = this.analysis
    this.solved = true
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      rankedConnections: this.cursor,
      totalConnections: this.analysis.model.nets.length,
      activeConnection:
        this.analysis.model.nets[this.cursor]?.connectionName ?? null,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.analysis.model.nets.length)
  }

  override getOutput(): RankedFanoutModel {
    if (!this.solved || !this.output) {
      throw new Error("RankFanoutNetsSolver output requested before completion")
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeModel({
      model: this.analysis.model,
      freeCells: this.analysis.freeCells,
      rankedNets: this.analysis.model.nets.slice(0, this.cursor),
      stage: "rank fanout nets",
      progress: this.computeProgress(),
      counts: `${this.cursor}/${this.analysis.model.nets.length} ranked`,
    })
  }
}
