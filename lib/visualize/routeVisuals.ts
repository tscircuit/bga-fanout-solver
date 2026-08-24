import type { GraphicsObject } from "graphics-debug"
import { fromCanonical } from "../model/geometry"
import type {
  CandidateFanoutRoute,
  FanoutModel,
  ViaAssignment,
} from "../model/types"
import { layerColor } from "./modelVisuals"

export const visualizeViaFirstRoutes = ({
  model,
  assignments = [],
  routes = [],
}: {
  model: FanoutModel
  assignments?: readonly ViaAssignment[]
  routes?: readonly CandidateFanoutRoute[]
}): GraphicsObject => {
  const world = (point: { x: number; y: number }) =>
    fromCanonical(model.axisSign, point)
  return {
    coordinateSystem: "cartesian",
    circles: [
      ...model.pads.map((pad) => ({
        center: world(pad),
        radius: pad.radius,
        fill: "#e2e8f0",
        stroke: "#64748b",
        label: pad.id,
      })),
      ...assignments.map((assignment) => ({
        center: world(assignment.via),
        radius: model.rules.viaDiameter / 2,
        fill: "#f59e0b",
        stroke: "#78350f",
        label: `${assignment.connectionName} · ${assignment.viaLineId}`,
      })),
    ],
    lines: routes.flatMap((route) => [
      ...route.topPath.slice(1).map((point, index) => ({
        points: [world(route.topPath[index]!), world(point)],
        strokeWidth: model.rules.traceWidth,
        strokeColor: layerColor("top"),
        layer: "top",
        label: route.net.connectionName,
      })),
      ...route.innerPath.slice(1).map((point, index) => ({
        points: [world(route.innerPath[index]!), world(point)],
        strokeWidth: model.rules.traceWidth,
        strokeColor: layerColor(route.net.selectedLayer),
        layer: route.net.selectedLayer,
        label: route.net.connectionName,
      })),
    ]),
  }
}
