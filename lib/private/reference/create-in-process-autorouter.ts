import type {
  AutorouterCompleteEvent,
  AutorouterErrorEvent,
  AutorouterProgressEvent,
  GenericLocalAutorouter,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/core"

export type InProcessAutorouterResult = {
  traces: SimplifiedPcbTrace[]
  outputSimpleRouteJson: SimpleRouteJson
}

export type InProcessAutorouterSolve = (
  input: SimpleRouteJson,
  reportProgress: (event: AutorouterProgressEvent) => void,
) => InProcessAutorouterResult

type ListenerMap = {
  complete: Array<(event: AutorouterCompleteEvent) => void>
  error: Array<(event: AutorouterErrorEvent) => void>
  progress: Array<(event: AutorouterProgressEvent) => void>
}

/**
 * Adapts a synchronous, project-local geometry solver to Core's local
 * autorouter lifecycle. The 0hmx reference algorithm is synchronous, so its
 * eventual port only needs to return traces plus the transformed fanout SRJ.
 */
export class InProcessAutorouter implements GenericLocalAutorouter {
  isRouting = false

  private stopped = false
  private outputSimpleRouteJson?: SimpleRouteJson
  private readonly listeners: ListenerMap = {
    complete: [],
    error: [],
    progress: [],
  }

  constructor(
    public readonly input: SimpleRouteJson,
    private readonly solve: InProcessAutorouterSolve,
  ) {}

  start(): void {
    if (this.isRouting) {
      throw new Error("AM62L in-process autorouter is already running")
    }

    this.isRouting = true
    this.stopped = false
    queueMicrotask(() => {
      if (this.stopped) return

      try {
        const result = this.solve(this.input, (event) => {
          for (const listener of this.listeners.progress) listener(event)
        })
        this.outputSimpleRouteJson = result.outputSimpleRouteJson
        this.isRouting = false
        for (const listener of this.listeners.complete) {
          listener({ type: "complete", traces: result.traces })
        }
      } catch (error) {
        this.isRouting = false
        const normalizedError =
          error instanceof Error ? error : new Error(String(error))
        for (const listener of this.listeners.error) {
          listener({ type: "error", error: normalizedError })
        }
      }
    })
  }

  stop(): void {
    this.stopped = true
    this.isRouting = false
  }

  on(
    event: "complete",
    callback: (event: AutorouterCompleteEvent) => void,
  ): void
  on(event: "error", callback: (event: AutorouterErrorEvent) => void): void
  on(
    event: "progress",
    callback: (event: AutorouterProgressEvent) => void,
  ): void
  on(
    event: keyof ListenerMap,
    callback:
      | ((event: AutorouterCompleteEvent) => void)
      | ((event: AutorouterErrorEvent) => void)
      | ((event: AutorouterProgressEvent) => void),
  ): void {
    this.listeners[event].push(callback as never)
  }

  solveSync(): SimplifiedPcbTrace[] {
    const result = this.solve(this.input, (event) => {
      for (const listener of this.listeners.progress) listener(event)
    })
    this.outputSimpleRouteJson = result.outputSimpleRouteJson
    return result.traces
  }

  getOutputSimpleRouteJson(): SimpleRouteJson | undefined {
    return this.outputSimpleRouteJson
  }
}
