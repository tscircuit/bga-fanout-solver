import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/simplified-am62l-ddr-ram-repro.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage
    input={input as unknown as SimpleRouteJson}
    title="Exact simplified-am62l index RAM capture"
    description="Unminimized runtime call 2 from @tsci/0hmX.simplified-am62l-computer@1.0.15 index.circuit.tsx after diagnostic zero-trace continuation of the SoC failure: 33 connections and all 1,050 board obstacles, including 373 SoC and 200 RAM pads."
  />
)
