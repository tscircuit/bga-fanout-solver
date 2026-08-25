import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import capturedData from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import { simplifiedAm62lDdrSocReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-soc-repro-fixed-layer-distribution"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { buildFanoutModel } from "../lib/model/buildFanoutModel"
import {
  expectBothCopperPours,
  expectFixedLayerDistribution,
} from "./fixed-layer-distribution-helpers"

test("fixed SoC layer distribution solves all 33 traces from the SoC BGA", () => {
  const input = structuredClone(
    simplifiedAm62lDdrSocReproFixedLayerDistribution,
  )
  const capturedInput = capturedData as unknown as SimpleRouteJson
  const model = buildFanoutModel(input)
  const sourceComponentId = "pcb_component_0"

  expect(model.componentId).toBe(sourceComponentId)
  expect(model.axisSign).toBe(1)
  expect(input.obstacles).toHaveLength(capturedInput.obstacles.length)
  expect(
    input.obstacles.filter(
      (obstacle) => obstacle.componentId !== sourceComponentId,
    ),
  ).toEqual(
    capturedInput.obstacles.filter(
      (obstacle) => obstacle.componentId !== sourceComponentId,
    ),
  )
  expectBothCopperPours(input, capturedInput)
  expect(
    input.obstacles
      .filter((obstacle) => obstacle.componentId === sourceComponentId)
      .every(
        (obstacle) => obstacle.width === 0.254 && obstacle.height === 0.254,
      ),
  ).toBe(true)
  expect(input.bounds.maxX).toBeCloseTo(19.377, 6)
  expect(
    new Set(
      input.connections.map((connection) => connection.pointsToConnect[1]!.x),
    ),
  ).toEqual(new Set([19.3769]))
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
