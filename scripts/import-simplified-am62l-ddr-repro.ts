import path from "node:path"
import type { SimpleRouteJson } from "@tscircuit/core"

type CaptureSpec = {
  label: "SoC" | "RAM"
  sourcePath: string
  outputFile: string
  routingPcbGroupId: string
}

const [, , socSourcePath, ramSourcePath] = process.argv
if (!socSourcePath || !ramSourcePath) {
  throw new Error(
    "Usage: bun scripts/import-simplified-am62l-ddr-repro.ts <soc-runtime-srj.json> <ram-runtime-srj.json>",
  )
}

const captures: CaptureSpec[] = [
  {
    label: "SoC",
    sourcePath: socSourcePath,
    outputFile: "simplified-am62l-ddr-soc-repro.srj.json",
    routingPcbGroupId: "pcb_group_0",
  },
  {
    label: "RAM",
    sourcePath: ramSourcePath,
    outputFile: "simplified-am62l-ddr-ram-repro.srj.json",
    routingPcbGroupId: "pcb_group_1",
  },
]

for (const capture of captures) {
  const absoluteSourcePath = path.resolve(capture.sourcePath)
  const sourceText = await Bun.file(absoluteSourcePath).text()
  const input = JSON.parse(sourceText) as SimpleRouteJson
  const canonicalText = `${JSON.stringify(input, null, 2)}\n`
  if (sourceText !== canonicalText) {
    throw new Error(
      `${capture.label} capture is not canonical two-space JSON with a trailing newline`,
    )
  }

  const obstacleCountByComponentId = new Map<string, number>()
  for (const obstacle of input.obstacles) {
    if (!obstacle.componentId) continue
    obstacleCountByComponentId.set(
      obstacle.componentId,
      (obstacleCountByComponentId.get(obstacle.componentId) ?? 0) + 1,
    )
  }

  const routingPcbGroupIds = new Set(
    input.connections.map((connection) => connection.routingPcbGroupId),
  )
  if (
    input.layerCount !== 8 ||
    input.connections.length !== 33 ||
    input.obstacles.length !== 1050 ||
    input.traces?.length !== 0 ||
    input.buses?.length !== 3 ||
    obstacleCountByComponentId.get("pcb_component_0") !== 373 ||
    obstacleCountByComponentId.get("pcb_component_1") !== 200 ||
    routingPcbGroupIds.size !== 1 ||
    !routingPcbGroupIds.has(capture.routingPcbGroupId)
  ) {
    throw new Error(
      `${capture.label} capture does not match the exact index.circuit.tsx runtime shape`,
    )
  }

  const outputPath = path.resolve(
    import.meta.dir,
    `../fixtures/${capture.outputFile}`,
  )
  await Bun.write(outputPath, sourceText)
  console.log(`Copied exact ${capture.label} runtime capture to ${outputPath}`)
}
