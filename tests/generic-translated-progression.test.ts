import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import sourceFixture from "../fixtures/lpddr4-ram-fanout.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"

test("incremental searches solve translated and renamed generic fanout input", () => {
  const dx = 73.125
  const dy = -41.75
  const input = structuredClone(sourceFixture) as unknown as SimpleRouteJson
  const nameMap = new Map(
    input.connections.map((connection, index) => [
      connection.name,
      `synthetic-connection-${index}`,
    ]),
  )

  input.bounds = {
    minX: input.bounds.minX + dx,
    maxX: input.bounds.maxX + dx,
    minY: input.bounds.minY + dy,
    maxY: input.bounds.maxY + dy,
  }
  input.obstacles = input.obstacles.map((obstacle) => ({
    ...obstacle,
    center: {
      x: obstacle.center.x + dx,
      y: obstacle.center.y + dy,
    },
  }))
  input.connections = input.connections.map((connection) => ({
    ...connection,
    name: nameMap.get(connection.name)!,
    pointsToConnect: connection.pointsToConnect.map((point) => ({
      ...point,
      x: point.x + dx,
      y: point.y + dy,
    })),
  }))
  input.buses = input.buses?.map((bus) => ({
    ...bus,
    busId: `synthetic-${bus.busId}`,
    name: `synthetic-${bus.name}`,
    connectionNames: bus.connectionNames.map((name) => nameMap.get(name)!),
    ...(bus.connectionExitTargets
      ? {
          connectionExitTargets: Object.fromEntries(
            Object.entries(bus.connectionExitTargets).map(([name, point]) => [
              nameMap.get(name)!,
              { x: point.x + dx, y: point.y + dy },
            ]),
          ),
        }
      : {}),
  }))

  const solver = new FixedTargetBgaFanoutSolver(input)
  solver.solveUntilStage("placeIndependentEarlyDropVias")
  solver.step()
  const earlyDropSolver = solver.activeSubSolver!
  for (let index = 0; index < 12; index++) solver.step()
  expect(earlyDropSolver.solved).toBe(false)
  expect(earlyDropSolver.iterations).toBe(12)
  expect(earlyDropSolver.stats.activeConnection).toStartWith(
    "synthetic-connection-",
  )

  solver.solveUntilStage("completeTopLayerRoutes")
  solver.step()
  const topRouteSolver = solver.activeSubSolver!
  for (let index = 0; index < 12; index++) solver.step()
  expect(topRouteSolver.solved).toBe(false)
  expect(topRouteSolver.iterations).toBe(12)

  solver.solveUntilStage("routePrescribedInnerLayers")
  solver.step()
  const innerRouteSolver = solver.activeSubSolver!
  for (let index = 0; index < 12; index++) solver.step()
  expect(innerRouteSolver.solved).toBe(false)
  expect(innerRouteSolver.iterations).toBe(12)
  expect(innerRouteSolver.stats.activeConnection).toStartWith(
    "synthetic-connection-",
  )

  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.traces).toHaveLength(33)
  expect(
    output.traces.every((trace) =>
      trace.connection_name?.startsWith("synthetic-connection-"),
    ),
  ).toBe(true)
  expect(
    output.traces
      .flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "via"),
  ).toHaveLength(33)
}, 120_000)
