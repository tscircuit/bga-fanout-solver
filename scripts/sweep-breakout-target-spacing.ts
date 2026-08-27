import type { SimpleRouteJson } from "@tscircuit/core"
import { FixedTargetBgaFanoutSolver } from "../lib"
import { buildFanoutModel } from "../lib/model/buildFanoutModel"
import { distance, Q } from "../lib/model/geometry"
import type {
  CopperPourViaDrop,
  FanoutModel,
  PowerPlanePlan,
} from "../lib/model/types"
import type { IncrementalReferenceFanoutSession } from "../lib/private/reference/solve-am62l-free-space-fanout"

type CircuitJsonElement = Record<string, unknown> & { type: string }

type GroundReference = {
  componentName: string
  sourceComponentId: string
  sourcePortNames: string[]
}

type SpacingCaseResult = {
  componentName: string
  scale: number
  elapsedMs: number
  stageReached: string
  signalCount: number
  expectedGroundPadCount: number
  detectedGroundPadCount: number
  directGroundPadCount: number
  unresolvedGroundPads: string[]
  watchedGroundPads: Record<string, "direct" | "unresolved" | "not_applicable">
  signalVias: Array<{
    connectionName: string
    signalName: string
    x: number
    y: number
    selectedLayer: string
  }>
  signalViaCount: number
  groundViaCount: number
  viaInPadCount: number
  viaClearanceViolationCount: number
  minimumViaToPadEdgeClearanceMm: number
  requiredViaToPadEdgeClearanceMm: number
  throughViaCount: number
  nonThroughViaCount: number
  baseDistinctTargetSpacingMm: number
  scaledDistinctTargetSpacingMm: number
  targetBoundsValid: boolean
  failed: boolean
  error: string | null
}

type TimedWorkerResult =
  | { status: "completed"; result: SpacingCaseResult }
  | { status: "timeout" | "failed"; error: string; elapsedMs: number }

const WATCHED_GROUND_PADS = ["H1", "M1", "E8"] as const
const PIPELINE_STOP_STAGE = "resolvePowerSignalConflicts"
const WORKER_WALL_CLOCK_LIMIT_MS = 60_000
const POWER_ASSIGNMENT_SEARCH_NODE_LIMIT = 5_000
const PIPELINE_ITERATION_LIMIT = 10_000_000
const EPSILON = 1e-6

const parseArgs = (args: string[]) => {
  const parsed = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!key?.startsWith("--")) continue
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      parsed.set(key, "true")
      continue
    }
    parsed.set(key, value)
    index++
  }
  return parsed
}

const requiredArg = (args: Map<string, string>, name: string) => {
  const value = args.get(name)
  if (!value) throw new Error(`missing required argument ${name}`)
  return value
}

const sortedUnique = (items: readonly string[]) =>
  [...new Set(items)].sort((first, second) => first.localeCompare(second))

const getGroundReference = (
  circuitJson: CircuitJsonElement[],
  componentName: string,
): GroundReference => {
  const sourceComponent = circuitJson.find(
    (element) =>
      element.type === "source_component" && element.name === componentName,
  )
  const sourceComponentId = String(sourceComponent?.source_component_id ?? "")
  if (!sourceComponentId) {
    throw new Error(
      `source component ${componentName} is absent from Circuit JSON`,
    )
  }
  const internalConnection = circuitJson.find(
    (element) =>
      element.type === "source_component_internal_connection" &&
      element.source_component_id === sourceComponentId,
  )
  const sourcePortIds = new Set(
    (internalConnection?.source_port_ids as string[] | undefined) ?? [],
  )
  const sourcePortNames = sortedUnique(
    circuitJson
      .filter(
        (element) =>
          element.type === "source_port" &&
          element.source_component_id === sourceComponentId &&
          sourcePortIds.has(String(element.source_port_id)),
      )
      .map((element) => String(element.name)),
  )
  if (sourcePortNames.length === 0) {
    throw new Error(`${componentName} has no internal power/ground port group`)
  }
  return { componentName, sourceComponentId, sourcePortNames }
}

