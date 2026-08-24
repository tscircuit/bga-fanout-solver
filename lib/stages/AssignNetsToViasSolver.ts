import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  ViaAssignment,
  ViaFirstFanoutPlan,
  ViaLinePlan,
} from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

type PendingAssignment = {
  connectionName: string
  lineId: string
  slotIndex: number
}

export class AssignNetsToViasSolver extends BaseSolver {
  private readonly plan: ViaLinePlan
  private readonly pending: PendingAssignment[] = []
  private readonly assignments: ViaAssignment[] = []
  private cursor = 0
  private output: ViaFirstFanoutPlan | null = null

  constructor(plan: ViaLinePlan) {
    super()
    this.plan = plan
  }

  override getConstructorParams() {
    return [this.plan]
  }

  override _setup() {
    for (const group of this.plan.busGroups) {
      group.connectionNames.forEach((connectionName, slotIndex) => {
        this.pending.push({ connectionName, lineId: group.id, slotIndex })
      })
    }
    const netOrder = new Map(
      this.plan.model.nets.map((net, index) => [net.connectionName, index]),
    )
    this.pending.sort(
      (first, second) =>
        (netOrder.get(first.connectionName) ?? 0) -
        (netOrder.get(second.connectionName) ?? 0),
    )
    this.MAX_ITERATIONS = this.pending.length + 2
    this.updateStats()
  }

  override _step() {
    const pending = this.pending[this.cursor]
    if (!pending) {
      this.output = { ...this.plan, viaAssignments: this.assignments }
      this.solved = true
      this.updateStats()
      return
    }
    const line = this.plan.viaLines.find((item) => item.id === pending.lineId)
    const slot = line?.slots[pending.slotIndex]
    if (!line || !slot) {
      throw new Error(
        `[assign_net_to_via/${pending.connectionName}] missing ${pending.lineId} slot ${pending.slotIndex}`,
      )
    }
    this.assignments.push({
      connectionName: pending.connectionName,
      via: { x: slot.x, y: slot.y },
      viaLineId: line.id,
      slotIndex: pending.slotIndex,
    })
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "assignNetsToVias",
      assignedNets: this.assignments.length,
      totalNets: this.pending.length,
      activeConnection: this.pending[this.cursor]?.connectionName ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.pending.length)
  }

  override getOutput(): ViaFirstFanoutPlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "AssignNetsToViasSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.plan.model,
      corridors: this.plan.viaCorridors,
      viaLineCandidates: this.plan.viaLineCandidates,
      viaLines: this.plan.viaLines,
      assignments: this.assignments,
      activeConnectionName: this.pending[this.cursor]?.connectionName,
      stage: "assign nets to vias",
      progress: this.computeProgress(),
      counts: `${this.assignments.length}/${this.pending.length} nets`,
    })
  }
}
