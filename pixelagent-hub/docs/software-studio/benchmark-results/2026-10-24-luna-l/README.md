# Held-out sets K and L on `gpt-6-luna` — 2026-10-23 to 10-29

All runs use `gpt-6-luna` through the ChatGPT subscription (`npm run codex:chat`). There is no API cost.

## Set K: where the current pipeline stands

[`2026-10-23-luna-k/`](../2026-10-23-luna-k/): held-out set K ([`config/live-holdout-k-cases.json`](../../../../config/live-holdout-k-cases.json), pre-registered in commit `83c551f`), 3 runs per idea, on `main` at `6012e2a`.

**Result: 18/24 strict, 22/24 full.** Three causes recur, and all three are general:

| Cause | Run | What happened |
| --- | --- | --- |
| `input` refused contenteditable | sticky notes 2 | The notes are edited in place, so the check that edits a note had to be dropped. |
| 8 actions per check were too few | spelling bee 2 | Spelling six words in a row needs more than 8 actions. |
| The benchmark's browser inherited this machine's locale | savings goal 3 | The app's `Intl` currency read "US$0.00" where the check expected "$0.00". |

The rest are the usual Tester mistakes, plus one idea that a check cannot reach within 8 s of waiting: a 30-second whack-a-mole round.

## The changes (commit `1de8909`)

- `input` works on contenteditable elements. Both runners replace the text and fire `input`, `change` and `blur`. On the server, Playwright's `fill()` left the old markup in place, so it now does exactly what the in-page runner does.
- A check may have 16 actions instead of 8.
- The server runner, the benchmark and the offline replay create their browsers with `locale: 'en-US'` and `timezoneId: 'UTC'`.

The offline replay (`npm run checks:replay`, 849 records) reports 820 identical verdicts, 37 checks moving from failed to passed, and 4 moving from passed to failed:
- 2 are dice rolls;
- 2 are checks that had expected the "US$" this machine's locale used to produce.

## Set L: A/B, baseline (`6012e2a`) vs the changes

Held-out set L ([`config/live-holdout-l-cases.json`](../../../../config/live-holdout-l-cases.json), pre-registered in commit `1499c19`): 3 runs per idea, interleaved run by run with `--arms "dist=…;dist=…"`.

The run had to be restarted twice:
- first, a `codex` call hung and blocked the shim's queue;
- then, a slow forward hit Node's 300-second fetch headers timeout.

Both are fixed. The shim kills a Codex process tree after 240 s, and a failed forward now fails that call instead of the whole benchmark. The records are split across three folders:

| Folder | Ideas used |
| --- | --- |
| [`2026-10-24-luna-l/`](.) | the first five ideas |
| [`2026-10-24-luna-l-part2/`](../2026-10-24-luna-l-part2/) | alarm, bus seats |
| [`2026-10-24-luna-l-part3/`](../2026-10-24-luna-l-part3/) | chess clock, tagged notes |

Every idea was rerun in full in the later folder. The partial runs it replaced are excluded.

| | Baseline | Changes |
| --- | ---: | ---: |
| **Strict pass** | 17/24 | **22/24** |
| Pairs won | 1 | 6 |
| First check run all green | 10 | 11 |
| Coder repairs | 9 | 3 |
| Tokens (incl. Codex's own prompt) | 2.30 M | 2.09 M |

The exact two-sided sign test on the 7 discordant pairs gives p = 0.125.

The direct effect is clear on the idea built around contenteditable: **inline editor 0/3 → 3/3**. The baseline's checks there could not type into the fields at all.

The other differences are smaller:
- number grid 2/3 → 3/3;
- alarm list 2/3 → 3/3;
- chess clock 2/3 → 2/3, with one pair each way.

Tagged notes failed once in each arm.

**Reading it.** The changes remove failures the old check language could not avoid, and on these ideas they never cost a pass. They also cut Coder repairs by two-thirds. With 24 pairs the overall gain is not statistically established; the per-cause effect is.
