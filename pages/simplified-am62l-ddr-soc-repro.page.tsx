import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage
    input={input as unknown as SimpleRouteJson}
    title="Raw current index SoC algorithmFn capture"
    description="Exact unmodified breakout algorithmFn argument from simplified-am62l-computer PR #6 merge commit 8063a9a with the Core #3389 correction: 33 connections, 373 SoC pad obstacles, two aligned GND pours, and zero sibling traces. The solver fails at route_top_layer_dogbones."
  />
)
