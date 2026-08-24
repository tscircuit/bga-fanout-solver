import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { FixedTargetBgaFanoutSolver } from "../../lib"
import { offsetGraphicsLayers } from "../../lib/visualize/offsetGraphicsLayers"
import type { FullSocBreakoutProblem } from "./types"
import { visualizeFullSocProblem } from "./visualizeFullSocProblem"

const mergeVisuals = (
  engine: GraphicsObject,
  fixture: GraphicsObject,
): GraphicsObject => ({
  coordinateSystem: "cartesian",
  title: fixture.title,
  points: [...(engine.points ?? []), ...(fixture.points ?? [])],
  rects: [...(fixture.rects ?? []), ...(engine.rects ?? [])],
  lines: [...(fixture.lines ?? []), ...(engine.lines ?? [])],
  circles: [...(engine.circles ?? []), ...(fixture.circles ?? [])],
  arrows: [...(engine.arrows ?? []), ...(fixture.arrows ?? [])],
  texts: [...(engine.texts ?? []), ...(fixture.texts ?? [])],
})

export class FullAm62lSocFailingReproSolver extends BaseSolver {
  private readonly fullSocProblem: FullSocBreakoutProblem
  private readonly layerOffset: number
  readonly engine: FixedTargetBgaFanoutSolver

  constructor(problem: FullSocBreakoutProblem, { layerOffset = 0 } = {}) {
    super()
    const clonedProblem = structuredClone(problem)
    this.fullSocProblem = clonedProblem
    this.layerOffset = layerOffset
    this.engine = new FixedTargetBgaFanoutSolver(clonedProblem.solverInput)
    this.activeSubSolver = this.engine
    this.MAX_ITERATIONS = this.engine.MAX_ITERATIONS + 1
  }

  override _step() {
    this.stats = {
      expected: "known failure",
      connected: this.fullSocProblem.inventory.connectedBalls,
      fixedTargets: this.fullSocProblem.inventory.signals.fixedBoundaryTargets,
      groundVias: this.fullSocProblem.precommittedGroundCopper.vias.length,
      unsupportedPlaneIntents:
        this.fullSocProblem.inventory.roles.powerPlaneTerminals,
    }
    this.engine.step()
    this.progress = this.engine.progress
    if (this.engine.failed) {
      this.failed = true
      this.error = this.engine.error
    } else if (this.engine.solved) {
      this.solved = true
    }
  }

  override getConstructorParams() {
    return [structuredClone(this.fullSocProblem)]
  }

  override getOutput() {
    if (!this.solved) {
      throw new Error("full-SoC repro output requested before completion")
    }
    return this.engine.getOutput()
  }

  getCurrentStageName() {
    return this.engine.getCurrentStageName()
  }

  override visualize(): GraphicsObject {
    return offsetGraphicsLayers(
      mergeVisuals(
        this.engine.visualize(),
        visualizeFullSocProblem(this.fullSocProblem, this.failed),
      ),
      this.fullSocProblem.solverInput.layerCount,
      this.layerOffset,
    )
  }

  override preview(): GraphicsObject {
    return this.visualize()
  }
}
