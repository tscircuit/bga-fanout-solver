import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { EPS } from "../model/geometry"
import type { ViaLine, ViaLineCandidatePlan, ViaLinePlan } from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

export class PlaceViaRowsAndSlotsSolver extends BaseSolver {
  private readonly plan: ViaLineCandidatePlan
  private readonly lines: ViaLine[] = []
  private cursor = 0
  private output: ViaLinePlan | null = null

  constructor(plan: ViaLineCandidatePlan) {
    super()
    this.plan = plan
    this.MAX_ITERATIONS = plan.busGroups.length + 2
  }

  override getConstructorParams() {
    return [this.plan]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const group = this.plan.busGroups[this.cursor]
    if (!group) {
      this.output = { ...this.plan, viaLines: this.lines }
      this.solved = true
      this.updateStats()
      return
    }
    const rowPitch = Math.max(
      this.plan.model.rules.viaToViaCenter,
      this.plan.model.rules.viaDiameter + this.plan.model.rules.traceClearance,
    )
    const minimumY =
      (this.lines.at(-1)?.y ?? Number.NEGATIVE_INFINITY) + rowPitch
    const candidate = this.plan.viaLineCandidates
      .filter((item) => item.groupId === group.id && item.y + EPS >= minimumY)
      .sort(
        (first, second) =>
          Math.abs(first.y - group.desiredY) -
            Math.abs(second.y - group.desiredY) ||
          first.y - second.y ||
          first.id.localeCompare(second.id),
      )[0]
    if (!candidate) {
      throw new Error(
        `[place_via_rows/${group.id}] legal corridor rows cannot preserve via spacing and bus order`,
      )
    }
    this.lines.push({
      id: group.id,
      groupId: group.id,
      corridorId: candidate.corridorId,
      y: candidate.y,
      slots: candidate.slotXs.map((x, slotIndex) => ({
        x,
        y: candidate.y,
        slotIndex,
      })),
    })
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "placeViaRowsAndSlots",
      placedLines: this.lines.length,
      totalLines: this.plan.busGroups.length,
      placedSlots: this.lines.reduce((sum, line) => sum + line.slots.length, 0),
      activeGroup: this.plan.busGroups[this.cursor]?.id ?? null,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.plan.busGroups.length)
  }

  override getOutput(): ViaLinePlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "PlaceViaRowsAndSlotsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.plan.model,
      corridors: this.plan.viaCorridors,
      viaLineCandidates: this.plan.viaLineCandidates,
      viaLines: this.lines,
      stage: "place via rows and slots",
      progress: this.computeProgress(),
      counts: `${this.lines.length}/${this.plan.busGroups.length} lines`,
    })
  }
}
