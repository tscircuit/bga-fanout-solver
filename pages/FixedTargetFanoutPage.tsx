import type { SimpleRouteJson } from "@tscircuit/core"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FixedTargetBgaFanoutSolver } from "../lib"

export const FixedTargetFanoutPage = ({
  input,
  title,
  description,
}: {
  input: SimpleRouteJson
  title?: string
  description?: string
}) => (
  <main style={{ minHeight: "100vh", background: "#ffffff" }}>
    {title ? (
      <header style={{ padding: "16px 20px 0", fontFamily: "sans-serif" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{title}</h1>
        {description ? (
          <p style={{ margin: "8px 0 0", maxWidth: 920 }}>{description}</p>
        ) : null}
      </header>
    ) : null}
    <GenericSolverDebugger
      createSolver={() =>
        new FixedTargetBgaFanoutSolver(structuredClone(input))
      }
      animationSpeed={32}
    />
  </main>
)