const findSourceComponentId = (input: SimpleRouteJson) => {
  const sourcePointIds = new Set(
    input.connections.flatMap((connection) => {
      const source = connection.pointsToConnect[0]
      return [source?.pointId, source?.pcb_port_id].filter((id): id is string =>
        Boolean(id),
      )
    }),
  )
  const componentId = input.obstacles.find(
    (obstacle) =>
      obstacle.componentId &&
      sourcePointIds.has(obstacle.circuitJsonMetadata?.pcb_port_id ?? ""),
  )?.componentId
  if (!componentId)
    throw new Error("unable to derive breakout source component")
  return componentId
}

/**
 * Core flattens a board-wide source net into a pour carrying only one of the
 * equivalent component-internal identities. Re-key only pours sharing a
 * source_net token with the active component's assignable pads. This is the
 * same electrical net, derived from SRJ connectivity rather than device names.
 */
export const normalizeActivePowerPourConnectivity = (
  input: SimpleRouteJson,
) => {
  const normalized = structuredClone(input)
  const componentId = findSourceComponentId(normalized)
  const activePowerPads = normalized.obstacles.filter(
    (obstacle) =>
      obstacle.componentId === componentId && obstacle.netIsAssignable,
  )
  const activeInternalIdentities = sortedUnique(
    activePowerPads.flatMap((obstacle) => obstacle.offBoardConnectsTo ?? []),
  )
  if (activeInternalIdentities.length !== 1) {
    throw new Error(
      `expected one active internal power identity, found ${activeInternalIdentities.length}`,
    )
  }
  const commonSourceNets = new Set(
    activePowerPads.flatMap((obstacle) =>
      obstacle.connectedTo.filter((token) => token.startsWith("source_net_")),
    ),
  )
  if (commonSourceNets.size === 0) {
    throw new Error("active power pads have no common source_net connectivity")
  }
  let normalizedPourCount = 0
  for (const obstacle of normalized.obstacles) {
    if (!obstacle.isCopperPour || !obstacle.netIsAssignable) continue
    if (!obstacle.connectedTo.some((token) => commonSourceNets.has(token))) {
      continue
    }
    obstacle.offBoardConnectsTo = [activeInternalIdentities[0]!]
    normalizedPourCount++
  }
  if (normalizedPourCount === 0) {
    throw new Error("no active-net copper pour was found for the breakout")
  }
  return normalized
}

const getFixedTarget = (connection: SimpleRouteJson["connections"][number]) => {
  const explicit = connection.pointsToConnect.find((point) =>
    point.pointId?.startsWith("pcb_breakout_point"),
  )
  return explicit ?? connection.pointsToConnect.at(-1)
}

/** Scales a fixed target rail about its geometric center without knowing pads/nets. */
export const scaleBreakoutTargetSpacing = (
  input: SimpleRouteJson,
  scale: number,
) => {
  if (!(scale > 0)) throw new Error(`invalid target-spacing scale ${scale}`)
  const scaled = structuredClone(input)
  const targets = scaled.connections.map(getFixedTarget)
  if (targets.some((target) => !target)) {
    throw new Error("a breakout connection is missing its fixed target")
  }
  const yValues = targets.map((target) => target!.y)
  const centerY = (Math.min(...yValues) + Math.max(...yValues)) / 2
  for (const target of targets) {
    target!.y = Q(centerY + (target!.y - centerY) * scale)
  }
  return scaled
}

const minimumDistinctSpacing = (input: SimpleRouteJson) => {
  const values = [
    ...new Set(
      input.connections.map((connection) => Q(getFixedTarget(connection)!.y)),
    ),
  ].sort((first, second) => first - second)
  let minimum = Number.POSITIVE_INFINITY
  for (let index = 1; index < values.length; index++) {
    minimum = Math.min(minimum, values[index]! - values[index - 1]!)
  }
  return minimum
}

const targetBoundsAreValid = (input: SimpleRouteJson) => {
  // A fixed breakout target is a trace endpoint on the local routing boundary,
  // not a via center. The captured valid baseline intentionally places the
  // target rail on that boundary, so validate the endpoint itself.
  return input.connections
    .map(getFixedTarget)
    .every(
      (target) =>
        target &&
        target.x >= input.bounds.minX - EPSILON &&
        target.x <= input.bounds.maxX + EPSILON &&
        target.y >= input.bounds.minY - EPSILON &&
        target.y <= input.bounds.maxY + EPSILON,
    )
}

