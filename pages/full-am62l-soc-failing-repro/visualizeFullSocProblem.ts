import type { GraphicsObject } from "graphics-debug"
import type { FullSocBreakoutProblem, FullSocTerminalRole } from "./types"

const ROLE_COLORS: Record<
  FullSocTerminalRole,
  { fill: string; stroke: string }
> = {
  signal: { fill: "#e879f9", stroke: "#86198f" },
  ground_plane_terminal: { fill: "#34d399", stroke: "#065f46" },
  power_plane_terminal: { fill: "#fb923c", stroke: "#9a3412" },
  local_rail_terminal: { fill: "#facc15", stroke: "#854d0e" },
  no_connect: { fill: "#e2e8f0", stroke: "#94a3b8" },
}

const clippedPlaneRect = (problem: FullSocBreakoutProblem) => {
  const { routingBounds } = problem.geometry
  return {
    center: {
      x: (routingBounds.minX + routingBounds.maxX) / 2,
      y: (routingBounds.minY + routingBounds.maxY) / 2,
    },
    width: routingBounds.maxX - routingBounds.minX,
    height: routingBounds.maxY - routingBounds.minY,
    fill: "#ecfdf5",
    stroke: "#6ee7b7",
    label: "GND planes · inner1 + inner6",
  }
}

export const visualizeFullSocProblem = (
  problem: FullSocBreakoutProblem,
  failed: boolean,
): GraphicsObject => {
  const fixedTargets = problem.signalConnections.flatMap((connection) =>
    connection.fixedBoundaryTarget
      ? [
          {
            center: connection.fixedBoundaryTarget,
            radius: problem.geometry.via.padDiameter * 0.34,
            fill: "#2563eb",
            stroke: "#172554",
            label: `${connection.signal} · ${connection.fixedBoundaryTarget.layer}`,
          },
        ]
      : [],
  )
  const failure = problem.expectedFailure
  const markerY = problem.geometry.routingBounds.maxY - 0.45

  return {
    coordinateSystem: "cartesian",
    title: problem.name,
    rects: [clippedPlaneRect(problem)],
    lines: [
      ...problem.precommittedGroundCopper.segments.map((segment) => ({
        points: [segment.start, segment.end],
        strokeWidth: segment.width,
        strokeColor: "#047857",
        label: segment.id,
      })),
      ...(failed
        ? [
            {
              points: [
                {
                  x: failure.routingMaxX,
                  y: problem.geometry.routingBounds.minY,
                },
                {
                  x: failure.routingMaxX,
                  y: problem.geometry.routingBounds.maxY,
                },
              ],
              strokeWidth: 0.045,
              strokeColor: "#dc2626",
              strokeDash: [0.16, 0.1],
              label: "available routing maxX",
            },
            {
              points: [
                {
                  x: failure.requiredMaxX,
                  y: problem.geometry.routingBounds.minY,
                },
                {
                  x: failure.requiredMaxX,
                  y: problem.geometry.routingBounds.maxY,
                },
              ],
              strokeWidth: 0.045,
              strokeColor: "#7f1d1d",
              strokeDash: [0.16, 0.1],
              label: "required ViaLine maxX",
            },
            {
              points: [
                { x: failure.routingMaxX, y: markerY },
                { x: failure.requiredMaxX, y: markerY },
              ],
              strokeWidth: 0.065,
              strokeColor: "#dc2626",
              label: `${failure.shortBy.toFixed(4)} mm short`,
            },
          ]
        : []),
    ],
    arrows: [],
    circles: [
      ...problem.terminals.map((terminal) => ({
        center: terminal.center,
        radius: problem.geometry.pad.diameter / 2,
        ...ROLE_COLORS[terminal.role],
        label: `${terminal.ball} · ${terminal.signal} · ${terminal.net ?? terminal.role}`,
      })),
      ...problem.planeTerminals
        .filter((terminal) => terminal.role === "power_plane_terminal")
        .map((terminal) => ({
          center: terminal.center,
          radius: problem.geometry.pad.diameter * 0.72,
          stroke: "#c2410c",
          label: `${terminal.net} · unassigned plane terminal`,
        })),
      ...problem.localRailTerminals.map((terminal) => ({
        center: terminal.center,
        radius: problem.geometry.pad.diameter * 0.68,
        stroke: "#a16207",
        label: `${terminal.net} · local copper`,
      })),
      ...problem.precommittedGroundCopper.vias.map((via) => ({
        center: via.center,
        radius: via.diameter / 2,
        fill: "#a7f3d0",
        stroke: "#064e3b",
        label: `${via.id} · ${via.diameter}/${via.holeDiameter} mm`,
      })),
      ...fixedTargets,
      ...(failed
        ? [failure.routingMaxX, failure.requiredMaxX].map((x) => ({
            center: { x, y: markerY },
            radius: 0.085,
            fill: "#fecaca",
            stroke: "#b91c1c",
            label: `${failure.shortBy.toFixed(4)} mm width deficit`,
          }))
        : []),
    ],
    texts: [
      {
        x: problem.geometry.routingBounds.minX + 0.35,
        y: problem.geometry.routingBounds.maxY - 0.35,
        text: "GND inner1 + inner6",
        color: "#047857",
        fontSize: 0.22,
        anchorSide: "top_left",
      },
      ...(failed
        ? [
            {
              x: (failure.routingMaxX + failure.requiredMaxX) / 2,
              y: markerY - 0.22,
              text: `${failure.shortBy.toFixed(4)} mm short`,
              color: "#b91c1c",
              fontSize: 0.24,
              anchorSide: "top_center" as const,
            },
          ]
        : []),
    ],
  }
}
