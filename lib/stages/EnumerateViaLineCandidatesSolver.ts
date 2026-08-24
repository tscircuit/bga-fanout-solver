import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { distance, EPS, Q } from "../model/geometry"
import type {
  BusGroupPlan,
  ViaLineCandidate,
  ViaLineCandidatePlan,
} from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

type PendingCandidate = {
  groupId: string
  corridorId: string
  y: number
}

export class EnumerateViaLineCandidatesSolver extends BaseSolver {
  private readonly plan: BusGroupPlan
  private readonly pending: PendingCandidate[] = []
  private readonly candidates: ViaLineCandidate[] = []
  private cursor = 0
  private output: ViaLineCandidatePlan | null = null

  constructor(plan: BusGroupPlan) {
    super()
    this.plan = plan
  }

  override getConstructorParams() {
    return [this.plan]
  }

  override _setup() {
    for (const group of this.plan.busGroups) {
      for (const corridor of this.plan.viaCorridors) {
        const rowYs = [
          ...new Set(
            corridor.cells
              .map((cell) => cell.y)
              .filter(
                (y) => y >= corridor.minY - EPS && y <= corridor.maxY + EPS,
              ),
          ),
        ].sort((first, second) => first - second)
        for (const y of rowYs) {
          this.pending.push({ groupId: group.id, corridorId: corridor.id, y })
        }
      }
    }
    this.MAX_ITERATIONS = this.pending.length + 2
    this.updateStats()
  }

  override _step() {
    const pending = this.pending[this.cursor]
    if (!pending) {
      if (this.candidates.length === 0 && this.plan.model.nets.length > 0) {
        throw new Error(
          "[enumerate_via_line_candidates/all] no legal via-line candidate can hold a bus string",
        )
      }
      this.output = { ...this.plan, viaLineCandidates: this.candidates }
      this.solved = true
      this.updateStats()
      return
    }
    const model = this.plan.model
    const group = this.plan.busGroups.find(
      (item) => item.id === pending.groupId,
    )!
    const corridor = this.plan.viaCorridors.find(
      (item) => item.id === pending.corridorId,
    )!
    const slotPitch = Math.max(
      model.rules.viaToViaCenter,
      model.rules.viaDiameter + model.rules.traceClearance,
    )
    const viaRadius = model.rules.viaDiameter / 2
    const firstSlotX = Math.max(
      corridor.minX,
      Q(model.padBounds.maxX + viaRadius + model.rules.viaToPadClearance),
    )
    const slotXs = group.connectionNames.map((_, slotIndex) =>
      Q(firstSlotX + slotIndex * slotPitch),
    )
    const withinCorridor =
      (slotXs.at(-1) ?? firstSlotX) + viaRadius <= corridor.maxX + EPS
    const padLegal = slotXs.every((x) =>
      model.pads.every(
        (pad) =>
          distance({ x, y: pending.y }, pad) + EPS >=
          viaRadius + pad.radius + model.rules.viaToPadClearance,
      ),
    )
    if (withinCorridor && padLegal) {
      this.candidates.push({
        id: `candidate:${pending.groupId}:${pending.corridorId}:${pending.y}`,
        groupId: pending.groupId,
        corridorId: pending.corridorId,
        y: pending.y,
        slotXs,
        displacement: Math.abs(pending.y - group.desiredY),
      })
    }
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "enumerateViaLineCandidates",
      evaluatedCandidates: this.cursor,
      totalCandidates: this.pending.length,
      legalCandidates: this.candidates.length,
      activeGroup: this.pending[this.cursor]?.groupId ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.pending.length)
  }

  override getOutput(): ViaLineCandidatePlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "EnumerateViaLineCandidatesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    const active = this.pending[this.cursor]
    return visualizeViaFirstRoutes({
      model: this.plan.model,
      corridors: this.plan.viaCorridors,
      viaLineCandidates: this.candidates,
      stage: "enumerate via-line candidates",
      progress: this.computeProgress(),
      counts: `${this.candidates.length} legal / ${this.cursor} evaluated${active ? ` · ${active.groupId}` : ""}`,
    })
  }
}
