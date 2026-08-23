import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/core"
import ramFixture from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import socFixture from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import {
  LOCAL_BREAKOUT_TARGET_LABEL,
  LOCAL_CONNECTION_GUIDE_LABEL,
  VIRTUAL_EXIT_GUIDE_LABEL,
  visualizeSimpleRouteJson,
} from "../lib/visualize/simpleRouteJsonVisuals"

const samePoint = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) => first.x === second.x && first.y === second.y

const pointIsInsideBounds = (
  point: { x: number; y: number },
  bounds: SimpleRouteJson["bounds"],
) =>
  point.x >= bounds.minX &&
  point.x <= bounds.maxX &&
  point.y >= bounds.minY &&
  point.y <= bounds.maxY

test("raw AM62L visuals distinguish local targets from virtual exit guides", () => {
  for (const fixture of [socFixture, ramFixture]) {
    const input = fixture as unknown as SimpleRouteJson
    const visuals = visualizeSimpleRouteJson(input)
    const localGuides =
      visuals.lines?.filter((line) =>
        line.label?.startsWith(LOCAL_CONNECTION_GUIDE_LABEL),
      ) ?? []
    const virtualGuideSegments =
      visuals.lines?.filter(
        (line) =>
          line.label?.startsWith(VIRTUAL_EXIT_GUIDE_LABEL) &&
          line.label.includes("local boundary to opposite breakout boundary"),
      ) ?? []
    const virtualGuideMarkers =
      visuals.lines?.filter(
        (line) =>
          line.label?.startsWith(VIRTUAL_EXIT_GUIDE_LABEL) &&
          line.label.endsWith("marker"),
      ) ?? []
    const exitTargetByConnectionName = new Map(
      (input.buses ?? []).flatMap((bus) =>
        Object.entries(bus.connectionExitTargets ?? {}),
      ),
    )

    expect(localGuides).toHaveLength(33)
    expect(virtualGuideSegments).toHaveLength(33)
    expect(virtualGuideMarkers).toHaveLength(66)
    expect(
      visuals.points?.filter((point) =>
        point.label?.startsWith(LOCAL_BREAKOUT_TARGET_LABEL),
      ),
    ).toHaveLength(33)
    expect(
      visuals.points?.some((point) =>
        point.label?.startsWith(VIRTUAL_EXIT_GUIDE_LABEL),
      ),
    ).toBeFalse()

    for (const connection of input.connections) {
      const source = connection.pointsToConnect[0]!
      const localTarget = connection.pointsToConnect[1]!
      const exitTarget = exitTargetByConnectionName.get(connection.name)!
      const localGuide = localGuides.find((line) =>
        line.label?.endsWith(connection.name),
      )!
      const virtualGuide = virtualGuideSegments.find((line) =>
        line.label?.includes(`\n${connection.name}\n`),
      )!

      expect(localGuide.points).toEqual([source, localTarget])
      expect(
        pointIsInsideBounds(localGuide.points[1]!, input.bounds),
      ).toBeTrue()
      expect(virtualGuide.points).toEqual([localTarget, exitTarget])
      expect(
        pointIsInsideBounds(virtualGuide.points[0]!, input.bounds),
      ).toBeTrue()
      expect(
        pointIsInsideBounds(virtualGuide.points[1]!, input.bounds),
      ).toBeFalse()
      expect(
        visuals.lines?.some(
          (line) =>
            line.points.length === 2 &&
            samePoint(line.points[0]!, source) &&
            samePoint(line.points[1]!, exitTarget),
        ),
      ).toBeFalse()
    }
  }
})
