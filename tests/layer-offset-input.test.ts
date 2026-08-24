import { expect, test } from "bun:test"
import { normalizeLayerOffsetInput } from "../pages/layer-offset/normalizeLayerOffsetInput"
import { parseLayerOffsetInput } from "../pages/layer-offset/parseLayerOffsetInput"

test("layer offset input preserves empty edits and rejects negative offsets", () => {
  expect(normalizeLayerOffsetInput("")).toBe("")
  expect(normalizeLayerOffsetInput("1.25")).toBe("1.25")
  expect(normalizeLayerOffsetInput("-1.25")).toBe("0")
  expect(normalizeLayerOffsetInput("not-a-number")).toBe("")
  expect(parseLayerOffsetInput("")).toBe(0)
  expect(parseLayerOffsetInput("1.25")).toBe(1.25)
  expect(parseLayerOffsetInput("-1.25")).toBe(0)
  expect(parseLayerOffsetInput("not-a-number")).toBe(0)
})
