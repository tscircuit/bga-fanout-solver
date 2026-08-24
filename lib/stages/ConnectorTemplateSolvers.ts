import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  CandidateFanoutRoute,
  ConnectorTemplate,
  InnerConnectorTemplatePlan,
  ScoredInnerConnectorTemplatePlan,
  ScoredTopConnectorTemplatePlan,
  TopConnectorTemplatePlan,
  ViaFirstFanoutPlan,
  ViaFirstRouteCandidate,
} from "../model/types"
import {
  collectRouteViolations,
  getOctilinearTemplates,
  getPathLength,
  scoreViolations,
} from "../routing/routeGeometry"
import { visualizeViaFirstRoutes } from "../visualize/routeVisuals"

const cloneRoutes = (routes: readonly CandidateFanoutRoute[]) =>
  routes.map((route) => ({
    ...route,
    via: { ...route.via },
    topPath: route.topPath.map((point) => ({ ...point })),
    innerPath: route.innerPath.map((point) => ({ ...point })),
  }))

const compareTemplates = (
  first: ConnectorTemplate,
  second: ConnectorTemplate,
) =>
  (first.violationCount ?? Number.POSITIVE_INFINITY) -
    (second.violationCount ?? Number.POSITIVE_INFINITY) ||
  (first.violationSeverity ?? Number.POSITIVE_INFINITY) -
    (second.violationSeverity ?? Number.POSITIVE_INFINITY) ||
  (first.pathLength ?? Number.POSITIVE_INFINITY) -
    (second.pathLength ?? Number.POSITIVE_INFINITY) ||
  first.id.localeCompare(second.id)

export class EnumerateTopConnectorTemplatesSolver extends BaseSolver {
  private readonly plan: ViaFirstFanoutPlan
  private readonly templates: ConnectorTemplate[] = []
  private netCursor = 0
  private pathCursor = 0
  private activePaths: Array<Array<{ x: number; y: number }>> = []
  private output: TopConnectorTemplatePlan | null = null

  constructor(plan: ViaFirstFanoutPlan) {
    super()
    this.plan = plan
    this.MAX_ITERATIONS = plan.model.nets.length * 20 + 2
  }

  override getConstructorParams() {
    return [this.plan]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const net = this.plan.model.nets[this.netCursor]
    if (!net) {
      this.output = { plan: this.plan, templates: this.templates }
      this.solved = true
      this.updateStats()
      return
    }
    const assignment = this.plan.viaAssignments.find(
      (item) => item.connectionName === net.connectionName,
    )
    if (!assignment) {
      throw new Error(
        `[enumerate_top_templates/${net.connectionName}] missing via assignment`,
      )
    }
    if (this.activePaths.length === 0) {
      const pitch = this.plan.model.pitchY
      this.activePaths = getOctilinearTemplates(net.source, assignment.via, [
        net.source.y - pitch,
        net.source.y - pitch / 2,
        net.source.y + pitch / 2,
        net.source.y + pitch,
        assignment.via.y,
      ])
      this.pathCursor = 0
      this.updateStats()
      return
    }
    const path = this.activePaths[this.pathCursor]
    if (path) {
      this.templates.push({
        id: `top:${net.connectionName}:${this.pathCursor}`,
        connectionName: net.connectionName,
        leg: "top",
        path,
      })
      this.pathCursor++
      this.updateStats()
      return
    }
    this.activePaths = []
    this.netCursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "enumerateTopConnectorTemplates",
      enumeratedTemplates: this.templates.length,
      completedConnections: this.netCursor,
      totalConnections: this.plan.model.nets.length,
      activeConnection: this.plan.model.nets[this.netCursor]?.connectionName,
      activeTemplate: this.activePaths[this.pathCursor]
        ? this.pathCursor
        : null,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.netCursor / Math.max(1, this.plan.model.nets.length)
  }

  override getOutput(): TopConnectorTemplatePlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "EnumerateTopConnectorTemplatesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    const activeConnectionName =
      this.plan.model.nets[this.netCursor]?.connectionName
    return visualizeViaFirstRoutes({
      model: this.plan.model,
      corridors: this.plan.viaCorridors,
      viaLines: this.plan.viaLines,
      assignments: this.plan.viaAssignments,
      templates: this.templates,
      activeConnectionName,
      stage: "enumerate ball→via templates",
      progress: this.computeProgress(),
      counts: `${this.templates.length} candidates`,
    })
  }
}

