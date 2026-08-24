import { expect, test } from "bun:test"
import path from "node:path"
import type { SimpleRouteJson } from "@tscircuit/core"
import ramFixture from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import socFixture from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import {
  LOCAL_CONNECTION_GUIDE_LABEL,
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

const fixtureCases = [
  {
    fixture: socFixture,
    path: path.resolve(
      import.meta.dir,
      "../fixtures/simplified-am62l-ddr-soc-repro.srj.json",
    ),
    sha256: "2435536ca54a9ad23f58356746593ef5ce1c24f955b03426041b318aec7a03ad",
  },
  {
    fixture: ramFixture,
    path: path.resolve(
      import.meta.dir,
      "../fixtures/simplified-am62l-ddr-ram-repro.srj.json",
    ),
    sha256: "baab5746f7365119b1d073d745fd70d4f991778c2a85a493c208e49f2164c9b6",
  },
] as const

test("raw AM62L visuals show only local breakout connection intent", async () => {
  for (const fixtureCase of fixtureCases) {
    const bytes = await Bun.file(fixtureCase.path).arrayBuffer()
    const sha256 = new Bun.CryptoHasher("sha256")
      .update(new Uint8Array(bytes))
      .digest("hex")
    expect(sha256).toBe(fixtureCase.sha256)

    const fixture = fixtureCase.fixture
    const input = fixture as unknown as SimpleRouteJson
    const visuals = visualizeSimpleRouteJson(input)
    const localGuides =
      visuals.lines?.filter((line) =>
        line.label?.startsWith(LOCAL_CONNECTION_GUIDE_LABEL),
      ) ?? []
    const allLabels = [
      ...(visuals.points ?? []),
      ...(visuals.lines ?? []),
      ...(visuals.circles ?? []),
      ...(visuals.rects ?? []),
      ...(visuals.polygons ?? []),
    ].flatMap((primitive) => primitive.label ?? [])
    const exitTargets = (input.buses ?? []).flatMap((bus) =>
      Object.values(bus.connectionExitTargets ?? {}),
    )

    expect(localGuides).toHaveLength(33)
    expect(visuals.points).toHaveLength(66)
    expect(
      allLabels.some((label) =>
        /virtual|exit guide|opposite breakout/i.test(label),
      ),
    ).toBeFalse()

    for (const connection of input.connections) {
      const source = connection.pointsToConnect[0]!
      const localTarget = connection.pointsToConnect[1]!
      const localGuide = localGuides.find((line) =>
        line.label?.endsWith(connection.name),
      )!

      expect(localGuide.points).toEqual([source, localTarget])
      expect(
        localGuide.points.every((point) =>
          pointIsInsideBounds(point, input.bounds),
        ),
      ).toBeTrue()
    }

    for (const exitTarget of exitTargets) {
      expect(
        visuals.points?.some((point) => samePoint(point, exitTarget)),
      ).toBeFalse()
      expect(
        visuals.lines?.some((line) =>
          line.points.some((point) => samePoint(point, exitTarget)),
        ),
      ).toBeFalse()
    }
  }
})
