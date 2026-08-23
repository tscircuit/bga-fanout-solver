import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import problemData from "../fixtures/full-am62l-soc-failing-repro.problem.json"
import { FullAm62lSocFailingReproSolver } from "./full-am62l-soc-failing-repro/FullAm62lSocFailingReproSolver"
import type { FullSocBreakoutProblem } from "./full-am62l-soc-failing-repro/types"

const problem = problemData as unknown as FullSocBreakoutProblem

export default () => (
  <main style={{ minHeight: "100vh", background: "#ffffff" }}>
    <GenericSolverDebugger
      createSolver={() =>
        new FullAm62lSocFailingReproSolver(structuredClone(problem))
      }
      animationSpeed={32}
    />
  </main>
)
