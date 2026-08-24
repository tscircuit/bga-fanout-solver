import problemData from "../fixtures/full-am62l-soc-failing-repro.problem.json"
import { LayerOffsetSolverPage } from "./LayerOffsetSolverPage"
import type { FullSocBreakoutProblem } from "./full-am62l-soc-failing-repro/types"
import { LayerOffsetFullAm62lSocFailingReproSolver } from "./layer-offset/LayerOffsetFullAm62lSocFailingReproSolver"

const problem = problemData as unknown as FullSocBreakoutProblem

export default () => (
  <LayerOffsetSolverPage
    createSolver={(layerOffset) =>
      new LayerOffsetFullAm62lSocFailingReproSolver(
        structuredClone(problem),
        layerOffset,
      )
    }
  />
)
