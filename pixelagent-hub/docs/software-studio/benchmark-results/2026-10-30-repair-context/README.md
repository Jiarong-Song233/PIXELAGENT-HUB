# Does the Coder repair better if it sees the page? — 2026-10-30

No. An offline paired A/B on 38 failing apps found no difference.

## Why it was worth testing

Across the saved benchmark records, the Coder's repair round was tried 144 times:

| Outcome | Runs |
| --- | ---: |
| Every check passed afterwards | 25 |
| More checks passed | 7 |
| **Same score** | **106** |
| Fewer checks passed | 6 |

In the 106 unchanged runs, 168 of the 178 still-failing checks observed exactly the same value after the repair as before it. The repair rarely changed the failing behaviour at all.

The repair notes give the Coder each failing check's selector, actions, expected value and observed value. They do not show the page the check was looking at. For example, a check could report that "Solved!" never appeared, without showing the grid behind it.

## Setup

- **The capture:** the in-page runner now records the page's markup when a check fails: the body's HTML without scripts or styles, at most 1500 characters.
- **The two arms:** `browserFailureNotes(..., { pages: true })` adds that markup for up to three failures.
- **The harness:** `npm run repair:replay` ([`scripts/replay-repair.ts`](../../../../scripts/replay-repair.ts)) does the following for each saved record whose checks still fail under the current runner:
  1. Rebuild the app and run its own check plan in the real in-page runner.
  2. Repair the same failing app twice from the same failures: arm **base** gets the pipeline's notes, arm **page** also gets the markup. Arm order alternates by case.
  3. Rebuild and recheck both repairs.
- **The cases:** the first 40 failing records in path order, all built by `deepseek-chat` (37 from [held-out sets](../2026-10-21-holdout/README.md), 3 from the [strategy rerun](../2026-10-21-strategy/README.md)). Every failing check in them had markup captured.
- **The repairs:** `gemini-3.8-flash-low` through the owner's Antigravity login (`npm run agy:chat`), with no API cost and one repair per arm per case.

## Result

38 cases are usable in both arms. In the other two, the page arm's reply was malformed JSON in one and a 290-second timeout in the other.

| | Base | + page markup |
| --- | ---: | ---: |
| **Every check passing after the repair** | **19** | **19** |
| More checks passing than before | 21 | 22 |
| Fixed in this arm only | 2 | 2 |
| More checks than the other arm | 2 | 3 |

Every number is per case, in [`report.json`](report.json).

So the markup is not used in the pipeline: it adds prompt tokens and did not change the outcome. The runner still captures it, and the option and the harness stay for later repair experiments.

## A side observation, not a result

A single Gemini repair fully fixed 19 of these 38 DeepSeek-built failing apps. The historical in-pipeline rescue rate was 25 of 144. The two are not comparable:
- the models differ;
- these cases are the ones still failing under today's runner;
- here the repair started from the final saved build, not the first.

It does suggest that a stronger repair model, rather than more context, is the lever worth measuring next.
