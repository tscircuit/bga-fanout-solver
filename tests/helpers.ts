import { expect } from "bun:test"
import path from "node:path"
import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core"
import type { FixedTargetBgaFanoutOutput } from "../lib"

export type FixtureName = "am62l-soc-fanout" | "lpddr4-ram-fanout"

export const loadFixture = async (
  name: FixtureName,
): Promise<SimpleRouteJson> =>
  (await Bun.file(
    path.resolve(import.meta.dir, `../fixtures/${name}.srj.json`),
  ).json()) as SimpleRouteJson

export const loadGolden = async (
  name: FixtureName,
): Promise<SimplifiedPcbTrace[]> =>
  (await Bun.file(
    path.resolve(import.meta.dir, `fixtures/${name}.expected-traces.json`),
  ).json()) as SimplifiedPcbTrace[]

export const normalizeTraces = (traces: SimplifiedPcbTrace[]) =>
  structuredClone(traces).sort((first, second) =>
    (first.connection_name ?? "").localeCompare(second.connection_name ?? ""),
  )

const solverCoordinate = (value: number) => Math.round(value * 1e6) / 1e6

export const assertParityOutput = (
  input: SimpleRouteJson,
  output: FixedTargetBgaFanoutOutput,
  golden: SimplifiedPcbTrace[],
) => {
  expect(input.traces ?? []).toHaveLength(0)
  expect(
    new Set(input.obstacles.map((obstacle) => obstacle.componentId)).size,
  ).toBe(1)
  expect(output.traces).toHaveLength(33)
  expect(
    output.traces
      .flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "via"),
  ).toHaveLength(33)
  expect(normalizeTraces(output.traces)).toEqual(normalizeTraces(golden))
  expect(output.phases).toHaveLength(8)

  for (const connection of input.connections) {
    const fixedTarget = connection.pointsToConnect.find((point) =>
      point.pointId?.startsWith("pcb_breakout_point"),
    )
    expect(fixedTarget).toBeDefined()
    const outputConnection = output.outputSimpleRouteJson.connections.find(
      (item) => item.name === connection.name,
    )
    const outputTarget = outputConnection?.pointsToConnect.find(
      (point) => point.pointId === fixedTarget?.pointId,
    )
    expect(outputTarget).toMatchObject({
      x: solverCoordinate(fixedTarget!.x),
      y: solverCoordinate(fixedTarget!.y),
      layer: fixedTarget!.layer,
      pointId: fixedTarget!.pointId,
    })

    const trace = output.traces.find(
      (item) => item.connection_name === connection.name,
    )
    const finalWire = trace?.route.findLast(
      (point) => point.route_type === "wire",
    )
    expect(finalWire).toMatchObject({
      x: solverCoordinate(fixedTarget!.x),
      y: solverCoordinate(fixedTarget!.y),
      layer: fixedTarget!.layer,
    })
  }
}

export const shuffleConnections = (
  input: SimpleRouteJson,
  seed: number,
): SimpleRouteJson => {
  const shuffled = structuredClone(input)
  let state = seed >>> 0
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
  for (let index = shuffled.connections.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1))
    const temporary = shuffled.connections[index]!
    shuffled.connections[index] = shuffled.connections[swapIndex]!
    shuffled.connections[swapIndex] = temporary
  }
  return shuffled
}
