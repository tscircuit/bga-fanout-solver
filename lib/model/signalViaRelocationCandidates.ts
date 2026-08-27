import { Q } from "./geometry"
import type { Point } from "./types"

const DIRECTIONS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
] as const

/** Rotation- and breakout-side-invariant bounded candidate sites. */
export const generateBoundedSignalViaRelocationSites = (params: {
  origin: Point
  step: number
  maximumSteps: number
}) =>
  DIRECTIONS.flatMap((direction) =>
    Array.from({ length: params.maximumSteps }, (_, index) => {
      const amount = params.step * (index + 1)
      const magnitude = Math.hypot(direction.x, direction.y)
      return {
        x: Q(params.origin.x + (direction.x / magnitude) * amount),
        y: Q(params.origin.y + (direction.y / magnitude) * amount),
      }
    }),
  ).sort(
    (first, second) =>
      Math.hypot(first.x - params.origin.x, first.y - params.origin.y) -
        Math.hypot(second.x - params.origin.x, second.y - params.origin.y) ||
      first.x - second.x ||
      first.y - second.y,
  )
