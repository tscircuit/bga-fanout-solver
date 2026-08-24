import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { distance, EPS, Q } from "../model/geometry"
import type {
  FanoutNet,
  RankedFanoutModel,
  ViaAssignment,
  ViaFirstFanoutPlan,
} from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

type ViaGroup = {
  id: string
  nets: FanoutNet[]
  desiredY: number
  y: number
}

const chunkSizes = (count: number) => {
  if (count <= 0) return []
  if (count === 1) return [1]
  const sizes: number[] = []
  let remaining = count
  if (remaining % 3 === 1) {
    sizes.push(2, 2)
    remaining -= 4
  } else if (remaining % 3 === 2) {
    sizes.push(2)
    remaining -= 2
  }
  while (remaining > 0) {
    sizes.push(3)
    remaining -= 3
  }
  return sizes
}

export class AssignViaLinesSolver extends BaseSolver {
  private readonly rankedModel: RankedFanoutModel
  private readonly assignmentsToPlace: ViaAssignment[] = []
  private readonly placedAssignments: ViaAssignment[] = []
  private cursor = 0
  private output: ViaFirstFanoutPlan | null = null

  constructor(rankedModel: RankedFanoutModel) {
    super()
    this.rankedModel = rankedModel
    this.MAX_ITERATIONS = rankedModel.model.nets.length + 2
  }

  override getConstructorParams() {
    return [this.rankedModel]
  }

  override _setup() {
    const model = this.rankedModel.model
    const netByName = new Map(
      model.nets.map((net) => [net.connectionName, net]),
    )
    const groupedNames = new Set<string>()
    const groups: ViaGroup[] = []
    for (const bus of model.input.buses ?? []) {
      const busNets = bus.connectionNames
        .map((name) => netByName.get(name))
        .filter((net): net is FanoutNet => Boolean(net))
      const sizes = chunkSizes(busNets.length)
      let offset = 0
      sizes.forEach((size, groupIndex) => {
        const nets = busNets.slice(offset, offset + size)
        offset += size
        for (const net of nets) groupedNames.add(net.connectionName)
        groups.push({
          id: `via-line:${bus.busId}:${groupIndex}`,
          desiredY:
            nets.reduce((sum, net) => sum + net.source.y, 0) /
            Math.max(1, nets.length),
          nets,
          y: 0,
        })
      })
    }
    for (const net of model.nets) {
      if (groupedNames.has(net.connectionName)) continue
      groups.push({
        id: `via-line:ungrouped:${net.connectionName}`,
        desiredY: net.source.y,
        nets: [net],
        y: 0,
      })
    }
    groups.sort(
      (first, second) =>
        first.desiredY - second.desiredY || first.id.localeCompare(second.id),
    )

    const viaRadius = model.rules.viaDiameter / 2
    const rowPitch = Math.max(
      model.rules.viaToViaCenter,
      model.rules.viaDiameter + model.rules.traceClearance,
    )
    const minimumY = model.routingBounds.minY + viaRadius
    const maximumY = model.routingBounds.maxY - viaRadius
    for (let index = 0; index < groups.length; index++) {
      groups[index]!.y = Q(
        Math.max(
          groups[index]!.desiredY,
          index === 0 ? minimumY : groups[index - 1]!.y + rowPitch,
        ),
      )
    }
    const overflow = Math.max(0, (groups.at(-1)?.y ?? minimumY) - maximumY)
    for (const group of groups) group.y = Q(group.y - overflow)
    if ((groups[0]?.y ?? minimumY) < minimumY - EPS) {
      throw new Error(
        "[assign_via_lines/all] routing bounds cannot hold deterministic via rows",
      )
    }

    const firstSlotX = Q(
      model.padBounds.maxX +
        viaRadius +
        model.rules.viaToPadClearance +
        model.rules.traceWidth / 2 +
        model.rules.traceToPadClearance,
    )
    const slotPitch = Math.max(
      model.rules.viaToViaCenter,
      model.rules.viaDiameter + model.rules.traceClearance,
    )
    for (const group of groups) {
      const orderedNets = [...group.nets].sort(
        (first, second) =>
          first.busRank - second.busRank ||
          first.connectionName.localeCompare(second.connectionName),
      )
      orderedNets.forEach((net, slotIndex) => {
        const via = {
          x: Q(firstSlotX + slotIndex * slotPitch),
          y: group.y,
        }
        if (via.x + viaRadius > model.routingBounds.maxX + EPS) {
          throw new Error(
            `[assign_via_lines/${net.connectionName}] deterministic via row exceeds routing maxX`,
          )
        }
        if (
          model.pads.some(
            (pad) =>
              distance(via, pad) + EPS <
              viaRadius + pad.radius + model.rules.viaToPadClearance,
          )
        ) {
          throw new Error(
            `[assign_via_lines/${net.connectionName}] deterministic via slot violates pad clearance`,
          )
        }
        this.assignmentsToPlace.push({
          connectionName: net.connectionName,
          via,
          viaLineId: group.id,
          slotIndex,
        })
      })
    }
    this.assignmentsToPlace.sort(
      (first, second) =>
        model.nets.findIndex(
          (net) => net.connectionName === first.connectionName,
        ) -
        model.nets.findIndex(
          (net) => net.connectionName === second.connectionName,
        ),
    )
    this.updateStats()
  }

  override _step() {
    const assignment = this.assignmentsToPlace[this.cursor]
    if (assignment) {
      this.placedAssignments.push(assignment)
      this.cursor++
      this.updateStats()
      return
    }
    this.output = {
      ...this.rankedModel,
      viaAssignments: this.placedAssignments.map((assignment) => ({
        ...assignment,
        via: { ...assignment.via },
      })),
    }
    this.solved = true
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "assignViaLines",
      assignedVias: this.placedAssignments.length,
      totalConnections: this.assignmentsToPlace.length,
      activeConnection:
        this.assignmentsToPlace[this.cursor]?.connectionName ?? null,
      viaLines: new Set(
        this.placedAssignments.map((assignment) => assignment.viaLineId),
      ).size,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.assignmentsToPlace.length)
  }

  override getOutput(): ViaFirstFanoutPlan {
    if (!this.solved || !this.output) {
      throw new Error("AssignViaLinesSolver output requested before completion")
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.rankedModel.model,
      assignments: this.placedAssignments,
    })
  }
}
