import type { SimpleRouteJson } from "@tscircuit/core"
import { createFixedLayerDistributionFixture } from "./create-simplified-am62l-ddr-fixed-layer-distribution"
import referenceData from "./lpddr4-ram-fanout.srj.json"
import capturedData from "./simplified-am62l-ddr-ram-repro.srj.json"

export const simplifiedAm62lDdrRamReproFixedLayerDistribution =
  createFixedLayerDistributionFixture(
    capturedData as unknown as SimpleRouteJson,
    referenceData as unknown as SimpleRouteJson,
  )
