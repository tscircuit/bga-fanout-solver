# @tscircuit/fixed-target-bga-fanout-solver

An incremental `SimpleRouteJson` solver for routing one rectangular-lattice BGA
from top-layer pads to already-selected breakout targets on prescribed layers.
It produces pad dogbones, through vias, and straight/45-degree routes ending at
the exact supplied targets.

The package intentionally does not choose breakout points and does not route
the channel between components. Its two debugger fixtures independently solve
the AM62L SoC BGA and LPDDR4 RAM BGA fanouts using fixed targets captured from
the validated circuit.

## Supported problem shape

- one dominant rectangular-lattice BGA source component;
- exactly two points per connection;
- horizontal left or right escape, normalized by mirroring;
- fixed target position and layer per connection;
- top-to-bottom through vias;
- ordered buses and 2-3-via residual strings.

Arbitrary fanout directions, multiple source BGAs, blind or buried vias, and
whole-board routing are not claimed.

## Usage

```ts
import { FixedTargetBgaFanoutSolver } from "@tscircuit/fixed-target-bga-fanout-solver"

const solver = new FixedTargetBgaFanoutSolver(simpleRouteJson)
solver.solve()

if (solver.failed) throw new Error(solver.error ?? "Fanout failed")
const { traces, outputSimpleRouteJson } = solver.getOutput()
```

`step()` advances one meaningful unit in the active stage. `solve()` runs the
same pipeline to completion. `visualize()` returns `graphics-debug` geometry
for React Cosmos and other solver debuggers.

## Extraction status

SRJ-to-model conversion is a pure synchronous setup operation and is not shown
as a solver stage. The debugger pipeline starts with incremental free-space
region construction, followed by incremental source ranking and the private
compatibility route stage. The proven top/inner routing search remains in that
single compatibility stage so this extraction preserves exact geometry while
its mutually-dependent search phases are separated. It is not exported.

The visible pipeline is:

1. `findFreeSpace`
2. `rankFanoutNets`
3. `compatibilityRoute`

## Development

```sh
bun install
bun run typecheck
bun test --timeout 9999999
bun run build:site
```

The repository is private and local during extraction. It has no publishing
workflow or runtime network integration.

The committed SRJs are solver inputs, not Circuit JSON compilation products.
Their source artifacts, deterministic transforms, hashes, and normalized parity
goldens are recorded in `fixtures/provenance.json`. Coordinates are consumed at
the unchanged solver's established 1e-6 mm canonical precision.
