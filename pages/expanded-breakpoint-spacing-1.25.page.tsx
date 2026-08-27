import type { SimpleRouteJson } from "@tscircuit/core"
import type { GraphicsObject } from "graphics-debug"
import { CanvasGraphics } from "graphics-debug/react"
import { useEffect, useMemo, useState } from "react"
import inputJson from "../fixtures/expanded-breakpoint-spacing-1.25-soc.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"
import type { IncrementalReferenceFanoutSession } from "../lib/private/reference/solve-am62l-free-space-fanout"
import { cleanCosmosGraphics } from "../lib/visualize/cleanCosmosGraphics"
import { normalizeActivePowerPourConnectivity } from "../scripts/sweep-breakout-target-spacing"

const STEP_LIMIT = 10_000_000
const FRAME_BUDGET_MS = 12
const FRAME_INTERVAL_MS = 200

type ViewState = {
  graphics: GraphicsObject
  status: "routing" | "complete" | "incomplete" | "error"
  steps: number
  completionSummary?: string
  error?: string
}

export default function ExpandedBreakpointSpacingPage() {
  const input = useMemo(
    () =>
      normalizeActivePowerPourConnectivity(
        inputJson as unknown as SimpleRouteJson,
      ),
    [],
  )
  const [view, setView] = useState<ViewState>(() => {
    const solver = new FixedTargetBgaFanoutSolver(input)
    return {
      graphics: cleanCosmosGraphics(solver.visualize()),
      status: "routing",
      steps: 0,
    }
  })

  useEffect(() => {
    const solver = new FixedTargetBgaFanoutSolver(input)
    let cancelled = false
    let lastFrame = 0

    const publish = (status: ViewState["status"], error?: string) => {
      const finalGraphics = solver.solved
        ? (solver.finalVisualize() ?? solver.visualize())
        : solver.visualize()
      const adaptation = solver
        .getStageOutput<IncrementalReferenceFanoutSession>("miterRouteCorners")
        ?.getTargetSpacingAdaptationSummary()
      setView({
        graphics: cleanCosmosGraphics(finalGraphics),
        status,
        steps: solver.iterations,
        completionSummary: adaptation
          ? `33/33 signals · ${adaptation.reusedRouteNames.length} reused · ${adaptation.repairedRouteNames.length} repaired · ${adaptation.relocatedViaRouteNames.length} ViaLine relocated`
          : undefined,
        error,
      })
    }

    const advance = () => {
      if (cancelled) return
      const deadline = performance.now() + FRAME_BUDGET_MS
      try {
        while (
          !solver.solved &&
          !solver.failed &&
          solver.iterations < STEP_LIMIT &&
          performance.now() < deadline
        ) {
          solver.step()
        }
      } catch (error) {
        publish("error", error instanceof Error ? error.message : String(error))
        return
      }
      if (solver.solved) {
        publish("complete")
        return
      }
      if (solver.failed) {
        publish("error", solver.error ?? "solver failed")
        return
      }
      if (solver.iterations >= STEP_LIMIT) {
        publish("incomplete", `bounded at ${STEP_LIMIT} steps`)
        return
      }
      if (performance.now() - lastFrame >= FRAME_INTERVAL_MS) {
        lastFrame = performance.now()
        publish("routing")
      }
      window.setTimeout(advance, 0)
    }

    window.setTimeout(advance, 0)
    return () => {
      cancelled = true
    }
  }, [input])

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#fff",
        color: "#0f172a",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: 16,
      }}
    >
      <h1 style={{ margin: "0 0 4px", fontSize: 18 }}>
        AM62L fanout · 1.25× real breakout spacing
      </h1>
      <p style={{ margin: "0 0 12px", fontSize: 13 }}>
        {view.status === "complete"
          ? view.completionSummary
          : view.status === "routing"
            ? `Bounded solver running · ${view.steps} steps`
            : `Solver ${view.status} · ${view.error ?? "no valid output"}`}
      </p>
      <CanvasGraphics
        graphics={view.graphics}
        width={1200}
        height={760}
        withGrid={false}
      />
    </main>
  )
}
