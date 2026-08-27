import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import { EPS } from "../lib/model/geometry"
import {
  isTopPathLegal,
  isViaLegal,
  pointSegmentDistance,
} from "../lib/model/powerPlanePlanning"
import type { FanoutModel, Point } from "../lib/model/types"
import {
  generateOutwardViaLineCandidates,
  MAX_VIA_LINE_CANDIDATES_PER_PAD,
} from "../lib/model/viaLineCandidates"

const rotate = (point: Point, degrees: number): Point => {
  const radians = (degrees * Math.PI) / 180
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  }
}

const makeModel = ({
  degrees,
  pitchX,
  pitchY,
}: {
  degrees: number
  pitchX: number
  pitchY: number
}): { model: FanoutModel; pad: Point } => {
  const baseCorners = [
    { x: -2.4, y: -1.2 },
    { x: 2.4, y: -1.2 },
    { x: 2.4, y: 1.2 },
    { x: -2.4, y: 1.2 },
  ].map((point) => rotate(point, degrees))
  const pad = rotate({ x: 1.55, y: 0.45 }, degrees)
  const padBounds = {
    minX: Math.min(...baseCorners.map((point) => point.x)),
    maxX: Math.max(...baseCorners.map((point) => point.x)),
    minY: Math.min(...baseCorners.map((point) => point.y)),
    maxY: Math.max(...baseCorners.map((point) => point.y)),
  }
  const input: SimpleRouteJson = {
    layerCount: 8,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.2032,
    minTraceToPadEdgeClearance: 0.08128,
    minViaEdgeToPadEdgeClearance: 0.08128,
    defaultObstacleMargin: 0.08128,
    obstacles: [],
    connections: [],
    bounds: { minX: -8, maxX: 8, minY: -8, maxY: 8 },
  }
  return {
    pad,
    model: {
      input,
      rules: {
        traceWidth: 0.1,
        traceClearance: 0.08128,
        traceToPadClearance: 0.08128,
        traceToViaClearance: 0.08128,
        viaDiameter: 0.4572,
        viaHoleDiameter: 0.2032,
        viaToPadClearance: 0.08128,
        viaToViaCenter: 0.53848,
      },
      nets: [],
      pads: [{ id: "source", ...pad, radius: 0.127, row: 0, column: 0 }],
      componentId: "synthetic-bga",
      axisSign: 1,
      pitchX,
      pitchY,
      padBounds,
      routingBounds: { ...input.bounds },
      previousSegments: [],
      previousVias: [],
    },
  }
}

test("general via-line candidates are bounded, rotation-safe, and retain non-nearest legal events", () => {
  for (const [degrees, pitchX, pitchY] of [
    [0, 0.5, 0.5],
    [90, 0.65, 0.8],
    [180, 0.5, 0.65],
    [270, 0.8, 0.65],
  ] as const) {
    const { model, pad } = makeModel({ degrees, pitchX, pitchY })
    const first = generateOutwardViaLineCandidates(model, pad)
    const second = generateOutwardViaLineCandidates(model, pad)

    expect(first, `${degrees}° candidate generation is deterministic`).toEqual(
      second,
    )
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(MAX_VIA_LINE_CANDIDATES_PER_PAD)
    expect(first.every((candidate) => candidate.bendCount <= 2)).toBe(true)

    const center = {
      x: (model.padBounds.minX + model.padBounds.maxX) / 2,
      y: (model.padBounds.minY + model.padBounds.maxY) / 2,
    }
    const outward = { x: pad.x - center.x, y: pad.y - center.y }
    expect(
      first.some((candidate) => {
        const direction = {
          x: candidate.via.x - pad.x,
          y: candidate.via.y - pad.y,
        }
        return outward.x * direction.x + outward.y * direction.y > EPS
      }),
      `${degrees}° exposes a geometry-derived outward candidate`,
    ).toBe(true)
    expect(
      first.some((candidate) => {
        const dx = Math.abs(candidate.via.x - pad.x)
        const dy = Math.abs(candidate.via.y - pad.y)
        return (
          candidate.path.length === 2 &&
          dx > EPS &&
          dy > EPS &&
          Math.abs(dx - dy) > EPS
        )
      }),
      `${degrees}° retains a direct arbitrary-angle dogbone`,
    ).toBe(true)
    expect(
      first.some(
        (candidate) => candidate.path.length >= 3 && candidate.bendCount >= 1,
      ),
      `${degrees}° includes bounded one/two-bend alternatives`,
    ).toBe(true)
  }

  const { model } = makeModel({ degrees: 0, pitchX: 0.5, pitchY: 0.5 })
  const pad = {
    id: "source",
    x: 0,
    y: 0,
    radius: 0.127,
    row: 0,
    column: 0,
  }
  model.pads = [pad]
  model.padBounds = { minX: -0.25, maxX: 0.25, minY: -0.25, maxY: 0.25 }
  const distractors = Array.from({ length: 16 }, (_, index) => ({
    a: { x: -0.2 - index * 0.018, y: -0.05 },
    b: { x: -0.2 - index * 0.018, y: 0.05 },
    layer: "top",
    connectionName: `distractor-${index}`,
  }))
  const horizontalBoundary = {
    a: { x: 0.4, y: 0.5 },
    b: { x: 1.2, y: 0.5 },
    layer: "top",
    connectionName: "horizontal-boundary",
  }
  const nonNearestBoundary = {
    a: { x: 1, y: 0.1 },
    b: { x: 1, y: 0.9 },
    layer: "top",
    connectionName: "non-nearest-boundary",
  }
  model.previousSegments = [
    ...distractors,
    horizontalBoundary,
    nonNearestBoundary,
  ]
  const rankedTopSegments = [...model.previousSegments].sort(
    (first, second) =>
      pointSegmentDistance(pad, first.a, first.b) -
      pointSegmentDistance(pad, second.a, second.b),
  )
  expect(rankedTopSegments.indexOf(nonNearestBoundary)).toBeGreaterThanOrEqual(
    16,
  )

  const netKey = "off-board:synthetic-gnd"
  const candidates = generateOutwardViaLineCandidates(model, pad, [pad], netKey)
  const legalEvent = candidates.find(
    (candidate) =>
      candidate.kind === "clearance-event" &&
      isViaLegal({
        model,
        via: candidate.via,
        netKey,
        committedGeometry: [],
      }) &&
      isTopPathLegal({
        model,
        path: candidate.path,
        netKey,
        ignoredPadIds: new Set([pad.id]),
        powerPads: [],
        committedGeometry: [],
      }),
  )
  expect(legalEvent).toBeDefined()
  expect(legalEvent!.via.x).toBeCloseTo(0.64012, 4)
  expect(legalEvent!.via.y).toBeCloseTo(0.14012, 4)
})
