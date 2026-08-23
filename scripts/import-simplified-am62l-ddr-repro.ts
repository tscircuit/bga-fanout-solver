import path from "node:path"
import type { SimpleRouteJson } from "@tscircuit/core"

const sourcePath = process.argv[2]
if (!sourcePath) {
  throw new Error(
    "Usage: bun scripts/import-simplified-am62l-ddr-repro.ts <failed-srj.json>",
  )
}

const input = (await Bun.file(
  path.resolve(sourcePath),
).json()) as SimpleRouteJson
const obstacleCountByComponentId = new Map<string, number>()
for (const obstacle of input.obstacles) {
  if (!obstacle.componentId) continue
  obstacleCountByComponentId.set(
    obstacle.componentId,
    (obstacleCountByComponentId.get(obstacle.componentId) ?? 0) + 1,
  )
}

const sourceComponentId = [...obstacleCountByComponentId].sort(
  ([firstId, firstCount], [secondId, secondCount]) =>
    secondCount - firstCount || firstId.localeCompare(secondId),
)[0]?.[0]
if (!sourceComponentId) {
  throw new Error("Failed SRJ has no component-tagged obstacles")
}

const fixture: SimpleRouteJson = {
  ...input,
  obstacles: input.obstacles.filter(
    (obstacle) => obstacle.componentId === sourceComponentId,
  ),
}

if (fixture.connections.length !== 33 || fixture.obstacles.length !== 373) {
  throw new Error(
    `Expected the AM62L DDR repro to contain 33 connections and 373 SoC pads; got ${fixture.connections.length} and ${fixture.obstacles.length}`,
  )
}

const outputPath = path.resolve(
  import.meta.dir,
  "../fixtures/simplified-am62l-ddr-soc-repro.srj.json",
)
await Bun.write(outputPath, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`Wrote ${outputPath}`)
