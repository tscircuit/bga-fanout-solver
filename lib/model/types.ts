import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core"

export type Point = { x: number; y: number }

export type LayeredSegment = {
  a: Point
  b: Point
  layer: string
  connectionName?: string
}

export type LayeredVia = Point & { fromLayer: string; toLayer: string }

export type FanoutRules = {
  traceWidth: number
  traceClearance: number
  traceToPadClearance: number
  traceToViaClearance: number
  viaDiameter: number
  viaHoleDiameter: number
  viaToPadClearance: number
  viaToViaCenter: number
}

export type FanoutPad = Point & {
  id: string
  radius: number
  row: number
  column: number
}

export type PowerPlanePour = {
  id: string
  obstacleIndex: number
  center: Point
  width: number
  height: number
  ccwRotationDegrees: number
  layers: string[]
  netKey: string
  identityTokens: string[]
}

export type PowerPlanePad = FanoutPad & {
  componentId: string
  pointId: string
  pcbPortId?: string
  sourcePortName?: string
  netKey: string
  identityTokens: string[]
  matchingPourIds: string[]
}

export type SameNetPadLink = {
  id: string
  netKey: string
  firstPadId: string
  secondPadId: string
  path: Point[]
  length: number
}

export type SameNetPadCluster = {
  id: string
  netKey: string
  padIds: string[]
  linkIds: string[]
  matchingPourIds: string[]
}

export type CopperPourViaDrop = {
  id: string
  clusterId: string
  netKey: string
  sourcePadId: string
  via: Point
  topPath: Point[]
  pourId: string
  terminationLayer: string
}

export type UnresolvedCopperPourViaDrop = {
  clusterId: string
  netKey: string
  padIds: string[]
  reasonCode:
    | "no_legal_candidate"
    | "assignment_conflict"
    | "search_budget_exhausted"
  message: string
}

export type PowerPlanePlan = {
  pours: PowerPlanePour[]
  pads: PowerPlanePad[]
  links: SameNetPadLink[]
  clusters: SameNetPadCluster[]
  legalViaCandidateCount: number
  viaDrops: CopperPourViaDrop[]
  unresolvedViaDrops: UnresolvedCopperPourViaDrop[]
}

export type FanoutNet = {
  connection: SimpleRouteJson["connections"][number]
  connectionName: string
  source: Point & { layer: string; pointId?: string; pcb_port_id?: string }
  target: Point & { layer: string; pointId?: string; pcb_port_id?: string }
  selectedLayer: string
  busId: string
  sourceTraceId?: string
  busRank: number
  rank: number
}

export type FreeCell = Point & {
  row: number
  column: number
  clearance: number
  regionId?: string
}

export type FanoutModel = {
  input: SimpleRouteJson
  rules: FanoutRules
  nets: FanoutNet[]
  pads: FanoutPad[]
  componentId: string
  axisSign: 1 | -1
  pitchX: number
  pitchY: number
  padBounds: { minX: number; maxX: number; minY: number; maxY: number }
  routingBounds: { minX: number; maxX: number; minY: number; maxY: number }
  previousSegments: LayeredSegment[]
  previousVias: LayeredVia[]
  powerPlanePlan?: PowerPlanePlan
}

export type FreeSpaceAnalysis = {
  model: FanoutModel
  freeCells: FreeCell[]
  freeRegions: FreeCell[][]
  legalCellCount: number
}

export type FreeSpaceSample = {
  model: FanoutModel
  legalCells: FreeCell[]
  rowCount: number
  columnCount: number
}

export type FreeSpaceRegions = FreeSpaceSample & {
  candidateRegions: FreeCell[][]
}

export type RankedFanoutModel = FreeSpaceAnalysis

export type FixedTargetBgaFanoutOutput = {
  traces: SimplifiedPcbTrace[]
  outputSimpleRouteJson: SimpleRouteJson
  phases: string[]
  powerPlanePlan?: PowerPlanePlan
  powerTraces?: SimplifiedPcbTrace[]
}
