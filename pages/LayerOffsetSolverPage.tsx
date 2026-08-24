import type { BaseSolver } from "@tscircuit/solver-utils"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { useState } from "react"
import { normalizeLayerOffsetInput } from "./layer-offset/normalizeLayerOffsetInput"
import { parseLayerOffsetInput } from "./layer-offset/parseLayerOffsetInput"

export const LayerOffsetSolverPage = ({
  createSolver,
}: {
  createSolver: (layerOffset: number) => BaseSolver
}) => {
  const [layerOffsetInput, setLayerOffsetInput] = useState("0")
  const layerOffset = parseLayerOffsetInput(layerOffsetInput)

  return (
    <main style={{ minHeight: "100vh", background: "#ffffff" }}>
      <label htmlFor="layer-offset">Layer offset</label>
      <input
        id="layer-offset"
        type="number"
        min={0}
        step="0.1"
        value={layerOffsetInput}
        onChange={(event) =>
          setLayerOffsetInput(normalizeLayerOffsetInput(event.target.value))
        }
      />
      <GenericSolverDebugger
        key={layerOffsetInput}
        createSolver={() => createSolver(layerOffset)}
        animationSpeed={32}
      />
    </main>
  )
}
