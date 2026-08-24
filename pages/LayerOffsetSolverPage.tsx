import type { BaseSolver } from "@tscircuit/solver-utils"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { useState } from "react"

export const normalizeLayerOffsetInput = (value: string): string => {
  if (value === "") return ""

  const layerOffset = Number(value)
  if (!Number.isFinite(layerOffset)) return ""
  return layerOffset < 0 ? "0" : value
}

export const parseLayerOffsetInput = (value: string): number => {
  const layerOffset = Number(value)
  return Number.isFinite(layerOffset) ? Math.max(0, layerOffset) : 0
}

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
