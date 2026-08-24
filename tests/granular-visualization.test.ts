import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import fixtureData from "../fixtures/am62l-soc-fanout.srj.json"
import { FixedTargetBgaFanoutSolver } from "../lib"

test("granular pipeline views expose active templates, corridors, annotations, and DRC classes", () => {
  const solver = new FixedTargetBgaFanoutSolver(
    structuredClone(fixtureData) as unknown as SimpleRouteJson,
  )
  solver.solveUntilStage("enumerateViaLineCandidates")
  solver.step()
  solver.step()
  const corridorView = solver.visualize()
  expect(
    corridorView.rects?.some((rect) => rect.label?.includes("corridor")),
  ).toBeTrue()
  expect(
    corridorView.texts?.some((text) =>
      text.text.includes("enumerate via-line"),
    ),
  ).toBeTrue()

  solver.solveUntilStage("scoreTopConnectorTemplates")
  solver.step()
  solver.step()
  const templateView = solver.visualize()
  expect(
    templateView.lines?.some((line) => line.label?.startsWith("top:")),
  ).toBeTrue()
  expect(
    templateView.texts?.some((text) => text.text.includes("active")),
  ).toBeTrue()

  solver.solveUntilStage("detectInitialConflicts")
  while (
    solver.getCurrentStageName() === "detectInitialConflicts" &&
    (solver.getSolver("detectInitialConflicts")?.stats.classifiedViolations ??
      0) === 0
  ) {
    solver.step()
  }
  const drcView = solver.visualize()
  expect(
    drcView.circles?.some((circle) =>
      circle.label?.match(/trace_to_(trace|via|pad)/),
    ),
  ).toBeTrue()
  expect(
    drcView.texts?.some((text) => text.text.includes("DRC trace↔trace")),
  ).toBeTrue()
})
