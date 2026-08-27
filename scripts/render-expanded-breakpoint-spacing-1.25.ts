import type { SimpleRouteJson } from "@tscircuit/core"
import {
  getPngBufferFromGraphicsObject,
  getSvgFromGraphicsObject,
} from "graphics-debug"
import inputJson from "../fixtures/expanded-breakpoint-spacing-1.25-soc.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { buildFanoutModel } from "../lib/model/buildFanoutModel"
import { distance } from "../lib/model/geometry"
import type { IncrementalReferenceFanoutSession } from "../lib/private/reference/solve-am62l-free-space-fanout"
import { cleanCosmosGraphics } from "../lib/visualize/cleanCosmosGraphics"
import { normalizeActivePowerPourConnectivity } from "./sweep-breakout-target-spacing"

const outputDirectory = "artifacts/cosmos-expanded-breakpoint-spacing-1.25"
const input = normalizeActivePowerPourConnectivity(
  inputJson as unknown as SimpleRouteJson,
)
const solver = new FixedTargetBgaFanoutSolver(input)
const startedAt = performance.now()
solver.solve()
if (!solver.solved || solver.failed) {
  throw new Error(solver.error ?? "expanded-spacing Cosmos fixture failed")
}

const output = solver.getOutput()
const session =
  solver.getStageOutput<IncrementalReferenceFanoutSession>("miterRouteCorners")!
const adaptation = session.getTargetSpacingAdaptationSummary()
const model = buildFanoutModel(input)
const vias = [...output.traces, ...(output.powerTraces ?? [])]
  .flatMap((trace) => trace.route)
  .filter((point) => point.route_type === "via")
let minimumViaToPadEdgeClearanceMm = Number.POSITIVE_INFINITY
for (const via of vias) {
  if (via.route_type !== "via") continue
  if (via.from_layer !== "top" || via.to_layer !== "bottom") {
    throw new Error(`non-through via at ${via.x},${via.y}`)
  }
  for (const pad of model.pads) {
    minimumViaToPadEdgeClearanceMm = Math.min(
      minimumViaToPadEdgeClearanceMm,
      distance(via, pad) - pad.radius - model.rules.viaDiameter / 2,
    )
  }
}
if (minimumViaToPadEdgeClearanceMm + 1e-6 < model.rules.viaToPadClearance) {
  throw new Error(
    `via-to-pad edge clearance ${minimumViaToPadEdgeClearanceMm} is below ${model.rules.viaToPadClearance}`,
  )
}

const graphics = cleanCosmosGraphics(
  solver.finalVisualize() ?? solver.visualize(),
)
const svg = getSvgFromGraphicsObject(graphics, {
  includeTextLabels: false,
  hideInlineLabels: true,
  backgroundColor: "#ffffff",
  svgWidth: 1600,
  svgHeight: 1000,
})
const png = await getPngBufferFromGraphicsObject(graphics, {
  includeTextLabels: false,
  hideInlineLabels: true,
  backgroundColor: "#ffffff",
  pngWidth: 1600,
  pngHeight: 1000,
})
await Bun.write(`${outputDirectory}/expanded-breakpoint-spacing-1.25.svg`, svg)
await Bun.write(`${outputDirectory}/expanded-breakpoint-spacing-1.25.png`, png)
await Bun.write(
  `${outputDirectory}/expanded-breakpoint-spacing-1.25.json`,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runtimeMs: performance.now() - startedAt,
      signalCount: output.traces.length,
      targetSpacingAdaptation: adaptation,
      viaCount: vias.length,
      allViasTopToBottom: true,
      viaInPadCount: 0,
      minimumViaToPadEdgeClearanceMm,
      requiredViaToPadEdgeClearanceMm: model.rules.viaToPadClearance,
    },
    null,
    2,
  )}\n`,
)
console.log(
  JSON.stringify({
    signalCount: output.traces.length,
    adaptation,
    viaCount: vias.length,
    minimumViaToPadEdgeClearanceMm,
    outputDirectory,
  }),
)
