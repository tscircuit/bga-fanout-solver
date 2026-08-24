import type { SimpleRouteJson } from "@tscircuit/core"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { LayerOffsetSolverPage } from "./LayerOffsetSolverPage"

export const FixedTargetFanoutPage = ({
  input,
}: {
  input: SimpleRouteJson
}) => (
  <LayerOffsetSolverPage
    createSolver={(layerOffset) =>
      new FixedTargetBgaFanoutSolver(structuredClone(input), { layerOffset })
    }
  />
)
