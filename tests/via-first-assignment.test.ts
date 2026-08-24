import { expect, test } from "bun:test"
import { buildFanoutModel } from "../lib"
import { distance, EPS } from "../lib/model/geometry"
import { AssignNetsToViasSolver } from "../lib/stages/AssignNetsToViasSolver"
import { DeriveViaCorridorsSolver } from "../lib/stages/DeriveViaCorridorsSolver"
import { EnumerateViaLineCandidatesSolver } from "../lib/stages/EnumerateViaLineCandidatesSolver"
import { FindFreeSpaceSolver } from "../lib/stages/FindFreeSpaceSolver"
import { GroupBusConnectionsSolver } from "../lib/stages/GroupBusConnectionsSolver"
import { PlaceViaRowsAndSlotsSolver } from "../lib/stages/PlaceViaRowsAndSlotsSolver"
import { RankFanoutNetsSolver } from "../lib/stages/RankFanoutNetsSolver"
import { loadFixture } from "./helpers"

test("via-first assignment fixes one legal, bus-ordered via slot per connection", async () => {
  const model = buildFanoutModel(await loadFixture("am62l-soc-fanout"))
  const freeSpaceSolver = new FindFreeSpaceSolver(model)
  freeSpaceSolver.solve()
  const corridorSolver = new DeriveViaCorridorsSolver(
    freeSpaceSolver.getOutput(),
  )
  corridorSolver.solve()
  const rankSolver = new RankFanoutNetsSolver(corridorSolver.getOutput())
  rankSolver.solve()
  const groupSolver = new GroupBusConnectionsSolver(rankSolver.getOutput())
  groupSolver.solve()
  const candidateSolver = new EnumerateViaLineCandidatesSolver(
    groupSolver.getOutput(),
  )
  candidateSolver.solve()
  const placementSolver = new PlaceViaRowsAndSlotsSolver(
    candidateSolver.getOutput(),
  )
  placementSolver.solve()

  const firstSolver = new AssignNetsToViasSolver(placementSolver.getOutput())
  firstSolver.solve()
  const firstPlan = firstSolver.getOutput()
  const secondSolver = new AssignNetsToViasSolver(placementSolver.getOutput())
  secondSolver.solve()
  const secondPlan = secondSolver.getOutput()

  expect(firstPlan.viaAssignments).toEqual(secondPlan.viaAssignments)
  expect(firstPlan.viaAssignments).toHaveLength(model.nets.length)
  expect(
    new Set(firstPlan.viaAssignments.map((item) => item.connectionName)).size,
  ).toBe(model.nets.length)

  const assignmentByName = new Map(
    firstPlan.viaAssignments.map((item) => [item.connectionName, item]),
  )
  for (const bus of model.input.buses ?? []) {
    const busAssignments = bus.connectionNames.map((name) =>
      assignmentByName.get(name),
    )
    expect(busAssignments.every(Boolean)).toBeTrue()
    for (let index = 1; index < busAssignments.length; index++) {
      const previous = busAssignments[index - 1]!
      const current = busAssignments[index]!
      if (previous.viaLineId === current.viaLineId) {
        expect(previous.slotIndex).toBeLessThan(current.slotIndex)
      }
    }
  }

  const viaRadius = model.rules.viaDiameter / 2
  for (const assignment of firstPlan.viaAssignments) {
    expect(assignment.via.x - viaRadius + EPS).toBeGreaterThanOrEqual(
      model.routingBounds.minX,
    )
    expect(assignment.via.x + viaRadius).toBeLessThanOrEqual(
      model.routingBounds.maxX + EPS,
    )
    expect(assignment.via.y - viaRadius + EPS).toBeGreaterThanOrEqual(
      model.routingBounds.minY,
    )
    expect(assignment.via.y + viaRadius).toBeLessThanOrEqual(
      model.routingBounds.maxY + EPS,
    )
    expect(
      model.pads.every(
        (pad) =>
          distance(assignment.via, pad) + EPS >=
          viaRadius + pad.radius + model.rules.viaToPadClearance,
      ),
    ).toBeTrue()
  }
  for (let first = 0; first < firstPlan.viaAssignments.length; first++) {
    for (
      let second = first + 1;
      second < firstPlan.viaAssignments.length;
      second++
    ) {
      expect(
        distance(
          firstPlan.viaAssignments[first]!.via,
          firstPlan.viaAssignments[second]!.via,
        ) + EPS,
      ).toBeGreaterThanOrEqual(model.rules.viaToViaCenter)
    }
  }
})
