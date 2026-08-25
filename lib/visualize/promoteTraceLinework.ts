import type {
  Circle,
  GraphicsObject,
  Line,
  Point,
  Polygon,
} from "graphics-debug"

export type TraceLineworkFocusBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const CIRCLE_APPROXIMATION_POINTS = 20

const circlePolygon = ({
  center,
  radius,
  fill,
  stroke,
  layer,
  step,
  label,
}: Circle): Polygon => ({
  points: Array.from({ length: CIRCLE_APPROXIMATION_POINTS }, (_, index) => {
    const angle = (index / CIRCLE_APPROXIMATION_POINTS) * Math.PI * 2
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    }
  }),
  fill,
  stroke,
  layer,
  step,
  label,
})

const isForegroundMarker = (circle: Circle) => {
  const label = circle.label?.toLowerCase() ?? ""
  return (
    label.includes("signal via") ||
    label.includes("plane via") ||
    label.includes("terminal via") ||
    label.includes("search") ||
    label.includes("skipped plane drop") ||
    label.includes("active free-space cell") ||
    label.includes(" → ")
  )
}

const strokeSegmentPolygon = (
  start: Point,
  end: Point,
  width: number,
  line: Line,
): Polygon | null => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length <= 1e-9) return null
  const offsetX = (-dy / length) * (width / 2)
  const offsetY = (dx / length) * (width / 2)
  return {
    points: [
      { x: start.x + offsetX, y: start.y + offsetY },
      { x: end.x + offsetX, y: end.y + offsetY },
      { x: end.x - offsetX, y: end.y - offsetY },
      { x: start.x - offsetX, y: start.y - offsetY },
    ],
    fill: line.strokeColor ?? "#000000",
    stroke: "none",
    layer: line.layer,
    step: line.step,
    label: line.label
      ? `foreground trace stroke · ${line.label}`
      : "foreground trace stroke",
  }
}

const strokeCapPolygon = (point: Point, width: number, line: Line): Polygon =>
  circlePolygon({
    center: point,
    radius: width / 2,
    fill: line.strokeColor ?? "#000000",
    stroke: "none",
    layer: line.layer,
    step: line.step,
    label: line.label
      ? `foreground trace cap · ${line.label}`
      : "foreground trace cap",
  })

const normalizeDashPattern = (strokeDash: Line["strokeDash"]): number[] => {
  if (!strokeDash) return []
  const values = Array.isArray(strokeDash)
    ? strokeDash
    : strokeDash
        .split(",")
        .flatMap((part) => part.trim().split(/\s+/))
        .map(Number)
  const positive = values.filter(
    (value) => Number.isFinite(value) && value > 1e-9,
  )
  if (positive.length === 1) return [positive[0]!, positive[0]!]
  return positive.length % 2 === 1 ? [...positive, ...positive] : positive
}

type StrokeFragment = { start: Point; end: Point }

const clipSegmentToBounds = (
  { start, end }: StrokeFragment,
  bounds: TraceLineworkFocusBounds,
): StrokeFragment | null => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  let minimumAmount = 0
  let maximumAmount = 1
  const boundaries: Array<[number, number]> = [
    [-dx, start.x - bounds.minX],
    [dx, bounds.maxX - start.x],
    [-dy, start.y - bounds.minY],
    [dy, bounds.maxY - start.y],
  ]
  for (const [direction, distanceToBoundary] of boundaries) {
    if (Math.abs(direction) <= 1e-9) {
      if (distanceToBoundary < 0) return null
      continue
    }
    const amount = distanceToBoundary / direction
    if (direction < 0) minimumAmount = Math.max(minimumAmount, amount)
    else maximumAmount = Math.min(maximumAmount, amount)
    if (minimumAmount > maximumAmount) return null
  }
  return {
    start: {
      x: start.x + dx * minimumAmount,
      y: start.y + dy * minimumAmount,
    },
    end: {
      x: start.x + dx * maximumAmount,
      y: start.y + dy * maximumAmount,
    },
  }
}

