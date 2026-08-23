import type { GraphicsObject } from "graphics-debug"
import { fromCanonical } from "../model/geometry"
import type { FanoutModel, FanoutNet, FreeCell } from "../model/types"

const LAYER_COLORS: Record<string, string> = {
  top: "#e11d48",
  inner1: "#2563eb",
  inner2: "#7c3aed",
  bottom: "#0891b2",
}

export const layerColor = (layer: string) => LAYER_COLORS[layer] ?? "#475569"

export const visualizeModel = ({
  model,
  freeCells = [],
  activeCell,
  rankedNets = [],
}: {
  model: FanoutModel
  freeCells?: FreeCell[]
  activeCell?: FreeCell
  rankedNets?: FanoutNet[]
}): GraphicsObject => {
  const world = (point: { x: number; y: number }) =>
    fromCanonical(model.axisSign, point)
  const rankByName = new Map(
    rankedNets.map((net) => [net.connectionName, net.rank]),
  )
  const maxRank = Math.max(1, ...rankedNets.map((net) => net.rank))

  return {
    coordinateSystem: "cartesian",
    rects: [
      {
        center: world({
          x: (model.padBounds.minX + model.padBounds.maxX) / 2,
          y: (model.padBounds.minY + model.padBounds.maxY) / 2,
        }),
        width: model.padBounds.maxX - model.padBounds.minX,
        height: model.padBounds.maxY - model.padBounds.minY,
        fill: "#f8fafc",
        stroke: "#94a3b8",
      },
    ],
    circles: [
      ...model.pads.map((pad) => ({
        center: world(pad),
        radius: pad.radius,
        fill: "#cbd5e1",
        stroke: "#64748b",
        label: pad.id,
      })),
      ...freeCells.map((cell) => ({
        center: world(cell),
        radius: Math.max(0.025, model.rules.viaDiameter * 0.18),
        fill: cell.regionId ? "#22d3ee" : "#bae6fd",
        stroke: cell.regionId ? "#0891b2" : "#38bdf8",
        label: cell.regionId,
      })),
      ...(activeCell
        ? [
            {
              center: world(activeCell),
              radius: model.rules.viaDiameter * 0.55,
              fill: "#facc15",
              stroke: "#a16207",
              label: "active free-space cell",
            },
          ]
        : []),
      ...model.nets.map((net) => {
        const rank = rankByName.get(net.connectionName)
        const amount = rank === undefined ? 0 : rank / maxRank
        return {
          center: world(net.source),
          radius: model.rules.traceWidth * 1.6,
          fill:
            rank === undefined
              ? "#fb7185"
              : `rgb(${Math.round(245 - amount * 135)}, ${Math.round(158 - amount * 75)}, ${Math.round(11 + amount * 150)})`,
          stroke: "#881337",
          label:
            rank === undefined
              ? net.connectionName
              : `${net.connectionName} · rank ${rank}`,
        }
      }),
      ...model.nets.map((net) => ({
        center: world(net.target),
        radius: model.rules.viaDiameter * 0.42,
        fill: layerColor(net.selectedLayer),
        stroke: "#0f172a",
        label: `${net.connectionName} → ${net.selectedLayer}`,
      })),
    ],
    lines: model.nets.map((net) => ({
      points: [world(net.source), world(net.target)],
      strokeWidth: Math.max(0.01, model.rules.traceWidth * 0.18),
      strokeColor: layerColor(net.selectedLayer),
      strokeDash: [0.07, 0.06],
      label: net.connectionName,
    })),
  }
}
