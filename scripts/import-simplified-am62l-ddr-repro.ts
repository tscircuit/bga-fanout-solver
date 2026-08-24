import path from "node:path"
import type { SimpleRouteJson } from "@tscircuit/core"

type CaptureSpec = {
  label: "SoC" | "RAM"
  sourcePath: string
  outputFile: string
  routingPcbGroupId: string
  componentId: string
  obstacleCount: number
  padObstacleCount: number
  pourCenter: { x: number; y: number }
  pourSize: { width: number; height: number }
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
    componentId: "pcb_component_0",
    obstacleCount: 375,
    padObstacleCount: 373,
    pourCenter: { x: 2, y: 1 },
    pourSize: { width: 21.300000000000004, height: 21.300000000000004 },
    sha256: "2435536ca54a9ad23f58356746593ef5ce1c24f955b03426041b318aec7a03ad",
  },
  {
    label: "RAM",
    sourcePath: ramSourcePath,
    outputFile: "simplified-am62l-ddr-ram-repro.srj.json",
    routingPcbGroupId: "pcb_group_1",
    componentId: "pcb_component_1",
    obstacleCount: 202,
    padObstacleCount: 200,
    pourCenter: { x: 29.675, y: 0.949083 },
    pourSize: { width: 24.05, height: 19.200000000000003 },
    sha256: "baab5746f7365119b1d073d745fd70d4f991778c2a85a493c208e49f2164c9b6",
  },
]

for (const capture of captures) {
  const absoluteSourcePath = path.resolve(capture.sourcePath)
  const sourceBytes = await Bun.file(absoluteSourcePath).arrayBuffer()
  const sourceText = new TextDecoder().decode(sourceBytes)
  const input = JSON.parse(sourceText) as SimpleRouteJson
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
  const padObstacles = input.obstacles.filter(
    (obstacle) => !obstacle.isCopperPour,
  )
  const copperPourObstacles = input.obstacles.filter(
    (obstacle) => obstacle.isCopperPour,
  )
  const targetLayerCounts = Object.groupBy(
    input.connections,
    (connection) => connection.pointsToConnect[1]?.layer ?? "none",
  )
  if (
    input.layerCount !== 8 ||
    input.connections.length !== 33 ||
    input.obstacles.length !== capture.obstacleCount ||
    padObstacles.length !== capture.padObstacleCount ||
    input.traces?.length !== 0 ||
    input.buses?.length !== 3 ||
    obstacleCountByComponentId.size !== 1 ||
    obstacleCountByComponentId.get(capture.componentId) !==
      capture.padObstacleCount ||
    copperPourObstacles.length !== 2 ||
    copperPourObstacles[0]?.center.x !== capture.pourCenter.x ||
    copperPourObstacles[0]?.center.y !== capture.pourCenter.y ||
    copperPourObstacles[0]?.width !== capture.pourSize.width ||
    copperPourObstacles[0]?.height !== capture.pourSize.height ||
    copperPourObstacles[1]?.center.x !== capture.pourCenter.x ||
    copperPourObstacles[1]?.center.y !== capture.pourCenter.y ||
    copperPourObstacles[1]?.width !== capture.pourSize.width ||
    copperPourObstacles[1]?.height !== capture.pourSize.height ||
    copperPourObstacles[0]?.layers?.[0] !== "inner1" ||
    copperPourObstacles[1]?.layers?.[0] !== "inner6" ||
    targetLayerCounts.bottom?.length !== 11 ||
    targetLayerCounts.inner2?.length !== 11 ||
    targetLayerCounts.inner5?.length !== 11 ||
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
