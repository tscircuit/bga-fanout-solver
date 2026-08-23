import path from "node:path"
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core"
import { solveAm62lFreeSpaceFanout } from "../lib/private/reference/solve-am62l-free-space-fanout"

const fixtureDirectory = path.resolve(import.meta.dir, "../fixtures")
const outputDirectory = path.resolve(import.meta.dir, "../tests/fixtures")

const fixtureNames = [
  "am62l-soc-fanout.srj.json",
  "lpddr4-ram-fanout.srj.json",
] as const

const normalizeTraces = (traces: SimplifiedPcbTrace[]): SimplifiedPcbTrace[] =>
  traces.toSorted((first, second) =>
    (first.connection_name ?? "").localeCompare(second.connection_name ?? ""),
  )

for (const fixtureName of fixtureNames) {
  const input = (await Bun.file(
    path.join(fixtureDirectory, fixtureName),
  ).json()) as SimpleRouteJson
  const result = solveAm62lFreeSpaceFanout(structuredClone(input), () => {})
  const outputName = fixtureName.replace(".srj.json", ".expected-traces.json")
  await Bun.write(
    path.join(outputDirectory, outputName),
    `${JSON.stringify(normalizeTraces(result.traces), null, 2)}\n`,
  )
  console.log(`${fixtureName}: ${result.traces.length} traces`)
}
