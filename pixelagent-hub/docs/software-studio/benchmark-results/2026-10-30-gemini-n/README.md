# Held-out set N on `gemini-3.8-flash`: the virtual clock — 2026-10-29

All runs use `gemini-3.8-flash-low` through the owner's Antigravity login (`npm run agy:chat`, a local shim on `localhost`). There is no API cost. The shim is for these benchmarks only; the public demo never uses it.

## Setup

This reruns [set M](../2026-10-29-gemini-m/README.md), whose Gemini JSON failures had shaped the parser repair (`f52c176`), on a fresh set:
- held-out set N ([`config/live-holdout-n-cases.json`](../../../../config/live-holdout-n-cases.json), pre-registered in commit `f4689fd`);
- four ideas need long durations: a parking meter, a 6–10 minute egg timer, an idle miner that earns per second, a 90-second-per-person standup timer;
- four do not.

3 runs per idea, interleaved run by run with `--arms "dist=…;dist=…"`. Both arms include the repair:
- [`dist-baseline/`](dist-baseline/): `main` at `437d554` plus `f52c176`;
- [`dist-new/`](dist-new/): the virtual clock (`d854fe1`) plus `f52c176`.

## Result: same pass rate, more of each app checked

| | Baseline | Virtual clock |
| --- | ---: | ---: |
| Pairs usable in both arms | 21/24 | 21/24 |
| **Strict pass (usable pairs)** | 20/21 | 20/21 |
| Pairs won | 1 | 1 |
| First check run all green | 18 | 19 |
| Coder repairs | 1 | 0 |
| Tokens | 0.89 M | 0.85 M |

The one loss on each side is the RGB-to-hex converter, and both are the same mismatch, unrelated to time: a `style.background-color` check expected `#00FF00`, and the browser reports the style as `rgb(0, 255, 0)`.

The repair did its job: usable pairs rose from 13/24 on set M to 21/24. Of the three lost here:
- one was the shim stopping a 240-second Gemini call;
- two were standup-timer plans with a second variant, both quotes of a key dropped (`],selector:".roster-item"`).

### What the clock changes

Pass rates are equal, but the checks differ. On the four time-based ideas the clock arm used `advance` 41 times and `wait` once; the baseline used `wait` 19 times and never reached a long end state.

| Idea | End state | Baseline checks it | Clock checks it |
| --- | --- | :---: | :---: |
| Egg timer | "Eggs are done!" after 6 minutes | 0/3 runs | **3/3** (advance 360 000 ms) |
| Idle miner | gold after 10+ seconds | 1/3 (a 2.1 s wait) | 2/3 (advance 10 s) |

So the clock does not make more apps pass on this set; it makes the passing apps' checks reach states that a check could not reach before. A wrong countdown end would now be caught; before, it was simply not tested.

## The follow-up fix (commit `2cec6bb`)

- The key repair also handles both quotes dropped, and now fires only right after `{` or the end of a value, so text inside strings such as "Time, left: 5" is not touched.
- A reply that is a bare JSON object is parsed whole. A Coder reply whose README held a ```` ```bash ```` block was being cut at that inner fence.

On all 340 Gemini replies saved across sets M and N, 339 now parse; the last one is truncated. The 258 that parsed before give identical objects.

Set N's two standup failures informed this second fix, so set N is not held out for it.
