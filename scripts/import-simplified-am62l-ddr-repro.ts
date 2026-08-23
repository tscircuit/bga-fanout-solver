import path from "node:path"
import type { SimpleRouteJson } from "@tscircuit/core"

type CaptureSpec = {
  label: "SoC" | "RAM"
  sourcePath: string
  outputFile: string
  routingPcbGroupId: string
  sha256: string
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
    sha256: "4ea12abe2d3f55ddc62e3d54ef48a810aa38fefb2dad7d9bc889036111afda2e",
  },
  {
    label: "RAM",
    sourcePath: ramSourcePath,
    outputFile: "simplified-am62l-ddr-ram-repro.srj.json",
    routingPcbGroupId: "pcb_group_1",
    sha256: "064b160282d79571e524b92883994a0be78da814d2e2ea40391cd6deff45131f",
  },
]

for (const capture of captures) {
  const absoluteSourcePath = path.resolve(capture.sourcePath)
  const sourceBytes = await Bun.file(absoluteSourcePath).arrayBuffer()
  const sourceText = new TextDecoder().decode(sourceBytes)
  const input = JSON.parse(sourceText) as SimpleRouteJson
  const canonicalText = `${JSON.stringify(input, null, 2)}\n`
  if (sourceText !== canonicalText) {
    throw new Error(
      `${capture.label} capture is not canonical two-space JSON with a trailing newline`,
    )
  }
  const sourceSha256 = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(sourceBytes))
    .digest("hex")
  if (sourceSha256 !== capture.sha256) {
    throw new Error(
      `${capture.label} capture SHA-256 ${sourceSha256} does not match expected raw boundary hash ${capture.sha256}`,
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
    input.obstacles.length !== 988 ||
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
  await Bun.write(outputPath, sourceBytes)
  const outputBytes = await Bun.file(outputPath).arrayBuffer()
  const outputSha256 = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(outputBytes))
    .digest("hex")
  if (outputSha256 !== sourceSha256) {
    throw new Error(`${capture.label} copy changed the raw capture bytes`)
  }
  console.log(
    `Copied exact ${capture.label} algorithmFn boundary capture (${sourceSha256}) to ${outputPath}`,
  )
}
