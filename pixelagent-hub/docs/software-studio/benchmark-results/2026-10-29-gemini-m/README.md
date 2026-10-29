# Held-out set M on `gemini-3.8-flash` — 2026-10-29

All runs use `gemini-3.8-flash-low` through the owner's Antigravity login (`npm run agy:chat`, a local shim on `localhost`). There is no API cost. The shim is for these benchmarks only; the public demo never uses it.

## What was measured

The virtual clock (commit `d854fe1`): a check may `advance` the app's clock by up to 60 minutes, so a 25-minute timer can be checked in milliseconds instead of being waited for (`wait` stays capped at 8 s).

Held-out set M ([`config/live-holdout-m-cases.json`](../../../../config/live-holdout-m-cases.json), pre-registered in commit `a28bb09`):
- four ideas need long durations (a 60-second quiz, a 2-minute plant, a 45-second auction, a 4–6 minute tea timer);
- four do not, to show the clock leaves other apps alone.

3 runs per idea, interleaved run by run with `--arms "dist=…;dist=…"`:
- [`dist-baseline/`](dist-baseline/): `main` at `1de8909`;
- [`dist-new/`](dist-new/): the same plus the virtual clock.

## Result: no difference, and half the pairs were lost

| | Baseline | Virtual clock |
| --- | ---: | ---: |
| Pairs usable in both arms | 13/24 | 13/24 |
| **Strict pass (usable pairs)** | 13/13 | 13/13 |
| First check run all green | 12 | 13 |
| Coder repairs | 1 | 0 |
| Tokens | 0.60 M | 0.58 M |

The clock arm used `advance` in 45 of its 147 checks, so the Tester did pick it up. On these pairs it did not change a verdict: both arms passed every usable pair.

11 pairs were not usable: in one arm or the other the Tester's plan never ran. One was the shim stopping a 240-second Gemini call. Most of the other ten were **malformed JSON**: Gemini dropped the opening quote of a key, typically right after an empty array:

```
"actions":[],selector":"#count"
```

## The fix this led to (commit `f52c176`)

`parseModelObject` now retries once with such keys quoted after `JSON.parse` fails. Valid JSON and any other error are unchanged. On the 181 raw Gemini replies saved during this run (`--dump`), 44 did not parse; the repair recovers 41 of them.

Because these failures shaped the fix, set M is no longer held out for it. The clock is measured again, with the repair in both arms, on a fresh set: [`2026-10-30-gemini-n/`](../2026-10-30-gemini-n/).