const getSignalNameByPortId = (input: SimpleRouteJson) =>
  new Map(
    input.obstacles
      .filter(
        (obstacle) =>
          obstacle.circuitJsonMetadata?.pcb_port_id &&
          obstacle.circuitJsonMetadata?.source_port_name,
      )
      .map((obstacle) => [
        obstacle.circuitJsonMetadata!.pcb_port_id!,
        obstacle.circuitJsonMetadata!.source_port_name!,
      ]),
  )

const countCoveredPads = (plan: PowerPlanePlan) => {
  const droppedClusters = new Set(plan.viaDrops.map((drop) => drop.clusterId))
  return new Set(
    plan.clusters
      .filter((cluster) => droppedClusters.has(cluster.id))
      .flatMap((cluster) => cluster.padIds),
  )
}

const auditVias = (
  model: FanoutModel,
  signalVias: Array<{ x: number; y: number }>,
  drops: CopperPourViaDrop[],
) => {
  const vias = [...signalVias, ...drops.map((drop) => drop.via)]
  let viaInPadCount = 0
  let viaClearanceViolationCount = 0
  let minimumClearance = Number.POSITIVE_INFINITY
  for (const via of vias) {
    for (const pad of model.pads) {
      const centerDistance = distance(via, pad)
      const edgeClearance =
        centerDistance - pad.radius - model.rules.viaDiameter / 2
      minimumClearance = Math.min(minimumClearance, edgeClearance)
      if (centerDistance < pad.radius - EPSILON) viaInPadCount++
      if (edgeClearance + EPSILON < model.rules.viaToPadClearance) {
        viaClearanceViolationCount++
      }
    }
  }
  return {
    viaInPadCount,
    viaClearanceViolationCount,
    minimumClearance: Q(minimumClearance),
  }
}

