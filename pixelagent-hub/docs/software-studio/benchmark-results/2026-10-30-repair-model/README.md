# Which model repairs, and the repair that changes nothing — 2026-10-30

Two offline paired A/Bs with `npm run repair:replay`, on the same 40 failing apps as the [page-markup test](../2026-10-30-repair-context/README.md). The apps are the first 40 records, in path order, whose checks still fail under today's runner. All were built by `deepseek-chat`, 37 of them on the [held-out sets](../2026-10-21-holdout/README.md).

Each app is repaired once per arm from the same failures and notes, then rebuilt and rechecked with its own check plan. Both models run through the owner's subscriptions on local shims (`npm run agy:chat`, `npm run codex:chat`), at no API cost.

## 1. Gemini against gpt-6-luna

[`gemini-vs-luna.json`](gemini-vs-luna.json). 38 cases are usable in both arms. Gemini lost two: one timeout and one reply with a raw control character in a string.

| | `gemini-3.8-flash-low` | `gpt-6-luna` |
| --- | ---: | ---: |
| **Every check passing after the repair** | **20** | 6 |
| Fixed by this model only | 15 | 1 |
| More checks than the other model | 16 | 5 |
| Score unchanged by the repair | 14 | 29 |

Gemini's result is stable. Its earlier run on the same apps (the page-markup test's base arm) gave the same fixed or not-fixed verdict on 32 of 36 apps.

Luna is not stable. A rerun of 8 of these apps fully fixed 3 where the first run fixed none, and one app went from 3/9 to 9/9.

## 2. Luna's repairs often change nothing

The harness now records how many files a repair actually changed. In the second A/B ([`luna-nudge.json`](luna-nudge.json)), **luna returned every file unchanged in 20 of its 40 repairs**. A repair like that cannot change a check.

So arm **nudge** checks for this: when a repair returns every file unchanged, it asks once more, with the same notes plus one sentence saying that nothing changed (`UNCHANGED_REPAIR_NOTE`).

| 39 usable cases, both arms `gpt-6-luna` | Plain | Nudge |
| --- | ---: | ---: |
| **Every check passing after the repair** | 6 | **9** |
| Fixed in this arm only | 1 | 4 |
| Repairs that changed nothing | 19 | 9 (after the retry) |
| Retried | — | 20, of which 4 then passed every check |

That is 4 discordant cases against 1. An exact sign test gives p ≈ 0.38, so this is **suggestive, not significant**.

## What changed

- **PLAY LIVE's automatic repair** now treats a reply that returns every file unchanged like an unusable reply. It records a failed round with `UNCHANGED_REPAIR_NOTE` and asks once more, within the existing round budget. The retry costs a call only when the round would otherwise be wasted. The keep-the-better-build rule still applies afterwards, so it cannot make the shipped app worse.
- **The server's repair**, started by a person from saved diagnostics, is unchanged. There, a repair that changes nothing is still recorded as a successful repair with no changes.
- **`repair:replay`** takes `--arms` with `name`, `base-url`, `model`, `pages=1` and `nudge=1`, and reports `<arm>Changed`.

## What this suggests

The repair model matters far more than the repair context. Page markup changed nothing (19 vs 19), while the model changed the outcome from 6 to 20 fixes. PLAY LIVE uses one model for every role, the visitor's own key, so a separate repair model would only make sense as an option, like the existing TESTER MODEL.
