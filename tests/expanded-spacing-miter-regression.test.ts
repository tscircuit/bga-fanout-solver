import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { distance } from "../lib/model/geometry"
import type { IncrementalReferenceFanoutSession } from "../lib/private/reference/solve-am62l-free-space-fanout"
import { normalizeActivePowerPourConnectivity } from "../scripts/sweep-breakout-target-spacing"

const capturedInput = new URL(
  "../fixtures/expanded-breakpoint-spacing-1.25-ram.srj.json",
  import.meta.url,
)

const isRightAngleTurn = (
  previous: { x: number; y: number },
  corner: { x: number; y: number },
  next: { x: number; y: number },
) => {
  const incoming = { x: corner.x - previous.x, y: corner.y - previous.y }
  const outgoing = { x: next.x - corner.x, y: next.y - corner.y }
  const incomingLength = Math.hypot(incoming.x, incoming.y)
  const outgoingLength = Math.hypot(outgoing.x, outgoing.y)
  return (
    incomingLength > 1e-6 &&
    outgoingLength > 1e-6 &&
    Math.abs(incoming.x * outgoing.x + incoming.y * outgoing.y) <=
      1e-6 * incomingLength * outgoingLength
  )
}

test("real 1.25x RAM breakpoints reclassify an unmiterable affine tail and emit exact valid endpoints", async () => {
  const input = normalizeActivePowerPourConnectivity(
    (await Bun.file(capturedInput).json()) as SimpleRouteJson,
  )
  const solver = new FixedTargetBgaFanoutSolver(input)
  solver.solve()
  expect(solver.failed).toBe(false)
  expect(solver.getOutput().traces).toHaveLength(33)

  const session =
    solver.getStageOutput<IncrementalReferenceFanoutSession>(
      "miterRouteCorners",
    )
  expect(session).toBeDefined()
  for (const route of session!.getRoutes()) {
    expect(distance(route.innerPath.at(-1)!, route.target)).toBeLessThan(1e-6)
    for (let index = 1; index < route.innerPath.length - 1; index++) {
      expect(
        isRightAngleTurn(
          route.innerPath[index - 1]!,
          route.innerPath[index]!,
          route.innerPath[index + 1]!,
        ),
      ).toBe(false)
    }
  }
}, 90_000)
