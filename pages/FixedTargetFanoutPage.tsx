import type { SimpleRouteJson } from "@tscircuit/core"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FixedTargetBgaFanoutSolver } from "../lib"

export const FixedTargetFanoutPage = ({
  input,
}: {
  input: SimpleRouteJson
}) => (
  <main style={{ minHeight: "100vh", background: "#ffffff" }}>
    <GenericSolverDebugger
      createSolver={() =>
        new FixedTargetBgaFanoutSolver(structuredClone(input))
      }
      animationSpeed={32}
    />
  </main>
)
