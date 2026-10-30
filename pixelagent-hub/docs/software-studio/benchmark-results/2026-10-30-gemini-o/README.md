# Held-out set O: v2.9.0 on `gemini-3.8-flash` — 2026-10-30

All runs use `gemini-3.8-flash-low` through the owner's Antigravity login (`npm run agy:chat`, a local shim on `localhost`). There is no API cost. The shim is for these benchmarks only; the public demo never uses it.

## Setup

- Build: the released v2.9.0 code (`main` after the v2.9.0 release; only the README changed since `1782019`). It includes the virtual clock, the JSON-key repair and color equality.
- Held-out set O ([`config/live-holdout-o-cases.json`](../../../../config/live-holdout-o-cases.json), pre-registered in commit `79689f7`): 8 new ideas, 3 runs each, one arm. Three of the ideas are timers: a lap timer, a 3-minute candle and a workout timer with work and rest phases.

## Result: 23/24 strict, and the one failure is a real app bug

| | |
| --- | ---: |
| Runs where the plan ran | **24/24** |
| **Strict pass** (every check passing, none dropped) | **23/24** |
| First check run all green | 22 |
| Checks dropped | 0 |

The JSON repair worked: no run was lost.

The virtual clock was used: the candle runs advanced the clock 6 to 8 times each, and two of the three checked "Burnt out" by advancing 3 minutes.

### The failure: mini sudoku, run 2

The check filled every empty cell and expected "Solved!". The banner never appeared, and the Coder's repair round did not fix it.

The check was right: **the app's built-in puzzle has no solution.**

```
1 . | . 4
. 2 | 3 .
----+----
. 3 | 2 .
2 . | . 1
```

- The third row needs a 1 or a 4 in its first cell.
- That column already holds 1 and 2, and the second row is forced to put its 4 there.
- So no fill of the grid is valid, and "Solved!" can never appear.

The check caught a bug that a person playing the app would hit, and it did not blame a correct app.

## Caveats

This is one model, one build and 24 runs. It is not an A/B: it shows where the released pipeline stands on unseen ideas, not what any single change contributed. For comparison, the earlier clean held-out sets under `deepseek-chat` reached about 13/16 to 14/16 strict ([details](../2026-10-21-holdout/README.md)). Those used a different model and an older pipeline, so the two numbers are not directly comparable.
