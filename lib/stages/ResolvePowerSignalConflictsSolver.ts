import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import {
  buildBoundedPowerSignalReservationPlans,
  buildReservationGeometry,
  type PowerSignalReservationPlan,
} from "../model/powerSignalCoRouting"
import {
  selectBestValidPowerSignalSolution,
  type ValidPowerSignalSolution,
} from "../model/bestValidPowerSignalSolution"
import { pathLength } from "../model/powerPlanePlanning"
import type {
  PowerPlanePlan,
  PowerSignalCoRoutingSummary,
  PowerSignalCoRoutingScore,
  PowerSignalCoRoutingFailure,
  PowerSignalRouteChange,
  RankedFanoutModel,
} from "../model/types"
import {
  IncrementalReferenceFanoutSession,
  type ReferenceRouteSnapshot,
} from "../private/reference/solve-am62l-free-space-fanout"
import { visualizeModel } from "../visualize/modelVisuals"
import { PlanCopperPourViaDropsSolver } from "./PlanCopperPourViaDropsSolver"
import {
  PlanSameNetPadClustersSolver,
  type PowerPlanePlanningContext,
} from "./PlanSameNetPadClustersSolver"

const MAX_EARLY_ROUTE_STEPS = 1_000_000
const MAX_TOP_ROUTE_STEPS = 100_000
const MAX_INNER_ROUTE_STEPS = 1_000_000
const MAX_CONFLICT_CLOSURE_SIGNALS = 16
const MAX_CONFLICT_CLOSURE_ITERATIONS = 4

type VerifiedTrial = {
  id: string
  session: IncrementalReferenceFanoutSession
  plan: PowerSignalReservationPlan
  affectedSignalNames: string[]
  routeChanges: PowerSignalRouteChange[]
  score: PowerSignalCoRoutingScore
}

const routeLength = (route: ReferenceRouteSnapshot) =>
  pathLength(route.topPath) + pathLength(route.innerPath)

const routeSignature = (route: ReferenceRouteSnapshot) =>
  JSON.stringify({
    selectedLayer: route.selectedLayer,
    topPath: route.topPath,
    via: route.via,
    innerPath: route.innerPath,
  })

const routeSegments = (route: ReferenceRouteSnapshot) => [
  ...route.topPath.slice(1).map((point, index) => ({
    a: route.topPath[index]!,
    b: point,
    layer: "top",
    connectionName: route.connectionName,
  })),
  ...route.innerPath.slice(1).map((point, index) => ({
    a: route.innerPath[index]!,
    b: point,
    layer: route.selectedLayer,
    connectionName: route.connectionName,
  })),
]

const buildSelectiveRankedModel = ({
  rankedModel,
  affectedSignalNames,
  preservedRoutes,
}: {
  rankedModel: RankedFanoutModel
  affectedSignalNames: ReadonlySet<string>
  preservedRoutes: readonly ReferenceRouteSnapshot[]
}): RankedFanoutModel => {
  const selective = structuredClone(rankedModel)
  selective.model.nets = selective.model.nets.filter((net) =>
    affectedSignalNames.has(net.connectionName),
  )
  selective.model.input.connections = selective.model.input.connections.filter(
    (connection) => affectedSignalNames.has(connection.name),
  )
  selective.model.input.buses = (selective.model.input.buses ?? [])
    .map((bus) => ({
      ...bus,
      connectionNames: bus.connectionNames.filter((connectionName) =>
        affectedSignalNames.has(connectionName),
      ),
    }))
    .filter((bus) => bus.connectionNames.length > 0)
  selective.model.previousSegments.push(
    ...preservedRoutes.flatMap(routeSegments),
  )
  selective.model.previousVias.push(
    ...preservedRoutes.map((route) => ({
      ...route.via,
      fromLayer: "top",
      toLayer: "bottom",
    })),
  )
  return selective
}

const coveredPowerPadIds = (plan: PowerPlanePlan) => {
  const droppedClusterIds = new Set(plan.viaDrops.map((drop) => drop.clusterId))
  return new Set(
    plan.clusters
      .filter((cluster) => droppedClusterIds.has(cluster.id))
      .flatMap((cluster) => cluster.padIds),
  )
}

