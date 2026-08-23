import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/lpddr4-ram-fanout.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage input={input as unknown as SimpleRouteJson} />
)
