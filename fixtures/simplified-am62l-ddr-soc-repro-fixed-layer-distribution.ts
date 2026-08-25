import type { SimpleRouteJson } from "@tscircuit/core"
import referenceData from "./am62l-soc-fanout.srj.json"
import { createFixedLayerDistributionFixture } from "./create-simplified-am62l-ddr-fixed-layer-distribution"
import capturedData from "./simplified-am62l-ddr-soc-repro.srj.json"

// The full capture reports 0.300 mm SoC pads and a target rail only 4.9 mm
// outside the pad field. The validated SoC fixture uses the actual 0.254 mm
// pad diameter and a rail far enough out for seven ordered via strings. These
// two geometry corrections are required before the layer distribution can run.
export const simplifiedAm62lDdrSocReproFixedLayerDistribution =
  createFixedLayerDistributionFixture(
    capturedData as unknown as SimpleRouteJson,
    referenceData as unknown as SimpleRouteJson,
    {
      normalizeSourcePadGeometry: true,
      translateTargetX: true,
    },
  )
