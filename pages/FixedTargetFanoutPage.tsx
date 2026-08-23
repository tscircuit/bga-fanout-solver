import type { SimpleRouteJson } from "@tscircuit/core"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FixedTargetBgaFanoutSolver } from "../lib"

const GuideLegend = () => (
  <aside
    aria-label="Breakout routing guide legend"
    style={{
      display: "flex",
      flexWrap: "wrap",
      gap: "8px 18px",
      margin: "12px 20px 0",
      padding: "9px 12px",
      border: "1px solid #cbd5e1",
      borderRadius: 6,
      color: "#334155",
      background: "#f8fafc",
      fontFamily: "sans-serif",
      fontSize: 13,
    }}
  >
    <strong>Guide legend</strong>
    <span>
      <span aria-hidden="true" style={{ color: "#e11d48" }}>
        ● ┄
      </span>{" "}
      local breakout target — routed endpoint inside this SRJ
    </span>
    <span>
      <span aria-hidden="true" style={{ color: "rgba(15, 118, 110, 0.5)" }}>
        × ┄
      </span>{" "}
      virtual exit guide — opposite breakout direction, not a routed endpoint
    </span>
  </aside>
)

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
    <GuideLegend />
    <GenericSolverDebugger
      createSolver={() =>
        new FixedTargetBgaFanoutSolver(structuredClone(input))
      }
      animationSpeed={32}
    />
  </main>
)
