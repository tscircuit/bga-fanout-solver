import problemData from "../fixtures/full-am62l-soc-failing-repro.problem.json"
import { LayerOffsetSolverPage } from "./LayerOffsetSolverPage"
import { FullAm62lSocFailingReproSolver } from "./full-am62l-soc-failing-repro/FullAm62lSocFailingReproSolver"
import type { FullSocBreakoutProblem } from "./full-am62l-soc-failing-repro/types"

const problem = problemData as unknown as FullSocBreakoutProblem

export default () => (
  <LayerOffsetSolverPage
    createSolver={(layerOffset) =>
      new FullAm62lSocFailingReproSolver(structuredClone(problem), {
        layerOffset,
      })
    }
  />
)
