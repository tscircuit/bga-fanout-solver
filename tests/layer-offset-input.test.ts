import { expect, test } from "bun:test"
import {
  normalizeLayerOffsetInput,
  parseLayerOffsetInput,
} from "../pages/LayerOffsetSolverPage"

test("layer offset input preserves empty edits and rejects negative offsets", () => {
  expect(normalizeLayerOffsetInput("")).toBe("")
  expect(normalizeLayerOffsetInput("1.25")).toBe("1.25")
  expect(normalizeLayerOffsetInput("-1.25")).toBe("0")
  expect(parseLayerOffsetInput("")).toBe(0)
  expect(parseLayerOffsetInput("1.25")).toBe(1.25)
  expect(parseLayerOffsetInput("-1.25")).toBe(0)
})
