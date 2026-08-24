import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  BusGroup,
  BusGroupPlan,
  FanoutNet,
  RankedFanoutModel,
} from "../model/types"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

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

type PendingGroup = { id: string; busId: string; nets: FanoutNet[] }

export class GroupBusConnectionsSolver extends BaseSolver {
  private readonly rankedModel: RankedFanoutModel
  private readonly pending: PendingGroup[] = []
  private readonly groups: BusGroup[] = []
  private cursor = 0
  private output: BusGroupPlan | null = null

  constructor(rankedModel: RankedFanoutModel) {
    super()
    this.rankedModel = rankedModel
  }

  override getConstructorParams() {
    return [this.rankedModel]
  }

  override _setup() {
    const netByName = new Map(
      this.rankedModel.model.nets.map((net) => [net.connectionName, net]),
    )
    const groupedNames = new Set<string>()
    for (const bus of this.rankedModel.model.input.buses ?? []) {
      const nets = bus.connectionNames
        .map((name) => netByName.get(name))
        .filter((net): net is FanoutNet => Boolean(net))
      let offset = 0
      chunkSizes(nets.length).forEach((size, groupIndex) => {
        const groupNets = nets.slice(offset, offset + size)
        offset += size
        for (const net of groupNets) groupedNames.add(net.connectionName)
        this.pending.push({
          id: `via-line:${bus.busId}:${groupIndex}`,
          busId: bus.busId,
          nets: groupNets,
        })
      })
    }
    for (const net of this.rankedModel.model.nets) {
      if (groupedNames.has(net.connectionName)) continue
      this.pending.push({
        id: `via-line:ungrouped:${net.connectionName}`,
        busId: net.busId,
        nets: [net],
      })
    }
    this.MAX_ITERATIONS = this.pending.length + 2
    this.updateStats()
  }

  override _step() {
    const pending = this.pending[this.cursor]
    if (!pending) {
      this.groups.sort(
        (first, second) =>
          first.desiredY - second.desiredY || first.id.localeCompare(second.id),
      )
      this.output = { ...this.rankedModel, busGroups: this.groups }
      this.solved = true
      this.updateStats()
      return
    }
    this.groups.push({
      id: pending.id,
      busId: pending.busId,
      connectionNames: pending.nets.map((net) => net.connectionName),
      desiredY:
        pending.nets.reduce((sum, net) => sum + net.source.y, 0) /
        Math.max(1, pending.nets.length),
    })
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "groupBusConnections",
      groupedStrings: this.groups.length,
      totalStrings: this.pending.length,
      activeGroup: this.pending[this.cursor]?.id ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.pending.length)
  }

  override getOutput(): BusGroupPlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "GroupBusConnectionsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.rankedModel.model,
      corridors: this.rankedModel.viaCorridors,
      stage: "group bus connections",
      progress: this.computeProgress(),
      counts: `${this.groups.length}/${this.pending.length} bus-preserving strings`,
    })
  }
}
