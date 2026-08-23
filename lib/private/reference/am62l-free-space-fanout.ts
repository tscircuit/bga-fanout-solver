import type {
  AutorouterProgressEvent,
  GenericLocalAutorouter,
  SimpleRouteJson,
} from "@tscircuit/core"
import {
  InProcessAutorouter,
  type InProcessAutorouterResult,
} from "./create-in-process-autorouter"
import { solveAm62lFreeSpaceFanout } from "./solve-am62l-free-space-fanout"

export const AM62L_FREE_SPACE_FANOUT_PHASES = [
  "build_pad_topology",
  "find_two_via_free_space",
  "number_distance_from_free_space",
  "place_independent_early_drop_vias",
  "build_residual_via_lines",
  "route_top_layer_dogbones",
  "route_prescribed_inner_layers",
  "validate_reconstructed_geometry",
] as const

export type Am62lFreeSpaceFanoutPhase =
  (typeof AM62L_FREE_SPACE_FANOUT_PHASES)[number]

export type Am62lFreeSpaceFanoutSolve = (
  input: SimpleRouteJson,
  reportProgress: (event: AutorouterProgressEvent) => void,
) => InProcessAutorouterResult

export type Am62lFanoutAlgorithmFn = (
  input: SimpleRouteJson,
) => Promise<GenericLocalAutorouter>

/**
 * Creates the algorithmFn passed to a breakout's `autorouter` prop. Keeping
 * this adapter separate lets the geometric solver stay a pure SRJ transform.
 */
export const createAm62lFreeSpaceFanoutAlgorithm = (
  solve: Am62lFreeSpaceFanoutSolve = solveAm62lFreeSpaceFanout,
): Am62lFanoutAlgorithmFn => {
  return async (input) => new InProcessAutorouter(input, solve)
}
