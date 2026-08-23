import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage
    input={input as unknown as SimpleRouteJson}
    title="Raw current index RAM algorithmFn capture"
    description="Exact unmodified breakout algorithmFn argument from simplified-am62l-computer PR #6 commit ddcbb51, reached only after a diagnostic zero-trace SoC continuation: 33 connections and all 988 Core-supplied board obstacles, including 373 SoC and 200 RAM pads. The monolithic compatibility step currently stalls."
  />
)
