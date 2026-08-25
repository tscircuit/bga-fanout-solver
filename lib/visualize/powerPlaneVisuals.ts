import type { GraphicsObject } from "graphics-debug"
import { fromCanonical } from "../model/geometry"
import type { FanoutModel, PowerPlanePlan } from "../model/types"

const NET_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#16a34a"]

const colorForNet = (netKey: string) => {
  let hash = 0
  for (const character of netKey) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }
  return NET_COLORS[hash % NET_COLORS.length]!
}

const panel = (
  model: FanoutModel,
  title: string,
  details: readonly string[],
  legend: readonly { color: string; text: string }[],
): Pick<GraphicsObject, "rects" | "texts"> => {
  const worldBounds = [
    fromCanonical(model.axisSign, {
      x: model.padBounds.minX,
      y: model.padBounds.minY,
    }),
    fromCanonical(model.axisSign, {
      x: model.padBounds.maxX,
      y: model.padBounds.maxY,
    }),
  ]
  const minX = Math.min(...worldBounds.map((point) => point.x))
  const maxX = Math.max(...worldBounds.map((point) => point.x))
  const maxY = Math.max(...worldBounds.map((point) => point.y))
  const availableWidth = Math.max(2.2, maxX - minX)
  const panelWidth = Math.min(8.8, availableWidth * 0.48)
  const fontSize = Math.max(0.12, Math.min(0.2, panelWidth / 42))
  const lineHeight = fontSize * 1.45
  const rows = 1 + details.length + legend.length
  const panelHeight = Math.max(0.9, (rows + 1) * lineHeight)
  const left = minX + 0.16
  // The BGA grid is visually dense. Keep the opaque summary panel in the
  // empty board margin immediately above it so pads never obscure the text.
  const top = maxY + panelHeight + 0.24
  const texts: NonNullable<GraphicsObject["texts"]> = []
  let row = 0
  const addText = (text: string, color = "#0f172a") => {
    texts.push({
      x: left + 0.18,
      y: top - 0.18 - row * lineHeight,
      text,
      color,
      fontSize,
      anchorSide: "top_left",
    })
    row++
  }
  addText(title, "#020617")
  for (const detail of details) addText(detail, "#334155")
  for (const entry of legend) addText(`● ${entry.text}`, entry.color)
  return {
    rects: [
      {
        center: {
          x: left + panelWidth / 2,
          y: top - panelHeight / 2,
        },
        width: panelWidth,
        height: panelHeight,
        fill: "rgba(255, 255, 255, 0.94)",
        stroke: "#475569",
        label: `${title} summary`,
      },
    ],
    texts,
  }
}

export const visualizeSameNetPadClusters = (
  model: FanoutModel,
  plan: PowerPlanePlan,
): GraphicsObject => {
  const world = (point: { x: number; y: number }) =>
    fromCanonical(model.axisSign, point)
  const padById = new Map(plan.pads.map((pad) => [pad.id, pad]))
  const netKeys = [...new Set(plan.pads.map((pad) => pad.netKey))].sort()
  return {
    coordinateSystem: "cartesian",
    ...panel(
      model,
      "same_net_pad_clusters",
      [
        `${plan.pads.length} eligible power pads · ${plan.clusters.length} clusters`,
        `${plan.links.length} legal local top-copper links`,
      ],
      netKeys.length > 0
        ? netKeys.map((netKey, index) => ({
            color: colorForNet(netKey),
            text: `same-net local cluster copper · rail ${index + 1}`,
          }))
        : [{ color: "#2563eb", text: "no assignable power rails" }],
    ),
    circles: plan.pads.map((pad) => ({
      center: world(pad),
      radius: Math.max(model.rules.traceWidth * 1.5, 0.065),
      fill: colorForNet(pad.netKey),
      stroke: "#ffffff",
      label: `${pad.sourcePortName ?? pad.id} · ${pad.netKey}`,
    })),
    lines: plan.links.flatMap((link) =>
      link.path.slice(1).map((point, index) => ({
        points: [world(link.path[index]!), world(point)],
        strokeWidth: model.rules.traceWidth * 1.8,
        strokeColor: colorForNet(link.netKey),
        layer: "top",
        label: `${link.id} · ${padById.get(link.firstPadId)?.sourcePortName ?? link.firstPadId} ↔ ${padById.get(link.secondPadId)?.sourcePortName ?? link.secondPadId}`,
      })),
    ),
  }
}

export const visualizeCopperPourViaDrops = (
  model: FanoutModel,
  plan: PowerPlanePlan,
): GraphicsObject => {
  const world = (point: { x: number; y: number }) =>
    fromCanonical(model.axisSign, point)
  const unresolvedPadIds = new Set(
    plan.unresolvedViaDrops.flatMap((unresolved) => unresolved.padIds),
  )
  return {
    coordinateSystem: "cartesian",
    ...panel(
      model,
      "copper_pour_via_drops",
      [
        `${plan.viaDrops.length} clusters dropped · ${plan.unresolvedViaDrops.length} skipped`,
        `${plan.pours.length} matching pour region${plan.pours.length === 1 ? "" : "s"}`,
      ],
      [
        { color: "#f59e0b", text: "legal dogbone + through via to pour" },
        { color: "#dc2626", text: "skipped cluster (no legal drop)" },
      ],
    ),
    circles: [
      ...plan.viaDrops.map((drop) => ({
        center: world(drop.via),
        radius: model.rules.viaDiameter / 2,
        fill: "#f59e0b",
        stroke: "#78350f",
        label: `plane via · ${drop.clusterId} → ${drop.terminationLayer}`,
      })),
      ...plan.pads
        .filter((pad) => unresolvedPadIds.has(pad.id))
        .map((pad) => ({
          center: world(pad),
          radius: Math.max(model.rules.traceWidth * 2.1, 0.09),
          fill: "#dc2626",
          stroke: "#7f1d1d",
          label: `${pad.sourcePortName ?? pad.id} · skipped plane drop`,
        })),
    ],
    lines: plan.viaDrops.flatMap((drop) =>
      drop.topPath.slice(1).map((point, index) => ({
        points: [world(drop.topPath[index]!), world(point)],
        strokeWidth: model.rules.traceWidth * 1.8,
        strokeColor: "#f59e0b",
        layer: "top",
        label: `${drop.clusterId} dogbone → ${drop.terminationLayer}`,
      })),
    ),
  }
}
