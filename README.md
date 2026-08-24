# @tscircuit/bga-fanout-solver

An incremental `SimpleRouteJson` solver for routing one rectangular-lattice BGA
from top-layer pads to already-selected breakout targets on prescribed layers.
It produces pad dogbones, through vias, and straight/45-degree routes ending at
the exact supplied targets.

The package intentionally does not choose breakout points and does not route
the channel between components. Two debugger fixtures independently solve the
AM62L SoC BGA and LPDDR4 RAM BGA fanouts using fixed targets captured from the
validated circuit.

A third debugger fixture, `Full AM62L SoC — failing repro`, is deliberately
not a success example. It preserves the simplified computer's complete SoC pin
intent on the validated 373-ball land geometry, preloads the released TI ground
escape, and reproduces the current power-first width failure. Its plane and
local-rail data use a fixture-only contract; they do not expand the package's
stable fixed-target API.

The `simplified-am62l-ddr-{soc,ram}-repro.srj.json` fixtures are byte-for-byte
JSON serializations of the raw `SimpleRouteJson` arguments passed to each
breakout `algorithmFn` by the Core correction in
[`tscircuit/core#3389`](https://github.com/tscircuit/core/pull/3389), commit
`1a914b60`. They were captured from the latest merged
`@tsci/0hmX.simplified-am62l-computer@1.0.15` `index.circuit.tsx` at PR #6
merge commit `8063a9a`. No adapter or solver transformation runs before
capture. The importer validates their hash and parsed shape, then writes the
original captured byte buffers unchanged rather than reserializing them.

Each input retains all 988 obstacles: 986 pre-existing non-pour obstacles plus
two aligned inner-layer GND pours. The SoC capture is byte-identical to the
prior correct 988-obstacle fixture. The RAM capture retains byte-for-byte
equivalent non-pour and non-obstacle content while moving only its two pours
from the SoC bounds to the RAM breakout bounds. Both retain the original
8-layer rules, 33 fixed-target connections, three ordered DDR buses, target
layers, and zero traces. The SoC call naturally fails while routing top-layer
dogbones. A diagnostic zero-trace continuation after that failure allows Core
to construct the otherwise unreachable raw RAM call; its monolithic
compatibility step remains a bounded stall. Neither fixture is derived from
`ddr-only.circuit.tsx`, minimized, or reduced to a single BGA.

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
import { FixedTargetBgaFanoutSolver } from "@tscircuit/bga-fanout-solver"

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

The package remains private and unpublished during extraction. The repository
has no npm publishing workflow or runtime network integration.

The committed SRJs are solver inputs, not Circuit JSON compilation products.
Their source artifacts, deterministic transforms, hashes, and normalized parity
goldens are recorded in `fixtures/provenance.json`. The full-SoC problem carries
its own typed terminal inventory and provenance alongside its embedded SRJ.
Coordinates are consumed at the unchanged solver's established 1e-6 mm
canonical precision.
