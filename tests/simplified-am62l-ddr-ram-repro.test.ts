import { expect, test } from "bun:test"
import path from "node:path"
import type { SimpleRouteJson } from "@tscircuit/core"
import fixtureData from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"

test("exact index.circuit.tsx RAM capture preserves its bounded compatibility stall", async () => {
  const input = structuredClone(fixtureData) as unknown as SimpleRouteJson
  const obstacleCountByComponentId = Object.groupBy(
    input.obstacles,
    (obstacle) => obstacle.componentId ?? "none",
  )

  expect(input.layerCount).toBe(8)
  expect(input.connections).toHaveLength(33)
  expect(input.obstacles).toHaveLength(988)
  expect(input.traces).toHaveLength(0)
  expect(input.bounds).toEqual({
    minX: 17.65,
    maxX: 41.7,
    minY: -8.650917000000002,
    maxY: 10.549083000000001,
  })
  expect(obstacleCountByComponentId.pcb_component_0).toHaveLength(373)
  expect(obstacleCountByComponentId.pcb_component_1).toHaveLength(200)
  expect(input.obstacles.filter((obstacle) => obstacle.isCopperPour)).toEqual([
    expect.objectContaining({
      center: { x: 29.675, y: 0.949083 },
      width: 24.05,
      height: 19.200000000000003,
      layers: ["inner1"],
    }),
    expect.objectContaining({
      center: { x: 29.675, y: 0.949083 },
      width: 24.05,
      height: 19.200000000000003,
      layers: ["inner6"],
    }),
  ])
  expect(input.buses?.map((bus) => [bus.busId, bus.preferredLayer])).toEqual([
    ["DDR_BYTE0", "inner2"],
    ["DDR_BYTE1", "bottom"],
    ["DDR_COMMAND", "inner5"],
  ])
  expect(
    input.connections.filter(
      (connection) => connection.pointsToConnect[1]?.layer === "bottom",
    ),
  ).toHaveLength(11)
  expect(
    input.connections.filter(
      (connection) => connection.pointsToConnect[1]?.layer === "inner2",
    ),
  ).toHaveLength(11)
  expect(
    input.connections.filter(
      (connection) => connection.pointsToConnect[1]?.layer === "inner5",
    ),
  ).toHaveLength(11)

  const solver = new FixedTargetBgaFanoutSolver(input)
  solver.solveUntilStage("compatibilityRoute")
  expect(solver.getCurrentStageName()).toBe("compatibilityRoute")

  const repositoryRoot = path.resolve(import.meta.dir, "..")
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `import input from "./fixtures/simplified-am62l-ddr-ram-repro.srj.json";
       import { FixedTargetBgaFanoutSolver } from "./lib";
       const solver = new FixedTargetBgaFanoutSolver(structuredClone(input));
       solver.solve();
       console.log(JSON.stringify({ solved: solver.solved, failed: solver.failed, error: solver.error }));`,
    ],
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const outcome = await Promise.race([
    child.exited.then(async (exitCode) => ({
      kind: "exit" as const,
      exitCode,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
    Bun.sleep(5_000).then(() => ({ kind: "timeout" as const })),
  ])

  if (outcome.kind === "timeout") {
    child.kill("SIGKILL")
    await child.exited
  }

  expect(outcome).toEqual({ kind: "timeout" })
}, 20_000)
