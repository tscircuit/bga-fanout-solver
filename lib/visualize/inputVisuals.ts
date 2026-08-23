import type { SimpleRouteJson } from "@tscircuit/core"
import type { GraphicsObject } from "graphics-debug"

export const visualizeInput = (input: SimpleRouteJson): GraphicsObject => ({
  coordinateSystem: "cartesian",
  rects: input.obstacles.map((obstacle) => ({
    center: obstacle.center,
    width: obstacle.width,
    height: obstacle.height,
    fill: obstacle.layers.includes("top") ? "#e2e8f0" : "#f1f5f9",
    stroke: "#94a3b8",
    label: obstacle.obstacleId,
  })),
  circles: input.connections.flatMap((connection) =>
    connection.pointsToConnect.map((point, index) => ({
      center: point,
      radius: index === 0 ? 0.045 : 0.06,
      fill: index === 0 ? "#fb7185" : "#2563eb",
      stroke: "#0f172a",
      label: connection.name,
    })),
  ),
})
