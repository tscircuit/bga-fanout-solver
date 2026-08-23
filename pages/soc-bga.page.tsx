import type { SimpleRouteJson } from "@tscircuit/core"
import input from "../fixtures/am62l-soc-fanout.srj.json"
import { FixedTargetFanoutPage } from "./FixedTargetFanoutPage"

export default () => (
  <FixedTargetFanoutPage input={input as unknown as SimpleRouteJson} />
)