export class ScoreTopConnectorTemplatesSolver extends BaseSolver {
  private readonly input: TopConnectorTemplatePlan
  private readonly templates: ConnectorTemplate[]
  private readonly baselineRoutes: CandidateFanoutRoute[]
  private cursor = 0
  private output: ScoredTopConnectorTemplatePlan | null = null

  constructor(input: TopConnectorTemplatePlan) {
    super()
    this.input = input
    const assignmentByName = new Map(
      input.plan.viaAssignments.map((item) => [item.connectionName, item]),
    )
    this.templates = input.templates.map((template) => ({
      ...template,
      path: template.path.map((point) => ({ ...point })),
    }))
    this.baselineRoutes = input.plan.model.nets.map((net) => {
      const assignment = assignmentByName.get(net.connectionName)!
      return {
        net,
        via: { ...assignment.via },
        viaLineId: assignment.viaLineId,
        slotIndex: assignment.slotIndex,
        topPath:
          this.templates.find(
            (template) => template.connectionName === net.connectionName,
          )?.path ?? [],
        innerPath: [],
      }
    })
    this.MAX_ITERATIONS = this.templates.length + 2
  }

  override getConstructorParams() {
    return [this.input]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const template = this.templates[this.cursor]
    if (!template) {
      this.output = { plan: this.input.plan, templates: this.templates }
      this.solved = true
      this.updateStats()
      return
    }
    const trialRoutes = cloneRoutes(this.baselineRoutes)
    const trial = trialRoutes.find(
      (route) => route.net.connectionName === template.connectionName,
    )!
    trial.topPath = template.path
    const violations = collectRouteViolations(
      this.input.plan.model,
      trialRoutes,
    ).filter(
      (violation) =>
        violation.layer === "top" &&
        violation.connectionNames.includes(template.connectionName),
    )
    const score = scoreViolations(violations)
    template.violationCount = score.count
    template.violationSeverity = score.severity
    template.pathLength = getPathLength(template.path)
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "scoreTopConnectorTemplates",
      scoredTemplates: this.cursor,
      totalTemplates: this.templates.length,
      activeTemplate: this.templates[this.cursor]?.id ?? null,
      activeConnection: this.templates[this.cursor]?.connectionName ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.templates.length)
  }

  override getOutput(): ScoredTopConnectorTemplatePlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "ScoreTopConnectorTemplatesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.input.plan.model,
      corridors: this.input.plan.viaCorridors,
      viaLines: this.input.plan.viaLines,
      assignments: this.input.plan.viaAssignments,
      templates: this.templates,
      activeTemplateId: this.templates[this.cursor]?.id,
      activeConnectionName: this.templates[this.cursor]?.connectionName,
      stage: "score ball→via templates",
      progress: this.computeProgress(),
      counts: `${this.cursor}/${this.templates.length} scored`,
    })
  }
}

export class CommitTopConnectorTemplatesSolver extends BaseSolver {
  private readonly input: ScoredTopConnectorTemplatePlan
  private readonly routes: CandidateFanoutRoute[] = []
  private readonly templates: ConnectorTemplate[]
  private cursor = 0
  private output: ViaFirstRouteCandidate | null = null

  constructor(input: ScoredTopConnectorTemplatePlan) {
    super()
    this.input = input
    this.templates = input.templates.map((template) => ({ ...template }))
    this.MAX_ITERATIONS = input.plan.model.nets.length + 2
  }

  override getConstructorParams() {
    return [this.input]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const net = this.input.plan.model.nets[this.cursor]
    if (!net) {
      this.output = {
        plan: this.input.plan,
        routes: this.routes,
        violations: [],
      }
      this.solved = true
      this.updateStats()
      return
    }
    const assignment = this.input.plan.viaAssignments.find(
      (item) => item.connectionName === net.connectionName,
    )!
    const selected = this.templates
      .filter((template) => template.connectionName === net.connectionName)
      .sort(compareTemplates)[0]
    if (!selected) {
      throw new Error(
        `[commit_top_template/${net.connectionName}] no scored template`,
      )
    }
    selected.selected = true
    this.routes.push({
      net,
      via: { ...assignment.via },
      viaLineId: assignment.viaLineId,
      slotIndex: assignment.slotIndex,
      topPath: selected.path.map((point) => ({ ...point })),
      innerPath: [],
    })
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "commitTopConnectorTemplates",
      committedConnections: this.routes.length,
      totalConnections: this.input.plan.model.nets.length,
      activeConnection: this.input.plan.model.nets[this.cursor]?.connectionName,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.cursor / Math.max(1, this.input.plan.model.nets.length)
  }

