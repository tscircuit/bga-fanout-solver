import { expect, test } from "bun:test"
import {
  selectBestValidPowerSignalSolution,
  type ValidPowerSignalSolution,
} from "../lib/model/bestValidPowerSignalSolution"
import type { PowerSignalCoRoutingScore } from "../lib/model/types"

const score = (
  overrides: Partial<PowerSignalCoRoutingScore> = {},
): PowerSignalCoRoutingScore => ({
  requiredSignalCount: 33,
  routedSignalCount: 33,
  physicallyValid: true,
  coveredPowerPadCount: 105,
  reroutedSignalCount: 0,
  addedSignalLength: 0,
  addedPowerLength: 0,
  powerBendCount: 0,
  ...overrides,
})

const candidate = (
  id: string,
  overrides: Partial<PowerSignalCoRoutingScore> = {},
): ValidPowerSignalSolution<{ traces: string[] }> => ({
  id,
  output: { traces: [`${id}-trace`] },
  score: score(overrides),
})

test("best-valid retention deterministically covers timeout, no-solution, worse, and improved retries", () => {
  const baseline = candidate("baseline")

  const timeout = selectBestValidPowerSignalSolution([baseline])
  expect(timeout.id).toBe("baseline")
  expect(timeout.output.traces.length).toBeGreaterThan(0)

  const noSolution = selectBestValidPowerSignalSolution([
    baseline,
    candidate("invalid", {
      physicallyValid: false,
      coveredPowerPadCount: 109,
    }),
    candidate("partial-signal", {
      routedSignalCount: 32,
      coveredPowerPadCount: 109,
    }),
  ])
  expect(noSolution.id).toBe("baseline")
  expect(noSolution.output.traces.length).toBeGreaterThan(0)

  const worse = selectBestValidPowerSignalSolution([
    candidate("worse", {
      coveredPowerPadCount: 104,
      reroutedSignalCount: 1,
    }),
    baseline,
  ])
  expect(worse.id).toBe("baseline")

  const improvedCandidates = [
    candidate("more-costly", {
      coveredPowerPadCount: 109,
      reroutedSignalCount: 3,
      addedSignalLength: 2,
    }),
    candidate("improved", {
      coveredPowerPadCount: 109,
      reroutedSignalCount: 2,
      addedSignalLength: 1.25,
    }),
    baseline,
  ]
  const improved = selectBestValidPowerSignalSolution(improvedCandidates)
  expect(improved.id).toBe("improved")
  expect(
    selectBestValidPowerSignalSolution([...improvedCandidates].reverse()).id,
  ).toBe("improved")
  expect(improved.output.traces.length).toBeGreaterThan(0)
})
