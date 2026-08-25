import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import capturedData from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import { simplifiedAm62lDdrRamReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-ram-repro-fixed-layer-distribution"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { buildFanoutModel } from "../lib/model/buildFanoutModel"
import {
  expectBothCopperPours,
  expectFixedLayerDistribution,
} from "./fixed-layer-distribution-helpers"

test("fixed RAM layer distribution solves all 33 traces from the RAM BGA", () => {
  const input = structuredClone(
    simplifiedAm62lDdrRamReproFixedLayerDistribution,
  )
  const capturedInput = capturedData as unknown as SimpleRouteJson
  const model = buildFanoutModel(input)

  expect(model.componentId).toBe("pcb_component_1")
  expect(model.axisSign).toBe(-1)
  expect(input.obstacles).toEqual(capturedInput.obstacles)
  expectBothCopperPours(input, capturedInput)
  expectFixedLayerDistribution(input)

  const solver = new FixedTargetBgaFanoutSolver(input)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.error).toBeNull()
  expect(solver.getOutput().traces).toHaveLength(33)
  expect(
    Object.values(solver.getStageStats()).every((stage) => stage.completed),
  ).toBe(true)
}, 120_000)