  override getOutput(): ViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "CommitTopConnectorTemplatesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.input.plan.model,
      corridors: this.input.plan.viaCorridors,
      viaLines: this.input.plan.viaLines,
      assignments: this.input.plan.viaAssignments,
      routes: this.routes,
      templates: this.templates,
      activeConnectionName:
        this.input.plan.model.nets[this.cursor]?.connectionName,
      stage: "commit ball→via templates",
      progress: this.computeProgress(),
      counts: `${this.routes.length}/${this.input.plan.model.nets.length} committed`,
    })
  }
}

export class EnumerateInnerConnectorTemplatesSolver extends BaseSolver {
  private readonly candidate: ViaFirstRouteCandidate
  private readonly templates: ConnectorTemplate[] = []
  private routeCursor = 0
  private pathCursor = 0
  private activePaths: Array<Array<{ x: number; y: number }>> = []
  private output: InnerConnectorTemplatePlan | null = null

  constructor(candidate: ViaFirstRouteCandidate) {
    super()
    this.candidate = candidate
    this.MAX_ITERATIONS = candidate.routes.length * 20 + 2
  }

  override getConstructorParams() {
    return [this.candidate]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const route = this.candidate.routes[this.routeCursor]
    if (!route) {
      this.output = { candidate: this.candidate, templates: this.templates }
      this.solved = true
      this.updateStats()
      return
    }
    if (this.activePaths.length === 0) {
      const pitch = this.candidate.plan.model.pitchY
      this.activePaths = getOctilinearTemplates(route.via, route.net.target, [
        route.via.y,
        route.net.target.y,
        route.net.target.y - pitch,
        route.net.target.y - pitch / 2,
        route.net.target.y + pitch / 2,
        route.net.target.y + pitch,
      ])
      this.pathCursor = 0
      this.updateStats()
      return
    }
    const path = this.activePaths[this.pathCursor]
    if (path) {
      this.templates.push({
        id: `inner:${route.net.connectionName}:${this.pathCursor}`,
        connectionName: route.net.connectionName,
        leg: "inner",
        path,
      })
      this.pathCursor++
      this.updateStats()
      return
    }
    this.activePaths = []
    this.routeCursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "enumerateInnerConnectorTemplates",
      enumeratedTemplates: this.templates.length,
      completedConnections: this.routeCursor,
      totalConnections: this.candidate.routes.length,
      activeConnection:
        this.candidate.routes[this.routeCursor]?.net.connectionName,
    }
  }

  computeProgress() {
    return this.solved
      ? 1
      : this.routeCursor / Math.max(1, this.candidate.routes.length)
  }

  override getOutput(): InnerConnectorTemplatePlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "EnumerateInnerConnectorTemplatesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.candidate.plan.model,
      assignments: this.candidate.plan.viaAssignments,
      routes: this.candidate.routes,
      templates: this.templates,
      activeConnectionName:
        this.candidate.routes[this.routeCursor]?.net.connectionName,
      stage: "enumerate via→target templates",
      progress: this.computeProgress(),
      counts: `${this.templates.length} candidates`,
    })
  }
}

export class ScoreInnerConnectorTemplatesSolver extends BaseSolver {
  private readonly input: InnerConnectorTemplatePlan
  private readonly templates: ConnectorTemplate[]
  private readonly baselineRoutes: CandidateFanoutRoute[]
  private cursor = 0
  private output: ScoredInnerConnectorTemplatePlan | null = null

  constructor(input: InnerConnectorTemplatePlan) {
    super()
    this.input = input
    this.templates = input.templates.map((template) => ({ ...template }))
    this.baselineRoutes = cloneRoutes(input.candidate.routes)
    for (const route of this.baselineRoutes) {
      route.innerPath =
        this.templates.find(
          (template) => template.connectionName === route.net.connectionName,
        )?.path ?? []
    }
    this.MAX_ITERATIONS = this.templates.length + 2
  }

