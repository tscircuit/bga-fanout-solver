import type { BaseSolver } from "@tscircuit/solver-utils"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { useState } from "react"

export const LayerOffsetSolverPage = ({
  createSolver,
}: {
  createSolver: (layerOffset: number) => BaseSolver
}) => {
  const [layerOffsetInput, setLayerOffsetInput] = useState("0")
  const parsedLayerOffset = Number(layerOffsetInput)
  const layerOffset = Number.isFinite(parsedLayerOffset) ? parsedLayerOffset : 0

  return (
    <main style={{ minHeight: "100vh", background: "#ffffff" }}>
      <input
        aria-label="Layer offset"
        type="number"
        step="0.1"
        value={layerOffsetInput}
        onChange={(event) => setLayerOffsetInput(event.target.value)}
      />
      <GenericSolverDebugger
        key={layerOffsetInput}
        createSolver={() => createSolver(layerOffset)}
        animationSpeed={32}
      />
    </main>
  )
}
