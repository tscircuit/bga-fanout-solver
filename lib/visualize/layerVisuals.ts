const GRAPHICS_LAYER_COLORS: Record<string, string> = {
  top: "red",
  bottom: "blue",
  inner1: "green",
  inner2: "yellow",
  inner3: "orange",
  inner4: "purple",
  inner5: "cyan",
  inner6: "magenta",
  inner7: "lime",
  inner8: "brown",
}

const INNER_LAYER_COLORS = [
  "green",
  "yellow",
  "orange",
  "purple",
  "cyan",
  "magenta",
  "lime",
  "brown",
] as const

const NAMED_COLOR_CHANNELS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  brown: [165, 42, 42],
  cyan: [0, 255, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  magenta: [255, 0, 255],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  yellow: [255, 255, 0],
}

export const getCopperLayerNames = (layerCount: number): string[] => {
  if (!Number.isInteger(layerCount) || layerCount < 1) {
    throw new Error(
      `cannot visualize SimpleRouteJson with invalid layerCount ${layerCount}`,
    )
  }
  if (layerCount === 1) return ["top"]
  if (layerCount === 2) return ["top", "bottom"]
  return [
    "top",
    ...Array.from(
      { length: layerCount - 2 },
      (_, index) => `inner${index + 1}`,
    ),
    "bottom",
  ]
}

export const getCopperLayerColor = (layerName: string): string => {
  const establishedColor = GRAPHICS_LAYER_COLORS[layerName]
  if (establishedColor) return establishedColor
  const match = /^inner(\d+)$/.exec(layerName)
  if (match) {
    const innerLayerIndex = Number(match[1]) - 1
    return INNER_LAYER_COLORS[innerLayerIndex % INNER_LAYER_COLORS.length]!
  }
  throw new Error(`no visualization color for copper layer "${layerName}"`)
}

export const getLayerIndex = (
  layerNames: readonly string[],
  layerName: string,
): number => {
  const layerIndex = layerNames.indexOf(layerName)
  if (layerIndex < 0) {
    throw new Error(
      `cannot visualize unknown copper layer "${layerName}" in SimpleRouteJson`,
    )
  }
  return layerIndex
}

export const getGraphicsLayer = (
  layerNames: readonly string[],
  copperLayers: readonly string[],
): string => {
  const layerIndexes = [
    ...new Set(
      copperLayers.map((layerName) => getLayerIndex(layerNames, layerName)),
    ),
  ].sort((first, second) => first - second)
  return `z${layerIndexes.join(",")}`
}

export const getLayerSpan = (
  layerNames: readonly string[],
  fromLayer: string,
  toLayer: string,
): string[] => {
  const fromIndex = getLayerIndex(layerNames, fromLayer)
  const toIndex = getLayerIndex(layerNames, toLayer)
  return layerNames.slice(
    Math.min(fromIndex, toIndex),
    Math.max(fromIndex, toIndex) + 1,
  )
}

const hslToRgb = (hue: number, saturation: number, lightness: number) => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const hueSegment = (((hue % 360) + 360) % 360) / 60
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1))
  const [red, green, blue] =
    hueSegment < 1
      ? [chroma, secondary, 0]
      : hueSegment < 2
        ? [secondary, chroma, 0]
        : hueSegment < 3
          ? [0, chroma, secondary]
          : hueSegment < 4
            ? [0, secondary, chroma]
            : hueSegment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
  const match = lightness - chroma / 2
  return [red, green, blue].map((channel) =>
    Math.round((channel + match) * 255),
  ) as [number, number, number]
}

/** Mirrors the autorouter's safeTransparentize output for its named/HSL colors. */
export const safeTransparentize = (color: string, amount: number): string => {
  let channels = NAMED_COLOR_CHANNELS[color]
  let alpha = 1
  const rgbaMatch =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
      color,
    )
  if (rgbaMatch) {
    channels = [
      Number(rgbaMatch[1]),
      Number(rgbaMatch[2]),
      Number(rgbaMatch[3]),
    ]
    alpha = rgbaMatch[4] === undefined ? 1 : Number(rgbaMatch[4])
  }
  const hslMatch =
    /^hsl\(\s*([\d.-]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(color)
  if (hslMatch) {
    channels = hslToRgb(
      Number(hslMatch[1]),
      Number(hslMatch[2]) / 100,
      Number(hslMatch[3]) / 100,
    )
  }
  if (!channels) return color
  const outputAlpha = +Math.max(0, alpha - amount).toFixed(2)
  return `rgba(${channels.join(", ")}, ${outputAlpha})`
}