const runWorker = async (args: Map<string, string>) => {
  const inputPath = requiredArg(args, "--input")
  const groundReferencePath = requiredArg(args, "--ground-reference")
  const componentName = requiredArg(args, "--component")
  const scale = Number(requiredArg(args, "--scale"))
  const circuitJson = (await Bun.file(
    groundReferencePath,
  ).json()) as CircuitJsonElement[]
  const groundReference = getGroundReference(circuitJson, componentName)
  const rawInput = (await Bun.file(inputPath).json()) as SimpleRouteJson
  const normalizedInput = normalizeActivePowerPourConnectivity(rawInput)
  const scaledInput = scaleBreakoutTargetSpacing(normalizedInput, scale)
  const targetBoundsValid = targetBoundsAreValid(scaledInput)
  if (!targetBoundsValid) {
    throw new Error(`${scale}x target rail exceeds the captured routing bounds`)
  }
  const model = buildFanoutModel(scaledInput)
  const startedAt = performance.now()
  const solver = new FixedTargetBgaFanoutSolver(scaledInput)
  solver.solveUntilStage(PIPELINE_STOP_STAGE)
  const elapsedMs = Math.round(performance.now() - startedAt)
  const session = solver.getStageOutput<IncrementalReferenceFanoutSession>(
    "planCopperPourViaDrops",
  )
  if (solver.failed || !session) {
    const result: SpacingCaseResult = {
      componentName,
      scale,
      elapsedMs,
      stageReached: solver.getCurrentStageName(),
      signalCount: 0,
      expectedGroundPadCount: groundReference.sourcePortNames.length,
      detectedGroundPadCount: 0,
      directGroundPadCount: 0,
      unresolvedGroundPads: [...groundReference.sourcePortNames],
      watchedGroundPads: Object.fromEntries(
        WATCHED_GROUND_PADS.map((name) => [
          name,
          groundReference.sourcePortNames.includes(name)
            ? "unresolved"
            : "not_applicable",
        ]),
      ) as SpacingCaseResult["watchedGroundPads"],
      signalVias: [],
      signalViaCount: 0,
      groundViaCount: 0,
      viaInPadCount: 0,
      viaClearanceViolationCount: 0,
      minimumViaToPadEdgeClearanceMm: Number.NaN,
      requiredViaToPadEdgeClearanceMm: model.rules.viaToPadClearance,
      throughViaCount: 0,
      nonThroughViaCount: 0,
      baseDistinctTargetSpacingMm: Q(minimumDistinctSpacing(normalizedInput)),
      scaledDistinctTargetSpacingMm: Q(minimumDistinctSpacing(scaledInput)),
      targetBoundsValid,
      failed: true,
      error: String(
        solver.error ?? "solver did not reach the power-plan stage",
      ),
    }
    console.log(JSON.stringify(result))
    return
  }

  const routes = session.getRoutes()
  const committedModel = session.getVisualizationContext().model
  const plan = committedModel.powerPlanePlan
  if (!plan) throw new Error("power-plane plan was not committed")
  const expectedNames = new Set(groundReference.sourcePortNames)
  const detectedGroundPads = plan.pads.filter((pad) =>
    expectedNames.has(pad.sourcePortName ?? ""),
  )
  if (detectedGroundPads.length !== expectedNames.size) {
    throw new Error(
      `${componentName} expected ${expectedNames.size} power pads, detected ${detectedGroundPads.length}`,
    )
  }
  const coveredPadIds = countCoveredPads(plan)
  const coveredGroundNames = new Set(
    detectedGroundPads
      .filter((pad) => coveredPadIds.has(pad.id))
      .map((pad) => pad.sourcePortName!),
  )
  const unresolvedGroundPads = groundReference.sourcePortNames.filter(
    (name) => !coveredGroundNames.has(name),
  )
  const signalNameByPortId = getSignalNameByPortId(scaledInput)
  const signalVias = routes.map((route) => ({
    connectionName: route.connectionName,
    signalName:
      signalNameByPortId.get(
        String(
          scaledInput.connections.find(
            (connection) => connection.name === route.connectionName,
          )?.pointsToConnect[0]?.pcb_port_id ?? "",
        ),
      ) ?? route.connectionName,
    x: Q(model.axisSign * route.via.x),
    y: Q(route.via.y),
    selectedLayer: route.selectedLayer,
  }))
  const viaAudit = auditVias(
    committedModel,
    routes.map((route) => route.via),
    plan.viaDrops,
  )
  const builtSignalVias = session
    .buildOutput()
    .traces.flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via")
  const powerVias = (committedModel.input.traces ?? [])
    .filter((trace) => trace.pcb_trace_id.startsWith("bga-power-plane:drop:"))
    .flatMap((trace) => trace.route)
    .filter((point) => point.route_type === "via")
  const allBuiltVias = [...builtSignalVias, ...powerVias]
  const throughViaCount = allBuiltVias.filter(
    (via) => via.from_layer === "top" && via.to_layer === "bottom",
  ).length
  const result: SpacingCaseResult = {
    componentName,
    scale,
    elapsedMs,
    stageReached: solver.getCurrentStageName(),
    signalCount: routes.length,
    expectedGroundPadCount: expectedNames.size,
    detectedGroundPadCount: detectedGroundPads.length,
    directGroundPadCount: coveredGroundNames.size,
    unresolvedGroundPads,
    watchedGroundPads: Object.fromEntries(
      WATCHED_GROUND_PADS.map((name) => [
        name,
        !expectedNames.has(name)
          ? "not_applicable"
          : coveredGroundNames.has(name)
            ? "direct"
            : "unresolved",
      ]),
    ) as SpacingCaseResult["watchedGroundPads"],
    signalVias,
    signalViaCount: builtSignalVias.length,
    groundViaCount: powerVias.length,
    viaInPadCount: viaAudit.viaInPadCount,
    viaClearanceViolationCount: viaAudit.viaClearanceViolationCount,
    minimumViaToPadEdgeClearanceMm: viaAudit.minimumClearance,
    requiredViaToPadEdgeClearanceMm: committedModel.rules.viaToPadClearance,
    throughViaCount,
    nonThroughViaCount: allBuiltVias.length - throughViaCount,
    baseDistinctTargetSpacingMm: Q(minimumDistinctSpacing(normalizedInput)),
    scaledDistinctTargetSpacingMm: Q(minimumDistinctSpacing(scaledInput)),
    targetBoundsValid,
    failed: false,
    error: null,
  }
  console.log(JSON.stringify(result))
}

