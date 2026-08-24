import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage
    input={input as unknown as SimpleRouteJson}
    title="Raw current index SoC algorithmFn capture"
    description="Exact unmodified breakout algorithmFn argument from simplified-am62l-computer PR #6 merge commit 8063a9a with corrected Core #3389: 33 connections, all 986 existing non-pour obstacles, and two SoC-bounded GND pours. The solver fails at route_top_layer_dogbones."
  />
)