const unresolvedViaDrops = (session: IncrementalReferenceFanoutSession) =>
  structuredClone(
    session.getVisualizationContext().model.powerPlanePlan
      ?.unresolvedViaDrops ?? [],
  )

const drain = (label: string, maximumSteps: number, advance: () => boolean) => {
  for (let step = 0; step < maximumSteps; step++) {
    if (advance()) return step + 1
  }
  throw new Error(`${label} exceeded ${maximumSteps} bounded steps`)
}

/**
 * Bounded signal/power co-planning fallback. Normal signal-first output is
 * retained unless every signal can be revalidated around a complete set of
 * geometry-derived plane corridors.
 */
export class ResolvePowerSignalConflictsSolver extends BaseSolver {
  private readonly reservationPlans: PowerSignalReservationPlan[]
  private readonly baselineRoutes: ReferenceRouteSnapshot[]
  private output: IncrementalReferenceFanoutSession
  private trialCursor = 0
  private readonly verifiedTrials: VerifiedTrial[] = []
  private readonly failures: PowerSignalCoRoutingFailure[] = []
  private readonly rankedModel: RankedFanoutModel
  private readonly initialContext: PowerPlanePlanningContext
  private readonly baselineSession: IncrementalReferenceFanoutSession

  constructor(params: {
    rankedModel: RankedFanoutModel
    initialContext: PowerPlanePlanningContext
    baselineSession: IncrementalReferenceFanoutSession
  }) {
    super()
    this.rankedModel = params.rankedModel
    this.initialContext = params.initialContext
    this.baselineSession = params.baselineSession
    this.output = this.baselineSession
    this.baselineRoutes = this.baselineSession.getRoutes()
    const initialPlan =
      this.baselineSession.getVisualizationContext().model.powerPlanePlan
    this.reservationPlans = initialPlan
      ? buildBoundedPowerSignalReservationPlans({
          rankedModel: this.rankedModel.model,
          signalModel: this.initialContext.model,
          plan: initialPlan,
          signalRoutes: this.baselineRoutes,
        })
      : []
    this.MAX_ITERATIONS = Math.max(2, this.reservationPlans.length + 2)
  }

  override getConstructorParams() {
    return [
      {
        rankedModel: this.rankedModel,
        initialContext: this.initialContext,
        baselineSession: this.baselineSession,
      },
    ]
  }

  override _setup() {
    this.updateStats("ready")
  }

