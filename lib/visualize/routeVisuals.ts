import type { GraphicsObject } from "graphics-debug"
import { fromCanonical } from "../model/geometry"
import type {
  BundleRepairProposal,
  CandidateFanoutRoute,
  ConnectorTemplate,
  FanoutModel,
  RouteViolation,
  ViaAssignment,
  ViaCorridor,
  ViaLine,
  ViaLineCandidate,
} from "../model/types"
import { layerColor } from "./modelVisuals"

const VIOLATION_COLORS: Record<RouteViolation["kind"], string> = {
  bounds: "#7f1d1d",
  endpoint: "#be123c",
  non_octilinear: "#c2410c",
  trace_to_pad: "#dc2626",
  trace_to_trace: "#9333ea",
  trace_to_via: "#ea580c",
  via_to_via: "#b91c1c",
}

export const visualizeViaFirstRoutes = ({
  model,
  assignments = [],
  routes = [],
  corridors = [],
  viaLineCandidates = [],
  viaLines = [],
  templates = [],
  activeTemplateId,
  activeConnectionName,
  violations = [],
  repairProposal,
  repairStatus,
  stage = "via-first",
  progress = 0,
  counts = "",
}: {
  model: FanoutModel
  assignments?: readonly ViaAssignment[]
  routes?: readonly CandidateFanoutRoute[]
  corridors?: readonly ViaCorridor[]
  viaLineCandidates?: readonly ViaLineCandidate[]
  viaLines?: readonly ViaLine[]
  templates?: readonly ConnectorTemplate[]
  activeTemplateId?: string
  activeConnectionName?: string
  violations?: readonly RouteViolation[]
  repairProposal?: BundleRepairProposal
  repairStatus?: "proposed" | "accepted" | "rejected"
  stage?: string
  progress?: number
  counts?: string
}): GraphicsObject => {
  const world = (point: { x: number; y: number }) =>
    fromCanonical(model.axisSign, point)
  const annotation = world({
    x: model.routingBounds.minX + model.pitchX / 2,
    y: model.routingBounds.maxY - model.pitchY / 2,
  })
  const legend = [
    ["trace↔trace", VIOLATION_COLORS.trace_to_trace],
    ["trace↔via", VIOLATION_COLORS.trace_to_via],
    ["trace↔pad", VIOLATION_COLORS.trace_to_pad],
  ] as const
  const selectedTemplateIds = new Set(
    templates.filter((template) => template.selected).map((item) => item.id),
  )
  const repairReplacementByName = new Map(
    repairProposal?.replacements.map((replacement) => [
      replacement.connectionName,
      replacement.path,
    ]) ?? [],
  )

  return {
    coordinateSystem: "cartesian",
    title: `${stage} · ${Math.round(progress * 100)}%`,
    rects: corridors.map((corridor) => ({
      center: world({
        x: (corridor.minX + corridor.maxX) / 2,
        y: (corridor.minY + corridor.maxY) / 2,
      }),
      width: corridor.maxX - corridor.minX,
      height: corridor.maxY - corridor.minY,
      fill: "#dcfce780",
      stroke: "#16a34a",
      label: `${corridor.id} · legal exterior corridor`,
    })),
    circles: [
      ...model.pads.map((pad) => ({
        center: world(pad),
        radius: pad.radius,
        fill: "#e2e8f0",
        stroke: "#64748b",
        label: pad.id,
      })),
      ...viaLineCandidates.flatMap((line) =>
        line.slotXs.map((x, slotIndex) => ({
          center: world({ x, y: line.y }),
          radius: model.rules.viaDiameter * 0.32,
          fill: "#bfdbfe",
          stroke: "#2563eb",
          label: `${line.id} · candidate slot ${slotIndex}`,
        })),
      ),
      ...viaLines.flatMap((line) =>
        line.slots.map((slot) => ({
          center: world(slot),
          radius: model.rules.viaDiameter / 2,
          fill: "#fde68a",
          stroke: "#b45309",
          label: `${line.id} · chosen slot ${slot.slotIndex}`,
        })),
      ),
      ...assignments.map((assignment) => ({
        center: world(assignment.via),
        radius: model.rules.viaDiameter / 2,
        fill: "#f59e0b",
        stroke: "#78350f",
        label: `${assignment.connectionName} · ${assignment.viaLineId}`,
      })),
      ...violations.map((violation) => ({
        center: world(
          violation.marker ?? {
            x: model.padBounds.maxX,
            y: model.padBounds.maxY,
          },
        ),
        radius: Math.max(
          model.rules.traceWidth,
          violation.clearanceRadius ?? violation.amount,
        ),
        fill: `${VIOLATION_COLORS[violation.kind]}33`,
        stroke: VIOLATION_COLORS[violation.kind],
        label: `${violation.kind} · ${violation.connectionNames.join(" / ")} · ${violation.amount.toFixed(4)} mm`,
      })),
    ],
    lines: [
      ...viaLineCandidates.map((line) => ({
        points: [
          world({ x: Math.min(...line.slotXs), y: line.y }),
          world({ x: Math.max(...line.slotXs), y: line.y }),
        ],
        strokeWidth: model.rules.traceWidth * 0.35,
        strokeColor: "#2563eb",
        strokeDash: [0.04, 0.04],
        label: `${line.id} · candidate via line`,
      })),
      ...routes.flatMap((route) => [
        ...route.topPath.slice(1).map((point, index) => ({
          points: [world(route.topPath[index]!), world(point)],
          strokeWidth: model.rules.traceWidth,
          strokeColor:
            route.net.connectionName === activeConnectionName
              ? "#facc15"
              : layerColor("top"),
          layer: "top",
          label: `${route.net.connectionName} · selected top`,
        })),
        ...route.innerPath.slice(1).map((point, index) => ({
          points: [world(route.innerPath[index]!), world(point)],
          strokeWidth: model.rules.traceWidth,
          strokeColor:
            route.net.connectionName === activeConnectionName
              ? "#facc15"
              : layerColor(route.net.selectedLayer),
          layer: route.net.selectedLayer,
          label: `${route.net.connectionName} · selected ${route.net.selectedLayer}`,
        })),
      ]),
      ...templates.flatMap((template) =>
        template.path.slice(1).map((point, index) => ({
          points: [world(template.path[index]!), world(point)],
          strokeWidth:
            template.id === activeTemplateId ||
            selectedTemplateIds.has(template.id)
              ? model.rules.traceWidth * 0.8
              : model.rules.traceWidth * 0.22,
          strokeColor:
            template.id === activeTemplateId
              ? "#facc15"
              : selectedTemplateIds.has(template.id)
                ? "#22c55e"
                : "#94a3b8",
          strokeDash: selectedTemplateIds.has(template.id) ? [] : [0.04, 0.04],
          label: `${template.id} · ${template.violationCount ?? "unscored"} violations`,
        })),
      ),
      ...[...repairReplacementByName].flatMap(([connectionName, path]) =>
        path.slice(1).map((point, index) => ({
          points: [world(path[index]!), world(point)],
          strokeWidth: model.rules.traceWidth * 1.5,
          strokeColor:
            repairStatus === "accepted"
              ? "#16a34a"
              : repairStatus === "rejected"
                ? "#dc2626"
                : "#0ea5e9",
          strokeDash: repairStatus === "accepted" ? [] : [0.06, 0.04],
          label: `${connectionName} · bundle repair ${repairStatus ?? "proposed"}`,
        })),
      ),
    ],
    texts: [
      {
        x: annotation.x,
        y: annotation.y,
        text: `${stage} · ${Math.round(progress * 100)}%${counts ? ` · ${counts}` : ""}${activeConnectionName ? ` · active ${activeConnectionName}` : ""}`,
        color: "#0f172a",
        fontSize: Math.max(0.12, model.pitchY * 0.28),
        anchorSide: "top_left",
      },
      ...legend.map(([label, color], index) => ({
        x: annotation.x,
        y: annotation.y - (index + 1) * model.pitchY * 0.45,
        text: `DRC ${label}`,
        color,
        fontSize: Math.max(0.1, model.pitchY * 0.22),
        anchorSide: "top_left" as const,
      })),
    ],
  }
}
