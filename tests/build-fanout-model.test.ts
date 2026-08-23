import { expect, test } from "bun:test"
import { buildFanoutModel } from "../lib"
import { loadFixture } from "./helpers"

test("buildFanoutModel is a pure canonical SRJ conversion", async () => {
  const input = await loadFixture("am62l-soc-fanout")
  const snapshot = structuredClone(input)

  const model = buildFanoutModel(input)

  expect(input).toEqual(snapshot)
  expect(model.input).not.toBe(input)
  expect(model.componentId).toBe("pcb_component_0")
  expect(model.nets).toHaveLength(33)
  expect(model.pads).toHaveLength(373)
  expect(model.nets.map((net) => net.connectionName)).toEqual(
    [...model.nets]
      .sort(
        (first, second) =>
          first.busRank - second.busRank ||
          first.selectedLayer.localeCompare(second.selectedLayer) ||
          first.source.x - second.source.x ||
          first.source.y - second.source.y ||
          first.target.x - second.target.x ||
          first.target.y - second.target.y,
      )
      .map((net) => net.connectionName),
  )
})
