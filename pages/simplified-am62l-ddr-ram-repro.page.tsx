import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage
    input={input as unknown as SimpleRouteJson}
    title="Raw current index RAM algorithmFn capture"
    description="Exact unmodified breakout algorithmFn argument from simplified-am62l-computer PR #6 merge commit 8063a9a with the Core #3389 correction, reached only after a diagnostic zero-trace SoC continuation: 33 connections, 200 RAM pad obstacles, two aligned GND pours, and zero prior traces. The monolithic compatibility step currently stalls."
  />
)
