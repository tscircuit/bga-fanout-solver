import type { SimpleRouteJson } from "@tscircuit/core"

export type FullSocTerminalRole =
  | "signal"
  | "ground_plane_terminal"
  | "power_plane_terminal"
  | "local_rail_terminal"
  | "no_connect"

export interface FullSocTerminal {
  pinNumber: number
  ball: string
  signal: string
  net: string | null
  role: FullSocTerminalRole
  center: { x: number; y: number }
  layer: "top"
}

export interface FullSocExternalTarget {
  componentName: string
  portName: string
  pinNumber: number | null
  center: { x: number; y: number } | null
  layers: string[]
}

export interface FullSocSignalConnection {
  pinNumber: number
  ball: string
  signal: string
  net: string | null
  source: {
    x: number
    y: number
    layer: "top"
    pcbPortId: string
  }
  externalTargets: FullSocExternalTarget[]
  fixedBoundaryTarget: {
    x: number
    y: number
    layer: string
    pointId?: string
  } | null
  fixedTargetConnectionName: string | null
  bus: string
  differentialPair: string | null
}

export interface FullSocPlaneTerminal extends FullSocTerminal {
  termination:
    | {
        type: "existing_unbroken_plane"
        layers: string[]
      }
    | {
        type: "power_plane_intent"
        layers: []
        assignmentStatus: "unassigned"
      }
}

export interface FullSocLocalRailTerminal extends FullSocTerminal {
  termination: {
    type: "local_copper_or_capacitor"
    layers: []
    assignmentStatus: "unassigned"
  }
  externalTargets: FullSocExternalTarget[]
}

export interface FullSocGroundSegment {
  id: string
  layer: "top"
  width: number
  start: { x: number; y: number }
  end: { x: number; y: number }
}

export interface FullSocGroundVia {
  id: string
  center: { x: number; y: number }
  diameter: number
  holeDiameter: number
  fromLayer: "top"
  toLayer: "bottom"
  planeLayers: string[]
}

export interface FullSocPlaneRegion {
  id: string
  name: string
  net: "GND"
  layer: string
  unbroken: true
  outerRing: Array<{ x: number; y: number }>
}

export interface FullSocBreakoutProblem {
  schemaVersion: 1
  name: "Full AM62L SoC — failing repro"
  status: "known_failure"
  strategy: "power_first"
  provenance: {
    connectionIntent: Record<string, unknown>
    correctedSocGeometry: Record<string, unknown>
    fixedDdrTargets: Record<string, unknown>
    groundEscape: Record<string, unknown>
    transformations: string[]
  }
  geometry: {
    componentCenter: { x: number; y: number }
    componentBounds: { width: number; height: number }
    ballCount: number
    grid: { columns: number; rows: number; pitch: number }
    pad: {
      shape: "circle"
      diameter: number
      solderMaskMargin: number
      landStyle: "NSMD"
    }
    via: { padDiameter: number; holeDiameter: number }
    layerStack: string[]
    rules: {
      nominalTraceWidth: number
      minTraceWidth: number
      minTraceToPadEdgeClearance: number
      minPadEdgeToPadEdgeClearance: number
      minViaEdgeToPadEdgeClearance: number
      minViaHoleEdgeToViaHoleEdgeClearance: number
    }
    routingBounds: {
      minX: number
      maxX: number
      minY: number
      maxY: number
    }
  }
  inventory: {
    totalBalls: number
    connectedBalls: number
    noConnectBalls: number
    roles: {
      signals: number
      groundPlaneTerminals: number
      powerPlaneTerminals: number
      localRailTerminals: number
    }
    signals: {
      total: number
      fixedBoundaryTargets: number
      missingBoundaryTargets: number
      differentialPairs: string[]
      buses: Record<string, number>
    }
    ground: {
      net: "GND"
      terminals: number
      planeLayers: string[]
    }
    powerPlaneRails: Record<string, number>
    localRails: Record<string, number>
  }
  terminals: FullSocTerminal[]
  signalConnections: FullSocSignalConnection[]
  planeTerminals: FullSocPlaneTerminal[]
  localRailTerminals: FullSocLocalRailTerminal[]
  planeRegions: FullSocPlaneRegion[]
  precommittedGroundCopper: {
    net: "GND"
    segments: FullSocGroundSegment[]
    vias: FullSocGroundVia[]
  }
  solverInput: SimpleRouteJson
  expectedFailure: {
    engine: "FixedTargetBgaFanoutSolver"
    phase: "build_residual_via_lines"
    routingMaxX: number
    requiredMaxX: number
    shortBy: number
    message: string
  }
}
