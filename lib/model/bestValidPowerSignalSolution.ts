import type { PowerSignalCoRoutingScore } from "./types"

export type ValidPowerSignalSolution<T> = {
  id: string
  output: T
  score: PowerSignalCoRoutingScore
}

/**
 * Chooses the best verified output without allowing a retry to displace a
 * complete, physically valid signal solution with partial or invalid copper.
 * Candidate order is the final deterministic tie-breaker.
 */
export const compareValidPowerSignalSolutions = <T>(
  first: ValidPowerSignalSolution<T>,
  second: ValidPowerSignalSolution<T>,
) => {
  const firstHasAllSignals =
    first.score.routedSignalCount === first.score.requiredSignalCount
  const secondHasAllSignals =
    second.score.routedSignalCount === second.score.requiredSignalCount
  return (
    Number(secondHasAllSignals) - Number(firstHasAllSignals) ||
    Number(second.score.physicallyValid) -
      Number(first.score.physicallyValid) ||
    second.score.coveredPowerPadCount - first.score.coveredPowerPadCount ||
    first.score.reroutedSignalCount - second.score.reroutedSignalCount ||
    first.score.addedSignalLength - second.score.addedSignalLength ||
    first.score.addedPowerLength - second.score.addedPowerLength ||
    first.score.powerBendCount - second.score.powerBendCount ||
    first.id.localeCompare(second.id)
  )
}

export const selectBestValidPowerSignalSolution = <T>(
  candidates: readonly ValidPowerSignalSolution<T>[],
) => {
  const valid = candidates.filter(
    (candidate) =>
      candidate.score.physicallyValid &&
      candidate.score.routedSignalCount === candidate.score.requiredSignalCount,
  )
  if (valid.length === 0) {
    throw new Error(
      "power/signal co-routing produced no complete physically valid output",
    )
  }
  return [...valid].sort(compareValidPowerSignalSolutions)[0]!
}