  override _step() {
    const initialPlan =
      this.baselineSession.getVisualizationContext().model.powerPlanePlan
    if (!initialPlan || initialPlan.unresolvedViaDrops.length === 0) {
      this.finish()
      return
    }
    const reservationPlan = this.reservationPlans[this.trialCursor]
    if (!reservationPlan) {
      this.finish()
      return
    }
    const planIndex = this.trialCursor++
    this.updateStats("reroute_signal_trial", reservationPlan)
    try {
      this.verifiedTrials.push(
        this.runTrial(initialPlan, reservationPlan, planIndex),
      )
    } catch (error) {
      this.failures.push({
        planIndex,
        affectedSignalNames: [...reservationPlan.affectedSignalNames],
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    this.updateStats("completed_signal_trial", reservationPlan)
  }

  private runTrial(
    initialPlan: NonNullable<
      ReturnType<
        IncrementalReferenceFanoutSession["getVisualizationContext"]
      >["model"]["powerPlanePlan"]
    >,
    reservationPlan: PowerSignalReservationPlan,
    planIndex: number,
  ): VerifiedTrial {
    const affectedNames = new Set(reservationPlan.affectedSignalNames)
    let combinedSession: IncrementalReferenceFanoutSession | undefined
    let lastFailure: unknown
    for (
      let closureIteration = 0;
      closureIteration < MAX_CONFLICT_CLOSURE_ITERATIONS;
      closureIteration++
    ) {
      const reroute = this.runSelectiveSignalTrial(
        initialPlan,
        reservationPlan,
        affectedNames,
      )
      if (reroute.session) {
        combinedSession = reroute.session
        break
      }
      lastFailure = reroute.error
      const newlyAffected = reroute.blockingSignalNames.filter(
        (connectionName) => !affectedNames.has(connectionName),
      )
      if (
        newlyAffected.length === 0 ||
        affectedNames.size + newlyAffected.length > MAX_CONFLICT_CLOSURE_SIGNALS
      ) {
        break
      }
      for (const connectionName of newlyAffected) {
        affectedNames.add(connectionName)
      }
    }
    if (!combinedSession) {
      const reason =
        lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
      throw new Error(
        `${reason}; bounded conflict closure ${affectedNames.size}/${MAX_CONFLICT_CLOSURE_SIGNALS} signals: ${[...affectedNames].sort().join(",")}`,
      )
    }

    const clusterSolver = new PlanSameNetPadClustersSolver({
      session: combinedSession,
      freeCells: this.initialContext.freeCells,
    })
    clusterSolver.solve()
    const context = clusterSolver.getOutput()
    const dropSolver = new PlanCopperPourViaDropsSolver(context)
    dropSolver.solve()
    const routedSession = dropSolver.getOutput()
    const finalPlan =
      routedSession.getVisualizationContext().model.powerPlanePlan
    if (!finalPlan) {
      throw new Error("co-routing trial produced no power-plane plan")
    }

    const baselineByName = new Map(
      this.baselineRoutes.map((route) => [route.connectionName, route]),
    )
    const routeChanges = routedSession
      .getRoutes()
      .filter((route) => {
        const baseline = baselineByName.get(route.connectionName)
        return !baseline || routeSignature(baseline) !== routeSignature(route)
      })
      .map((route): PowerSignalRouteChange => {
        const baseline = baselineByName.get(route.connectionName)!
        return {
          connectionName: route.connectionName,
          previousLayer: baseline.selectedLayer,
          selectedLayer: route.selectedLayer,
          previousLength: routeLength(baseline),
          routedLength: routeLength(route),
        }
      })
      .sort((first, second) =>
        first.connectionName.localeCompare(second.connectionName),
      )
    const addedSignalLength = routeChanges.reduce(
      (sum, change) =>
        sum + Math.max(0, change.routedLength - change.previousLength),
      0,
    )
    return {
      id: `plan-${planIndex}:${reservationPlan.corridors
        .map((corridor) => corridor.id)
        .join("|")}`,
      session: routedSession,
      plan: reservationPlan,
      affectedSignalNames: [...affectedNames].sort(),
      routeChanges,
      score: {
        requiredSignalCount: this.baselineRoutes.length,
        routedSignalCount: routedSession.getRoutes().length,
        physicallyValid: true,
        coveredPowerPadCount: coveredPowerPadIds(finalPlan).size,
        reroutedSignalCount: routeChanges.length,
        addedSignalLength,
        addedPowerLength: reservationPlan.totalLength,
        powerBendCount: reservationPlan.totalBends,
      },
    }
  }

  private runSelectiveSignalTrial(
    initialPlan: PowerPlanePlan,
    reservationPlan: PowerSignalReservationPlan,
    affectedNames: ReadonlySet<string>,
  ): {
    session?: IncrementalReferenceFanoutSession
    error?: unknown
    blockingSignalNames: string[]
  } {
    const preservedRoutes = this.baselineRoutes.filter(
      (route) => !affectedNames.has(route.connectionName),
    )
    const session = new IncrementalReferenceFanoutSession(
      buildSelectiveRankedModel({
        rankedModel: this.rankedModel,
        affectedSignalNames: affectedNames,
        preservedRoutes,
      }),
    )
    session.setRouteHints(this.baselineRoutes)
    session.reserveTemporaryPowerCorridors(
      buildReservationGeometry(initialPlan, reservationPlan),
    )
    try {
      drain("co-route early signal escape", MAX_EARLY_ROUTE_STEPS, () =>
        session.stepIndependentEarlyDropVias(),
      )
      drain("co-route top signal escape", MAX_TOP_ROUTE_STEPS, () =>
        session.stepResidualTopDogbones(),
      )
      session.assignPreferredLayers()
      drain("co-route inner signal escape", MAX_INNER_ROUTE_STEPS, () =>
        session.stepPrescribedInnerLayers(),
      )
      while (session.miterNextRoute()) {
        // The route count bounds this deterministic pass.
      }
      session.validate()
    } catch (error) {
      return {
        error,
        blockingSignalNames: session.getSelectiveViaLineBlockingSignals(),
      }
    }
    session.clearTemporaryPowerCorridors()

    const combinedSession = new IncrementalReferenceFanoutSession(
      structuredClone(this.rankedModel),
    )
    combinedSession.replaceRoutesWithSnapshots([
      ...preservedRoutes,
      ...session.getRoutes(),
    ])
    combinedSession.reserveTemporaryPowerCorridors(
      buildReservationGeometry(initialPlan, reservationPlan),
    )
    combinedSession.validate()
    combinedSession.clearTemporaryPowerCorridors()
    return {
      session: combinedSession,
      blockingSignalNames: [],
    }
  }

  private finish() {
    const baselinePlan =
      this.baselineSession.getVisualizationContext().model.powerPlanePlan
    const baselineScore: PowerSignalCoRoutingScore = {
      requiredSignalCount: this.baselineRoutes.length,
      routedSignalCount: this.baselineRoutes.length,
      physicallyValid: true,
      coveredPowerPadCount: baselinePlan
        ? coveredPowerPadIds(baselinePlan).size
        : 0,
      reroutedSignalCount: 0,
      addedSignalLength: 0,
      addedPowerLength: 0,
      powerBendCount: 0,
    }
    const baseline: ValidPowerSignalSolution<IncrementalReferenceFanoutSession> =
      {
        id: "baseline",
        output: this.baselineSession,
        score: baselineScore,
      }
    const trialCandidates = this.verifiedTrials.map(
      (trial): ValidPowerSignalSolution<IncrementalReferenceFanoutSession> => ({
        id: trial.id,
        output: trial.session,
        score: trial.score,
      }),
    )
    const bestCandidate = selectBestValidPowerSignalSolution([
      baseline,
      ...trialCandidates,
    ])
    const bestTrial = this.verifiedTrials.find(
      (trial) => trial.id === bestCandidate.id,
    )
    const applied = Boolean(bestTrial)
    this.output = bestCandidate.output
    const status: PowerSignalCoRoutingSummary["status"] =
      !baselinePlan || baselinePlan.unresolvedViaDrops.length === 0
        ? "not_needed"
        : this.reservationPlans.length === 0
          ? "no_reservation_plan"
          : applied
            ? "improved"
            : "baseline_retained"
    const summary: PowerSignalCoRoutingSummary = {
      status,
      generatedPlans: this.reservationPlans.length,
      attemptedPlans: this.trialCursor,
      applied,
      baselineScore,
      selectedScore: bestCandidate.score,
      unresolvedViaDrops: unresolvedViaDrops(this.output),
      failures: structuredClone(this.failures),
      affectedSignalNames: bestTrial?.affectedSignalNames ?? [],
      reroutedSignalNames:
        bestTrial?.routeChanges.map((change) => change.connectionName) ?? [],
      routeChanges: bestTrial?.routeChanges ?? [],
      reservedCorridorCount: bestTrial?.plan.corridors.length ?? 0,
      addedSignalLength: bestCandidate.score.addedSignalLength,
      addedPowerLength: bestCandidate.score.addedPowerLength,
      powerBendCount: bestCandidate.score.powerBendCount,
    }
    this.output.setPowerSignalCoRoutingSummary(summary)
    this.solved = true
    this.updateStats(applied ? "applied" : "kept_signal_first")
  }

  private updateStats(action: string, activePlan?: PowerSignalReservationPlan) {
    this.stats = {
      action,
      status: this.solved ? "completed" : "searching",
      generatedPlans: this.reservationPlans.length,
      attemptedPlans: this.trialCursor,
      verifiedPlans: this.verifiedTrials.length,
      activeCorridors: activePlan?.corridors.length ?? 0,
      activeAffectedSignals: activePlan?.affectedSignalNames.length ?? 0,
      bestReroutedSignals:
        this.verifiedTrials.length > 0
          ? Math.min(
              ...this.verifiedTrials.map((trial) => trial.routeChanges.length),
            )
          : null,
      failures: this.failures.slice(-4),
    }
  }

  computeProgress() {
    if (this.solved) return 1
    return this.trialCursor / Math.max(1, this.reservationPlans.length)
  }

  override getOutput(): IncrementalReferenceFanoutSession {
    if (!this.solved) {
      throw new Error(
        "ResolvePowerSignalConflictsSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    const context = this.output.getVisualizationContext()
    return visualizeModel({
      model: context.model,
      freeCells: context.freeCells,
      rankedNets: context.model.nets,
    })
  }
}
