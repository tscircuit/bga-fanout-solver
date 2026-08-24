import { expect, test } from "bun:test"
import { buildFanoutModel } from "../lib"
import { DeriveViaCorridorsSolver } from "../lib/stages/DeriveViaCorridorsSolver"
import { EnumerateViaLineCandidatesSolver } from "../lib/stages/EnumerateViaLineCandidatesSolver"
import { FindFreeSpaceSolver } from "../lib/stages/FindFreeSpaceSolver"
import { GroupBusConnectionsSolver } from "../lib/stages/GroupBusConnectionsSolver"
import { RankFanoutNetsSolver } from "../lib/stages/RankFanoutNetsSolver"
import { loadFixture } from "./helpers"

test("observable planning stages advance by one deterministic work unit per step", async () => {
  const model = buildFanoutModel(await loadFixture("am62l-soc-fanout"))
  const freeSpace = new FindFreeSpaceSolver(model)
  freeSpace.step()
  expect(freeSpace.stats.sampled).toBe(1)
  freeSpace.step()
  expect(freeSpace.stats.sampled).toBe(2)
  expect(freeSpace.visualize().texts?.[0]?.text).toContain("find free space")
  freeSpace.solve()

  const corridors = new DeriveViaCorridorsSolver(freeSpace.getOutput())
  corridors.step()
  expect(corridors.stats.processedRegions).toBe(1)
  expect(corridors.stats.derivedCorridors).toBeLessThanOrEqual(1)
  corridors.solve()

  const rank = new RankFanoutNetsSolver(corridors.getOutput())
  rank.solve()
  const groups = new GroupBusConnectionsSolver(rank.getOutput())
  groups.step()
  expect(groups.stats.groupedStrings).toBe(1)
  groups.solve()

  const first = new EnumerateViaLineCandidatesSolver(groups.getOutput())
  first.step()
  expect(first.stats.evaluatedCandidates).toBe(1)
  const legalAfterOneStep = first.stats.legalCandidates
  first.step()
  expect(first.stats.evaluatedCandidates).toBe(2)
  expect(first.stats.legalCandidates - legalAfterOneStep).toBeLessThanOrEqual(1)
  first.solve()

  const second = new EnumerateViaLineCandidatesSolver(groups.getOutput())
  second.solve()
  expect(first.getOutput().viaLineCandidates).toEqual(
    second.getOutput().viaLineCandidates,
  )
})