const runBoundedWorker = async (params: {
  inputPath: string
  groundReferencePath: string
  componentName: string
  scale: number
}): Promise<TimedWorkerResult> => {
  const startedAt = performance.now()
  const child = Bun.spawn(
    [
      "bun",
      import.meta.path,
      "--worker",
      "--input",
      params.inputPath,
      "--ground-reference",
      params.groundReferencePath,
      "--component",
      params.componentName,
      "--scale",
      String(params.scale),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
  }, WORKER_WALL_CLOCK_LIMIT_MS)
  const exitCode = await child.exited
  clearTimeout(timer)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  const elapsedMs = Math.round(performance.now() - startedAt)
  if (timedOut) {
    return {
      status: "timeout",
      error: `worker exceeded ${WORKER_WALL_CLOCK_LIMIT_MS} ms`,
      elapsedMs,
    }
  }
  if (exitCode !== 0) {
    return {
      status: "failed",
      error: stderr.trim() || stdout.trim() || `worker exited ${exitCode}`,
      elapsedMs,
    }
  }
  const lastLine = stdout.trim().split("\n").at(-1)
  if (!lastLine) {
    return { status: "failed", error: "worker produced no result", elapsedMs }
  }
  return { status: "completed", result: JSON.parse(lastLine) }
}

const compareViaMovements = (
  baseline: SpacingCaseResult,
  candidate: SpacingCaseResult,
) => {
  const baselineByConnection = new Map(
    baseline.signalVias.map((via) => [via.connectionName, via]),
  )
  return candidate.signalVias
    .filter((via) => {
      const previous = baselineByConnection.get(via.connectionName)
      return (
        !previous ||
        distance(via, previous) > EPSILON ||
        via.selectedLayer !== previous.selectedLayer
      )
    })
    .map((via) => {
      const previous = baselineByConnection.get(via.connectionName)
      return {
        signalName: via.signalName,
        connectionName: via.connectionName,
        from: previous
          ? { x: previous.x, y: previous.y, layer: previous.selectedLayer }
          : null,
        to: { x: via.x, y: via.y, layer: via.selectedLayer },
      }
    })
}

