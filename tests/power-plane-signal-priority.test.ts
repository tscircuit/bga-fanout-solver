import { expect, test } from "bun:test"
import { simplifiedAm62lDdrRamReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-ram-repro-fixed-layer-distribution"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { normalizeTraces } from "./helpers"

test("mandatory signal routes are unchanged when power drops use only remaining geometry", () => {
  const withPower = structuredClone(
    simplifiedAm62lDdrRamReproFixedLayerDistribution,
  )
  const withoutPower = structuredClone(withPower)
  for (const obstacle of withoutPower.obstacles) {
    if (obstacle.netIsAssignable) obstacle.netIsAssignable = false
  }

  const signalOnlySolver = new FixedTargetBgaFanoutSolver(withoutPower)
  signalOnlySolver.solve()
  const powerAwareSolver = new FixedTargetBgaFanoutSolver(withPower)
  powerAwareSolver.solve()

  expect(signalOnlySolver.solved).toBe(true)
  expect(powerAwareSolver.solved).toBe(true)
  expect(powerAwareSolver.error).toBeNull()
  expect(normalizeTraces(powerAwareSolver.getOutput().traces)).toEqual(
    normalizeTraces(signalOnlySolver.getOutput().traces),
  )
  expect(powerAwareSolver.getOutput().traces).toHaveLength(33)
  expect(
    powerAwareSolver.getOutput().powerPlanePlan?.unresolvedViaDrops.length,
  ).toBeGreaterThan(0)
  expect(signalOnlySolver.getOutput().powerPlanePlan?.pads).toHaveLength(0)
  expect(signalOnlySolver.getOutput().powerTraces).toHaveLength(0)
}, 120_000)
