import { expect, test } from "bun:test"
import { simplifiedAm62lDdrRamReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-ram-repro-fixed-layer-distribution"
import { simplifiedAm62lDdrSocReproFixedLayerDistribution } from "../fixtures/simplified-am62l-ddr-soc-repro-fixed-layer-distribution"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { buildFanoutModel } from "../lib/model/buildFanoutModel"
import { distance } from "../lib/model/geometry"
import { pointSegmentDistance } from "../lib/model/powerPlanePlanning"

test("outward edge dogbones improve captured AM62L and RAM power-pad plane coverage without disturbing signals", () => {
  for (const [
    fixtureName,
    fixture,
    expectedPadCount,
    expectedDropCount,
    expectedCoveredPadCount,
    expectedUnresolvedPadIds,
  ] of [
    [
      "AM62L",
      simplifiedAm62lDdrSocReproFixedLayerDistribution,
      109,
      34,
      105,
      ["pcb_smtpad_59", "pcb_smtpad_76", "pcb_smtpad_119", "pcb_smtpad_179"],
    ],
    [
      "LPDDR4",
      simplifiedAm62lDdrRamReproFixedLayerDistribution,
      58,
      28,
      44,
      [
        "pcb_smtpad_380",
        "pcb_smtpad_393",
        "pcb_smtpad_397",
        "pcb_smtpad_398",
        "pcb_smtpad_402",
        "pcb_smtpad_404",
        "pcb_smtpad_406",
        "pcb_smtpad_409",
        "pcb_smtpad_411",
        "pcb_smtpad_417",
        "pcb_smtpad_418",
        "pcb_smtpad_437",
        "pcb_smtpad_438",
        "pcb_smtpad_469",
      ],
    ],
  ] as const) {
    const solver = new FixedTargetBgaFanoutSolver(structuredClone(fixture))
    const model = buildFanoutModel(structuredClone(fixture))
    solver.solve()

    expect(solver.failed, `${fixtureName} solver failure`).toBe(false)
    expect(solver.solved, `${fixtureName} solver completion`).toBe(true)
    const output = solver.getOutput()
    const plan = output.powerPlanePlan
    expect(plan, `${fixtureName} power-plane plan`).toBeDefined()
    expect(output.traces, `${fixtureName} signal fanout`).toHaveLength(33)
    expect(plan!.pads, `${fixtureName} eligible power pads`).toHaveLength(
      expectedPadCount,
    )
    expect(plan!.viaDrops, `${fixtureName} cluster drops`).toHaveLength(
      expectedDropCount,
    )
    expect(
      plan!.unresolvedViaDrops.flatMap((item) => item.padIds).sort(),
      `${fixtureName} accurately reported unresolved power pads`,
    ).toEqual([...expectedUnresolvedPadIds].sort())
    expect(
      plan!.unresolvedViaDrops.every(
        (item) => item.reasonCode === "no_legal_candidate",
      ),
    ).toBe(true)

    const droppedClusterIds = new Set(
      plan!.viaDrops.map((drop) => drop.clusterId),
    )
    const padsReachingPlane = plan!.clusters
      .filter((cluster) => droppedClusterIds.has(cluster.id))
      .flatMap((cluster) => cluster.padIds)
    expect(
      new Set(padsReachingPlane).size,
      `${fixtureName} pads reaching a GND plane`,
    ).toBe(expectedCoveredPadCount)
    expect(output.powerTraces).toHaveLength(
      plan!.links.length + plan!.viaDrops.length,
    )
    const generatedVias = [
      ...output.traces,
      ...(output.powerTraces ?? []),
    ].flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    )
    expect(generatedVias.length).toBeGreaterThan(0)
    for (const via of generatedVias) {
      expect(via.from_layer).toBe("top")
      expect(via.to_layer).toBe("bottom")
    }
    expect(model.rules.viaDiameter).toBe(0.4572)
    expect(model.rules.viaToPadClearance).toBe(0.08128)
    for (const drop of plan!.viaDrops) {
      for (const pad of model.pads) {
        expect(
          distance(drop.via, pad) + 1e-6,
          `${fixtureName} ${drop.sourcePadId} via must stay outside ${pad.id} copper`,
        ).toBeGreaterThanOrEqual(
          pad.radius +
            model.rules.viaDiameter / 2 +
            model.rules.viaToPadClearance,
        )
      }
    }

    const signalSegments = output.traces.flatMap((trace) => {
      const segments: Array<{
        start: { x: number; y: number }
        end: { x: number; y: number }
        width: number
      }> = []
      let previousWire:
        | Extract<(typeof trace.route)[number], { route_type: "wire" }>
        | undefined
      for (const point of trace.route) {
        if (point.route_type !== "wire") {
          previousWire = undefined
          continue
        }
        if (previousWire?.layer === point.layer) {
          segments.push({
            start: previousWire,
            end: point,
            width: point.width,
          })
        }
        previousWire = point
      }
      return segments
    })
    const groundVias = (output.powerTraces ?? []).flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    )
    for (const via of groundVias) {
      for (const segment of signalSegments) {
        expect(
          pointSegmentDistance(via, segment.start, segment.end) + 1e-6,
          `${fixtureName} GND through-via must clear every signal layer`,
        ).toBeGreaterThanOrEqual(
          model.rules.viaDiameter / 2 +
            segment.width / 2 +
            model.rules.traceToViaClearance,
        )
      }
    }
  }
}, 120_000)
