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
}

export type FreeSpaceAnalysis = {
  model: FanoutModel
  freeCells: FreeCell[]
  freeRegions: FreeCell[][]
  legalCellCount: number
}

export type ViaCorridor = {
  id: string
  regionId: string
  minX: number
  maxX: number
  minY: number
  maxY: number
  cells: FreeCell[]
}

export type CorridorAnalysis = FreeSpaceAnalysis & {
  viaCorridors: ViaCorridor[]
}

export type RankedFanoutModel = CorridorAnalysis

export type BusGroup = {
  id: string
  busId: string
  connectionNames: string[]
  desiredY: number
}

export type BusGroupPlan = RankedFanoutModel & {
  busGroups: BusGroup[]
}

export type ViaLineCandidate = {
  id: string
  groupId: string
  corridorId: string
  y: number
  slotXs: number[]
  displacement: number
}

export type ViaLineCandidatePlan = BusGroupPlan & {
  viaLineCandidates: ViaLineCandidate[]
}

export type ViaLine = {
  id: string
  groupId: string
  corridorId: string
  y: number
  slots: Array<Point & { slotIndex: number }>
}

export type ViaLinePlan = ViaLineCandidatePlan & {
  viaLines: ViaLine[]
}

export type ViaAssignment = {
  connectionName: string
  via: Point
  viaLineId: string
  slotIndex: number
}

export type ViaFirstFanoutPlan = ViaLinePlan & {
  viaAssignments: ViaAssignment[]
}

export type ConnectorLeg = "top" | "inner"

export type ConnectorTemplate = {
  id: string
  connectionName: string
  leg: ConnectorLeg
  path: Point[]
  violationCount?: number
  violationSeverity?: number
  pathLength?: number
  selected?: boolean
}

export type TopConnectorTemplatePlan = {
  plan: ViaFirstFanoutPlan
  templates: ConnectorTemplate[]
}

export type ScoredTopConnectorTemplatePlan = TopConnectorTemplatePlan

export type InnerConnectorTemplatePlan = {
  candidate: ViaFirstRouteCandidate
  templates: ConnectorTemplate[]
}

export type ScoredInnerConnectorTemplatePlan = InnerConnectorTemplatePlan

export type CandidateFanoutRoute = {
  net: FanoutNet
  via: Point
  viaLineId: string
  slotIndex: number
  topPath: Point[]
  innerPath: Point[]
}

export type RouteViolationKind =
  | "bounds"
  | "endpoint"
  | "non_octilinear"
  | "trace_to_pad"
  | "trace_to_trace"
  | "trace_to_via"
  | "via_to_via"

export type RouteViolation = {
  kind: RouteViolationKind
  connectionNames: string[]
  layer: string
  amount: number
  message: string
  marker?: Point
  clearanceRadius?: number
}

export type ViaFirstRouteCandidate = {
  plan: ViaFirstFanoutPlan
  routes: CandidateFanoutRoute[]
  violations: RouteViolation[]
}

export type BundleRepairProposal = {
  id: string
  busId: string
  leg: ConnectorLeg
  laneOffset: number
  replacements: Array<{ connectionName: string; path: Point[] }>
  beforeViolationCount?: number
  afterViolationCount?: number
  afterViolationSeverity?: number
  accepted?: boolean
}

export type BundleRepairPlan = {
  candidate: ViaFirstRouteCandidate
  proposals: BundleRepairProposal[]
}

export type ValidatedViaFirstRouteCandidate = ViaFirstRouteCandidate & {
  validated: true
}

export type FixedTargetBgaFanoutOutput = {
  traces: SimplifiedPcbTrace[]
  outputSimpleRouteJson: SimpleRouteJson
  phases: string[]
}
