import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage
    input={input as unknown as SimpleRouteJson}
    title="Raw current index SoC algorithmFn capture"
    description="Exact unmodified breakout algorithmFn argument from simplified-am62l-computer PR #6 commit ddcbb51: 33 connections and all 988 Core-supplied board obstacles, including 373 SoC and 200 RAM pads. The board-wide obstacles expose Core breakout scoping; the solver fails at route_top_layer_dogbones."
  />
)