  override getConstructorParams() {
    return [this.input]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const template = this.templates[this.cursor]
    if (!template) {
      this.output = {
        candidate: this.input.candidate,
        templates: this.templates,
      }
      this.solved = true
      this.updateStats()
      return
    }
    const trialRoutes = cloneRoutes(this.baselineRoutes)
    const route = trialRoutes.find(
      (item) => item.net.connectionName === template.connectionName,
    )!
    route.innerPath = template.path
    const violations = collectRouteViolations(
      this.input.candidate.plan.model,
      trialRoutes,
    ).filter(
      (violation) =>
        violation.layer === route.net.selectedLayer &&
        violation.connectionNames.includes(template.connectionName),
    )
    const score = scoreViolations(violations)
    template.violationCount = score.count
    template.violationSeverity = score.severity
    template.pathLength = getPathLength(template.path)
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "scoreInnerConnectorTemplates",
      scoredTemplates: this.cursor,
      totalTemplates: this.templates.length,
      activeTemplate: this.templates[this.cursor]?.id ?? null,
      activeConnection: this.templates[this.cursor]?.connectionName ?? null,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.templates.length)
  }

  override getOutput(): ScoredInnerConnectorTemplatePlan {
    if (!this.solved || !this.output) {
      throw new Error(
        "ScoreInnerConnectorTemplatesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.input.candidate.plan.model,
      assignments: this.input.candidate.plan.viaAssignments,
      routes: this.baselineRoutes,
      templates: this.templates,
      activeTemplateId: this.templates[this.cursor]?.id,
      activeConnectionName: this.templates[this.cursor]?.connectionName,
      stage: "score via→target templates",
      progress: this.computeProgress(),
      counts: `${this.cursor}/${this.templates.length} scored`,
    })
  }
}

export class CommitInnerConnectorTemplatesSolver extends BaseSolver {
  private readonly input: ScoredInnerConnectorTemplatePlan
  private readonly routes: CandidateFanoutRoute[]
  private readonly templates: ConnectorTemplate[]
  private cursor = 0
  private output: ViaFirstRouteCandidate | null = null

  constructor(input: ScoredInnerConnectorTemplatePlan) {
    super()
    this.input = input
    this.routes = cloneRoutes(input.candidate.routes)
    this.templates = input.templates.map((template) => ({ ...template }))
    this.MAX_ITERATIONS = this.routes.length + 2
  }

  override getConstructorParams() {
    return [this.input]
  }

  override _setup() {
    this.updateStats()
  }

  override _step() {
    const route = this.routes[this.cursor]
    if (!route) {
      const violations = collectRouteViolations(
        this.input.candidate.plan.model,
        this.routes,
      )
      this.output = {
        ...this.input.candidate,
        routes: this.routes,
        violations,
      }
      this.solved = true
      this.updateStats()
      return
    }
    const selected = this.templates
      .filter(
        (template) => template.connectionName === route.net.connectionName,
      )
      .sort(compareTemplates)[0]
    if (!selected) {
      throw new Error(
        `[commit_inner_template/${route.net.connectionName}] no scored template`,
      )
    }
    selected.selected = true
    route.innerPath = selected.path.map((point) => ({ ...point }))
    this.cursor++
    this.updateStats()
  }

  private updateStats() {
    this.stats = {
      phase: "commitInnerConnectorTemplates",
      committedConnections: this.cursor,
      totalConnections: this.routes.length,
      activeConnection: this.routes[this.cursor]?.net.connectionName,
    }
  }

  computeProgress() {
    return this.solved ? 1 : this.cursor / Math.max(1, this.routes.length)
  }

  override getOutput(): ViaFirstRouteCandidate {
    if (!this.solved || !this.output) {
      throw new Error(
        "CommitInnerConnectorTemplatesSolver output requested before completion",
      )
    }
    return this.output
  }

  override visualize(): GraphicsObject {
    return visualizeViaFirstRoutes({
      model: this.input.candidate.plan.model,
      assignments: this.input.candidate.plan.viaAssignments,
      routes: this.routes,
      templates: this.templates,
      activeConnectionName: this.routes[this.cursor]?.net.connectionName,
      stage: "commit via→target templates",
      progress: this.computeProgress(),
      counts: `${this.cursor}/${this.routes.length} committed`,
    })
  }
}
