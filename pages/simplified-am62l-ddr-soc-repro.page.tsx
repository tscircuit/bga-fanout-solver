import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/simplified-am62l-ddr-soc-repro.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage input={input as unknown as SimpleRouteJson} />
)