const runSweep = async (args: Map<string, string>) => {
  const socInput = requiredArg(args, "--soc-input")
  const ramInput = requiredArg(args, "--ram-input")
  const groundReference = requiredArg(args, "--ground-reference")
  const outDir = requiredArg(args, "--out")
  const scales = [1, 1.25, 1.5, 2]
  const results: Array<{
    scale: number
    soc: TimedWorkerResult
    ram: TimedWorkerResult
  }> = []
  if (args.has("--report-only")) {
    const priorReport = (await Bun.file(
      `${outDir}/breakpoint-spacing-sweep.json`,
    ).json()) as { raw: typeof results }
    results.push(...priorReport.raw)
  } else {
    for (const scale of scales) {
      const [soc, ram] = await Promise.all([
        runBoundedWorker({
          inputPath: socInput,
          groundReferencePath: groundReference,
          componentName: "U1",
          scale,
        }),
        runBoundedWorker({
          inputPath: ramInput,
          groundReferencePath: groundReference,
          componentName: "U2",
          scale,
        }),
      ])
      results.push({ scale, soc, ram })
      console.log(
        JSON.stringify({
          event: "spacing-case-complete",
          scale,
          soc:
            soc.status === "completed"
              ? {
                  failed: soc.result.failed,
                  signals: soc.result.signalCount,
                  ground: `${soc.result.directGroundPadCount}/${soc.result.expectedGroundPadCount}`,
                  watched: soc.result.watchedGroundPads,
                  elapsedMs: soc.result.elapsedMs,
                }
              : soc,
          ram:
            ram.status === "completed"
              ? {
                  failed: ram.result.failed,
                  signals: ram.result.signalCount,
                  ground: `${ram.result.directGroundPadCount}/${ram.result.expectedGroundPadCount}`,
                  watched: ram.result.watchedGroundPads,
                  elapsedMs: ram.result.elapsedMs,
                }
              : ram,
        }),
      )
    }
  }

  const baseline = results[0]
  const baselineSoc =
    baseline?.soc.status === "completed" ? baseline.soc.result : null
  const baselineRam =
    baseline?.ram.status === "completed" ? baseline.ram.result : null
  const summarized = results.map((entry) => {
    const socResult = entry.soc.status === "completed" ? entry.soc.result : null
    const ramResult = entry.ram.status === "completed" ? entry.ram.result : null
    const soc = socResult && !socResult.failed ? socResult : null
    const ram = ramResult && !ramResult.failed ? ramResult : null
    const viaMovements = [
      ...(soc && baselineSoc ? compareViaMovements(baselineSoc, soc) : []),
      ...(ram && baselineRam ? compareViaMovements(baselineRam, ram) : []),
    ]
    const directGroundPadCount =
      soc && ram ? soc.directGroundPadCount + ram.directGroundPadCount : null
    const expectedGroundPadCount =
      soc && ram ? soc.expectedGroundPadCount + ram.expectedGroundPadCount : 155
    const fullySignalRouted = Boolean(
      soc?.signalCount === 33 && ram?.signalCount === 33,
    )
    const rulesPass = Boolean(
      soc &&
        ram &&
        soc.viaInPadCount === 0 &&
        ram.viaInPadCount === 0 &&
        soc.viaClearanceViolationCount === 0 &&
        ram.viaClearanceViolationCount === 0 &&
        soc.nonThroughViaCount === 0 &&
        ram.nonThroughViaCount === 0,
    )
    return {
      scale: entry.scale,
      status: [
        entry.soc.status !== "completed"
          ? `U1:${entry.soc.status}`
          : entry.soc.result.failed
            ? `U1:failed@${entry.soc.result.stageReached}`
            : "U1:completed",
        entry.ram.status !== "completed"
          ? `U2:${entry.ram.status}`
          : entry.ram.result.failed
            ? `U2:failed@${entry.ram.result.stageReached}`
            : "U2:completed",
      ].join("; "),
      signals:
        soc && ram
          ? `${Math.min(soc.signalCount, ram.signalCount)}/33`
          : "incomplete",
      producerDirectGround:
        directGroundPadCount === null
          ? "incomplete"
          : `${directGroundPadCount}/${expectedGroundPadCount}`,
      watchedGroundPads: {
        H1: soc?.watchedGroundPads.H1 ?? "not_measured",
        M1: soc?.watchedGroundPads.M1 ?? "not_measured",
        E8: ram?.watchedGroundPads.E8 ?? "not_measured",
      },
      viaMovements,
      movedSignalVias: viaMovements.length,
      movedBlockerSignals: viaMovements
        .map((movement) => movement.signalName)
        .filter((name) =>
          ["DQ5", "CS0_n", "DQ13", "DQ14", "DQ15"].includes(name),
        ),
      viaInPadCount: soc && ram ? soc.viaInPadCount + ram.viaInPadCount : null,
      viaClearanceViolationCount:
        soc && ram
          ? soc.viaClearanceViolationCount + ram.viaClearanceViolationCount
          : null,
      minimumViaToPadEdgeClearanceMm:
        soc && ram
          ? Math.min(
              soc.minimumViaToPadEdgeClearanceMm,
              ram.minimumViaToPadEdgeClearanceMm,
            )
          : null,
      throughVias:
        soc && ram
          ? `${soc.throughViaCount + ram.throughViaCount}/${
              soc.throughViaCount +
              ram.throughViaCount +
              soc.nonThroughViaCount +
              ram.nonThroughViaCount
            }`
          : "incomplete",
      targetSpacingMm: {
        soc: soc?.scaledDistinctTargetSpacingMm ?? null,
        ram: ram?.scaledDistinctTargetSpacingMm ?? null,
      },
      runtimeMs: Math.max(
        entry.soc.status === "completed"
          ? entry.soc.result.elapsedMs
          : entry.soc.elapsedMs,
        entry.ram.status === "completed"
          ? entry.ram.result.elapsedMs
          : entry.ram.elapsedMs,
      ),
      fullySignalRouted,
      rulesPass,
      failure:
        [
          socResult?.failed ? `U1: ${socResult.error}` : null,
          ramResult?.failed ? `U2: ${ramResult.error}` : null,
          entry.soc.status !== "completed" ? `U1: ${entry.soc.error}` : null,
          entry.ram.status !== "completed" ? `U2: ${entry.ram.error}` : null,
        ]
          .filter(Boolean)
          .join("; ") || null,
      eligibleForFullConsumerBuild:
        fullySignalRouted &&
        rulesPass &&
        Boolean(
          soc?.watchedGroundPads.H1 === "direct" ||
            soc?.watchedGroundPads.M1 === "direct" ||
            ram?.watchedGroundPads.E8 === "direct",
        ),
      shorts: "not_run_pre_co_router_feasibility",
    }
  })

  const report = {
    generatedAt: new Date().toISOString(),
    scope: "scratch producer SRJ breakpoint-spacing feasibility sweep",
    inputs: { socInput, ramInput, groundReference },
    constraints: {
      scales,
      workerWallClockLimitMs: WORKER_WALL_CLOCK_LIMIT_MS,
      pipelineStopStage: PIPELINE_STOP_STAGE,
      pipelineIterationLimit: PIPELINE_ITERATION_LIMIT,
      powerAssignmentSearchNodeLimit: POWER_ASSIGNMENT_SEARCH_NODE_LIMIT,
      coRouterInvoked: false,
      preservedConsumerArtifactsUntouched: true,
    },
    rows: summarized,
    raw: results,
  }
  await Bun.write(
    `${outDir}/breakpoint-spacing-sweep.json`,
    JSON.stringify(report, null, 2),
  )
  const markdownRows = summarized
    .map(
      (row) =>
        `| ${row.scale.toFixed(2)}× | ${row.status} | ${row.signals} | ${row.producerDirectGround} | ${row.watchedGroundPads.H1}/${row.watchedGroundPads.M1}/${row.watchedGroundPads.E8} | ${row.movedSignalVias} (${row.movedBlockerSignals.join(", ") || "none"}) | ${row.viaInPadCount ?? "n/a"} | ${row.throughVias} | ${row.minimumViaToPadEdgeClearanceMm ?? "n/a"} | ${row.runtimeMs} | ${row.shorts} |`,
    )
    .join("\n")
  const markdown = `# Breakpoint-spacing sweep\n\nThis is a bounded pre-co-router feasibility sweep over the exact preserved U1/U2 debug SRJs. It scales every fixed-target rail about its derived geometric center; it does not contain pad, signal, or board-coordinate exceptions. The preserved consumer TSX and \`dist/index\` were not modified.\n\n| Scale | Status | DDR breakout | Producer direct GND | H1/M1/E8 | Signal vias moved (known blockers) | Via-in-pad | Through vias | Min via-pad edge clearance (mm) | Runtime max (ms) | Shorts |\n|---:|---|---:|---:|---|---|---:|---:|---:|---:|---|\n${markdownRows}\n\n- Required via-to-pad edge clearance: 0.08128 mm.\n- \`producer direct GND\` counts only VSS pads in clusters with a solver-generated top-to-bottom plane drop; existing top-pour mediation is intentionally outside this cheap SRJ stage.\n- A full consumer build and shorts check is reserved for a scaled case that recovers H1, M1, or E8 while retaining 33/33 signals and all via rules.\n- Per-net via coordinates and movements are retained in \`breakpoint-spacing-sweep.json\`.\n`
  await Bun.write(`${outDir}/breakpoint-spacing-sweep.md`, markdown)
  console.log(
    JSON.stringify({ event: "spacing-sweep-complete", rows: summarized }),
  )
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2))
  if (args.has("--worker")) await runWorker(args)
  else await runSweep(args)
}
