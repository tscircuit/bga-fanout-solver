import path from "node:path"
import type { SimpleRouteJson } from "@tscircuit/core"

type CircuitElement = Record<string, unknown> & { type: string }

const [, , socInputPath, ramInputPath, circuitJsonPath] = process.argv

if (!socInputPath || !ramInputPath || !circuitJsonPath) {
  throw new Error(
    "Usage: bun scripts/derive-fixtures.ts <soc.srj.json> <ram.srj.json> <circuit.json>",
  )
}

const outputDirectory = path.resolve(import.meta.dir, "../fixtures")

const readJson = async <T>(filePath: string): Promise<T> =>
  (await Bun.file(filePath).json()) as T

const sha256 = async (filePath: string): Promise<string> => {
  const bytes = await Bun.file(filePath).arrayBuffer()
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

const circuitJson = await readJson<CircuitElement[]>(circuitJsonPath)
const groupNameById = new Map(
  circuitJson
    .filter((element) => element.type === "pcb_group")
    .map((element) => [String(element.pcb_group_id), String(element.name)]),
)

const breakoutPoints = circuitJson.filter(
  (element) => element.type === "pcb_breakout_point",
)

const deriveFixture = async (
  sourcePath: string,
  groupName: "SOC_BREAKOUT" | "RAM_BREAKOUT",
): Promise<SimpleRouteJson> => {
  const source = await readJson<SimpleRouteJson>(sourcePath)
  const sourceComponentCounts = new Map<string, number>()
  for (const connection of source.connections) {
    for (const point of connection.pointsToConnect) {
      if (point.pointId?.startsWith("pcb_breakout_point")) continue
      const obstacle = source.obstacles.find(
        (item) =>
          Boolean(item.componentId) &&
          item.layers.includes(point.layer) &&
          Math.abs(point.x - item.center.x) <= item.width / 2 + 1e-6 &&
          Math.abs(point.y - item.center.y) <= item.height / 2 + 1e-6,
      )
      if (obstacle?.componentId) {
        sourceComponentCounts.set(
          obstacle.componentId,
          (sourceComponentCounts.get(obstacle.componentId) ?? 0) + 1,
        )
      }
    }
  }
  const sourceComponentId = [...sourceComponentCounts].sort(
    ([firstId, firstCount], [secondId, secondCount]) =>
      secondCount - firstCount || firstId.localeCompare(secondId),
  )[0]?.[0]
  if (!sourceComponentId) {
    throw new Error(`${groupName}: cannot identify the source BGA component`)
  }
  const currentTargetByTraceId = new Map(
    breakoutPoints
      .filter(
        (point) => groupNameById.get(String(point.pcb_group_id)) === groupName,
      )
      .map((point) => [String(point.source_trace_id), point]),
  )

  if (currentTargetByTraceId.size !== 33) {
    throw new Error(
      `${groupName}: expected 33 current breakout points, found ${currentTargetByTraceId.size}`,
    )
  }

  const renamedConnections = new Map<string, string>()
  const connections = source.connections.map((connection) => {
    const target = currentTargetByTraceId.get(
      String(connection.source_trace_id),
    )
    if (!target) {
      throw new Error(
        `${groupName}: no current breakout target for ${connection.source_trace_id}`,
      )
    }

    const targetId = String(target.pcb_breakout_point_id)
    const connectionName = `breakout:${targetId}`
    renamedConnections.set(connection.name, connectionName)
    let replacedTarget = false
    const pointsToConnect = connection.pointsToConnect.map((point) => {
      if (!point.pointId?.startsWith("pcb_breakout_point")) return { ...point }
      replacedTarget = true
      return {
        ...point,
        x: Number(target.x),
        y: Number(target.y),
        layer: String(target.layer),
        pointId: targetId,
      }
    })
    if (!replacedTarget) {
      throw new Error(`${groupName}: ${connection.name} has no breakout target`)
    }
    return { ...connection, name: connectionName, pointsToConnect }
  })

  const buses = source.buses?.map((bus) => ({
    ...bus,
    connectionNames: bus.connectionNames.map((name) => {
      const renamed = renamedConnections.get(name)
      if (!renamed)
        throw new Error(`${groupName}: bus references unknown ${name}`)
      return renamed
    }),
    ...(bus.connectionExitTargets
      ? {
          connectionExitTargets: Object.fromEntries(
            Object.entries(bus.connectionExitTargets).map(([name, target]) => [
              renamedConnections.get(name) ?? name,
              target,
            ]),
          ),
        }
      : {}),
  }))

  return {
    ...source,
    obstacles: source.obstacles.filter(
      (obstacle) => obstacle.componentId === sourceComponentId,
    ),
    connections,
    buses,
    traces: [],
  }
}

const fixtures = [
  {
    fileName: "am62l-soc-fanout.srj.json",
    groupName: "SOC_BREAKOUT" as const,
    inputPath: socInputPath,
  },
  {
    fileName: "lpddr4-ram-fanout.srj.json",
    groupName: "RAM_BREAKOUT" as const,
    inputPath: ramInputPath,
  },
]

const generated: Array<{
  file: string
  bytes: number
  sha256: string
  connections: number
  obstacles: number
}> = []

for (const fixture of fixtures) {
  const derived = await deriveFixture(fixture.inputPath, fixture.groupName)
  const outputPath = path.join(outputDirectory, fixture.fileName)
  await Bun.write(outputPath, `${JSON.stringify(derived, null, 2)}\n`)
  generated.push({
    file: fixture.fileName,
    bytes: Bun.file(outputPath).size,
    sha256: await sha256(outputPath),
    connections: derived.connections.length,
    obstacles: derived.obstacles.length,
  })
}

await Bun.write(
  path.join(outputDirectory, "provenance.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceCircuit: {
        package: "@tsci/0hmX.am62l-lpddr4-breakout-repro",
        circuitJsonArtifact: "dist/index/circuit.json",
        historicalSocSrjArtifact: "tests/fixtures/am62l-soc-fanout.srj.json",
        historicalRamSrjArtifact: "tests/fixtures/lpddr4-ram-fanout.srj.json",
        coreVersion: "0.0.1736",
        coreGitHead: "33640c38c7760ed755e5cf5d0ed7033de6cdd762",
      },
      parityOracle: {
        sourceArtifact:
          "am62l-lpddr4-breakout-repro/autorouting/solve-am62l-free-space-fanout.ts",
        goldens: [
          {
            file: "tests/fixtures/am62l-soc-fanout.expected-traces.json",
            bytes: 106543,
            sha256:
              "26bbb428221e6fe88e1cd7da9d0b859ae14708e49dcb416417216ef0648fbfa7",
          },
          {
            file: "tests/fixtures/lpddr4-ram-fanout.expected-traces.json",
            bytes: 99435,
            sha256:
              "094a3af88f08c1d455eedab9c2aa19b3f1e07d3f34d4248a6ea57da3bb54b477",
          },
        ],
      },
      transformations: [
        "Rekey breakout target and connection identifiers from the current Circuit JSON by source_trace_id.",
        "Preserve every fixed target x, y, and layer exactly.",
        "Retain only the independently solved source BGA component obstacles.",
        "Remove inherited supplied traces so each BGA fanout solves independently.",
      ],
      excludedScope: [
        "implicit breakout-point calculation",
        "middle-channel routing",
        "whole-board routing",
      ],
      fixtures: generated,
    },
    null,
    2,
  )}\n`,
)

console.log(generated)
