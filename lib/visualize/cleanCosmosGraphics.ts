import type { GraphicsObject } from "graphics-debug"

/** Keep PCB geometry and interactive object labels without persistent prose. */
export const cleanCosmosGraphics = (
  graphics: GraphicsObject,
): GraphicsObject => ({
  ...graphics,
  texts: [],
  // Dashed linework is used for search/frontier guides and unrouted
  // connection-intent overlays. Completed copper and the board outline are
  // solid, so retain them (and their useful hover labels) without depending
  // on solver-specific route names.
  lines: graphics.lines?.filter(
    (line) => !line.strokeDash || line.strokeDash.length === 0,
  ),
  rects: graphics.rects?.filter(
    (rect) => !String(rect.label ?? "").endsWith(" summary"),
  ),
})
