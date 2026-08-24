import type { SimpleRouteJson } from "@tscircuit/core"
import { LayerOffsetSolverPage } from "./LayerOffsetSolverPage"
import { LayerOffsetFixedTargetBgaFanoutSolver } from "./layer-offset/LayerOffsetFixedTargetBgaFanoutSolver"

export const FixedTargetFanoutPage = ({
  input,
}: {
  input: SimpleRouteJson
}) => (
  <LayerOffsetSolverPage
    createSolver={(layerOffset) =>
      new LayerOffsetFixedTargetBgaFanoutSolver(
        structuredClone(input),
        layerOffset,
      )
    }
  />
)
