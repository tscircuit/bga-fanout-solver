# Fixed-target BGA fanout solver

- Use Bun exclusively.
- The public solver begins at the `SimpleRouteJson` boundary. Do not compile
  Circuit JSON or calculate breakout-point positions in this repository.
- Every connection has one BGA source pad and one fixed breakout target.
- Preserve `bus.connectionNames` order; it is semantic.
- Keep the SoC and RAM fixtures independent and deterministic.
- Solvers fail loudly on invalid state. Never report a partial fanout as solved.
- Override `_step()`, not `step()` or `solve()`.
- Keep React imports out of `lib/` except type-free visualization data.
- Use one test case per test file.
- Do not add arbitrary-direction, blind-via, middle-channel, or whole-board
  routing behavior without an explicit design decision.