const getStrokeFragments = (line: Line): StrokeFragment[] => {
  const dashPattern = normalizeDashPattern(line.strokeDash)
  if (dashPattern.length === 0) {
    return line.points.slice(1).map((end, index) => ({
      start: line.points[index]!,
      end,
    }))
  }

  const fragments: StrokeFragment[] = []
  let dashIndex = 0
  let dashRemaining = dashPattern[0]!
  let drawing = true
  for (let pointIndex = 1; pointIndex < line.points.length; pointIndex++) {
    const start = line.points[pointIndex - 1]!
    const end = line.points[pointIndex]!
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) continue
    let distanceAlong = 0
    while (distanceAlong < length - 1e-9) {
      const fragmentLength = Math.min(dashRemaining, length - distanceAlong)
      if (drawing && fragmentLength > 1e-9) {
        const startAmount = distanceAlong / length
        const endAmount = (distanceAlong + fragmentLength) / length
        fragments.push({
          start: {
            x: start.x + dx * startAmount,
            y: start.y + dy * startAmount,
          },
          end: {
            x: start.x + dx * endAmount,
            y: start.y + dy * endAmount,
          },
        })
      }
      distanceAlong += fragmentLength
      dashRemaining -= fragmentLength
      if (dashRemaining <= 1e-9) {
        dashIndex = (dashIndex + 1) % dashPattern.length
        dashRemaining = dashPattern[dashIndex]!
        drawing = dashIndex % 2 === 0
      }
    }
  }
  return fragments
}

const lineStrokePolygons = (
  line: Line,
  focusBounds: TraceLineworkFocusBounds,
): Polygon[] => {
  const width = line.strokeWidth ?? 0.012
  const capRadius = width / 2
  const centerlineBounds = {
    minX: focusBounds.minX + capRadius,
    maxX: focusBounds.maxX - capRadius,
    minY: focusBounds.minY + capRadius,
    maxY: focusBounds.maxY - capRadius,
  }
  if (
    centerlineBounds.minX > centerlineBounds.maxX ||
    centerlineBounds.minY > centerlineBounds.maxY
  ) {
    return []
  }
  const fragments = getStrokeFragments(line).flatMap((fragment) => {
    const clipped = clipSegmentToBounds(fragment, centerlineBounds)
    return clipped ? [clipped] : []
  })
  return fragments.flatMap((fragment) => {
    const segment = strokeSegmentPolygon(
      fragment.start,
      fragment.end,
      width,
      line,
    )
    if (!segment) return []
    return [
      segment,
      strokeCapPolygon(fragment.start, width, line),
      strokeCapPolygon(fragment.end, width, line),
    ]
  })
}

const circleIsInsideBounds = (
  circle: Circle,
  bounds: TraceLineworkFocusBounds,
) =>
  circle.center.x - circle.radius >= bounds.minX &&
  circle.center.x + circle.radius <= bounds.maxX &&
  circle.center.y - circle.radius >= bounds.minY &&
  circle.center.y + circle.radius <= bounds.maxY

/**
 * graphics-debug's interactive/SVG/software renderers place rects and circles
 * after lines. Line.zIndex only orders lines relative to other lines. Promote
 * visible linework to late-rendered polygons, move ordinary filled circles
 * into the same earlier polygon layer, and keep semantic terminal markers as
 * circles above the promoted strokes.
 */
export const promoteTraceLinework = (
  graphics: GraphicsObject,
  focusBounds: TraceLineworkFocusBounds,
): GraphicsObject => {
  const backgroundCircles = (graphics.circles ?? []).filter(
    (circle) =>
      !isForegroundMarker(circle) && circleIsInsideBounds(circle, focusBounds),
  )
  const foregroundCircles = (graphics.circles ?? []).filter(
    (circle) =>
      isForegroundMarker(circle) || !circleIsInsideBounds(circle, focusBounds),
  )
  const traceStrokes = (graphics.lines ?? []).flatMap((line) =>
    lineStrokePolygons(line, focusBounds),
  )
  return {
    ...graphics,
    polygons: [
      ...(graphics.polygons ?? []),
      ...backgroundCircles.map(circlePolygon),
      ...traceStrokes,
    ],
    circles: foregroundCircles,
  }
}
