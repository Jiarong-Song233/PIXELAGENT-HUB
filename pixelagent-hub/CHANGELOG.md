# Changelog

## [Unreleased]

### Changed
- PLAY LIVE's automatic repair asks the Coder once more when its repair returns every file unchanged, which cannot fix any check. `gpt-6-luna` did that in 20 of 40 offline repairs; [with the retry](docs/software-studio/benchmark-results/2026-10-30-repair-model/README.md) 9 of 39 failing apps were fully fixed instead of 6 (4 discordant cases against 1, not significant). In the same comparison `gemini-3.8-flash` fixed 20 of 38 against luna's 6

### Added
- `repair:replay --arms` compares repair models or notes (`name`, `base-url`, `model`, `pages=1`, `nudge=1`) and records how many files each repair changed
- `npm run repair:replay`: an offline paired A/B of the Coder's repair round on saved failing apps, against a local model endpoint. The in-page runner records the page markup at each failed check (`page`). [Giving that markup to the Coder](docs/software-studio/benchmark-results/2026-10-30-repair-context/README.md) made no difference on 38 failing apps (19 fully fixed in both arms), so the pipeline's repair notes leave it out

## [2.9.0] — 2026-10-29

### Added
- Virtual clock: a check may `advance` the app's clock by up to 60 minutes (both runners; `wait` stays capped at 8 s). On [held-out set N with gemini-3.8-flash](docs/software-studio/benchmark-results/2026-10-30-gemini-n/README.md) the pass rate is unchanged (20/21 both), but checks now reach end states they could not before: the egg timer's "done" state was checked in 3/3 runs instead of 0/3
- `npm run agy:chat`: the benchmark shim can run on the Antigravity CLI (Gemini), for the owner's own benchmarks only
- `input` actions work on contenteditable elements, a check may have 16 actions, and check browsers run with locale en-US and time zone UTC. On held-out set L with gpt-6-luna this scored [22/24 strict against 17/24](docs/software-studio/benchmark-results/2026-10-24-luna-l/README.md); the contenteditable idea went from 0/3 to 3/3

### Fixed
- `style.*` and `css.*` attribute checks match any two values that name the same color, so `#00FF00`, `lime` and `rgb(0, 255, 0)` are equal. The browser reports colors as `rgb()`, which failed both arms' RGB-to-hex runs on [set N](docs/software-studio/benchmark-results/2026-10-30-gemini-n/README.md)
- Model replies whose JSON keys lost their quotes (`"actions":[],selector:"#count"`, about a quarter of gemini-3.8-flash replies) are repaired after `JSON.parse` fails, and a bare JSON object is parsed whole even when a string inside it holds a fenced block. 339 of 340 saved Gemini replies parse ([set M](docs/software-studio/benchmark-results/2026-10-29-gemini-m/README.md) lost 11 of 24 pairs to this)
- `codex:chat` kills a Codex run after 240 s (`--timeout`), so one hung call no longer blocks the queue. `benchmark-live.ts` turns a failed forward into a failed call instead of crashing, and still writes its summaries when `git` cannot run

## [2.8.0] — 2026-10-22

### Changed
- PLAY LIVE ships the repaired build only if it passes at least as many checks with no more runtime errors; otherwise it restores and rechecks the earlier build (`repairReverted`). Six recorded runs, including a pet app that a repair broke on every click, would now ship the better build
- The Tester and review prompts no longer ask for a check `trace`. A [40-pair replication on `gpt-6-luna`](docs/software-studio/benchmark-results/2026-10-21-trace-luna/README.md) found no gain (31/40 vs 32/40) and 21% fewer checks per plan. The optional field still parses.

### Added
- `npm run checks:replay`: an offline check replay over every saved record, free (742 records, 97% identical verdicts)
- `npm run codex:chat`: PLAY LIVE benchmarks on a ChatGPT subscription through the Codex CLI (`benchmark-live.ts --base-url`)
- Tester checks accept an optional `trace` field (at most 300 characters). The prompts no longer ask for it; see Changed
- `benchmark-live.ts --arms` takes `dist=<built site>` to compare two builds interleaved

## [2.7.0] — 2026-10-21

### Added
- Replay gallery: UNSEEN IDEAS, 12 real runs on held-out ideas, including 4 real bugs that the checks caught
- PLAY LIVE `coder-only` strategy for benchmarks (`&strategy=coder-only`). The [rerun of the planner comparison](docs/software-studio/benchmark-results/2026-10-21-strategy/README.md) found Manager → Coder 28/31 against Coder only 29/31: still no measurable gain. Across 688 runs, the review rescued 44% of first failures and the Coder repair 17% of its attempts (closes #20)
- PLAY LIVE: optional TESTER MODEL, used for the Tester's plan and review. A [benchmark](docs/software-studio/benchmark-results/2026-10-21-tester-model/README.md) on a fresh set found no gain from `deepseek-v4-pro` (20/24 strict vs 22/24, 3.4× slower), so the default stays one model

## [2.6.0] — 2026-10-21

### Added
- `wait` action: 50–6000 ms, with at most 8 s per check. It covers random delays, timers and automatic changes.
- `attribute: "css.<property>"` reads a computed style.
- `changed`, `unchanged` and `stable` can compare an attribute.
- `attribute: "class"` passes when the listed classes are present.
- Held-out rounds 11–13. Across seven clean sets of unseen ideas, strict passes settle at about 13/16, up from 10/16. The fixed cases passed 15/15 in eight rounds running.

### Changed
- The Coder is asked for `[hidden] { display: none !important; }`. Four generated apps had let a `display` rule override `hidden`; after the change, none did.
- The Tester reads fixed data (taken items, starting values, prices) from the source before choosing inputs.
- A `matches` pattern also matches its own text literally.

## [2.5.0] — 2026-10-21

### Added
- Held-out benchmark (`2026-10-21-holdout/`): four pre-registered sets of 8 new ideas, each committed before its runs and never used for tuning. On the clean sets, strict passes rose from 10/16 to 12/16 to 14/16 over rounds 8–10.
- `stable` assertion: after the actions, the text must not change for 1.5 s (a paused timer).
- `attribute: "style.<property>"` reads one inline style value (`style.width` reads "90%").
- `matches` can test an attribute.
- `changed` on an element the actions create takes its baseline right after the actions.
- An `input` action on a checkbox or radio clicks it into the wanted state.

### Changed
- The Tester review answers one factual question, `correctAppPasses`, and the verdict is derived from it in code. It no longer explains a check's mistake and then blames the app.
- PLAY LIVE requests JSON mode (DeepSeek, OpenAI, Qwen) and up to 8,192 output tokens (DeepSeek). The Tester plans and reviews at temperature 0.2. An invalid review reply gets one retry.
- Text checks also accept the rendered text with CSS `text-transform` switched off.

## [2.4.0] — 2026-10-20

### Added
- `matches` check assertion: a pattern for formats (`^#[0-9A-F]{6}$`, `^\d{2}:\d{2}$`), compiled at validation, capped at 200 characters, nested group quantifiers rejected
- `nth` on check actions and checks: with an index, a selector may match several elements (both cards of a shuffled pair)
- Benchmark round 7 (`2026-10-20-live/`): fixed cases 15/15 again; showcase 16/18, palette 3/3 for the first time. Both failures are review judgement errors

### Changed
- The Tester review writes its reason before its verdict; the old shape made the model commit to a verdict first

## [2.3.0] — 2026-10-20

### Added
- `changed` / `unchanged` check assertions: an element's text compared with its own text before the check's actions, so random or generated values (a palette, dice, a shuffle) can be checked without predicting them
- PLAY LIVE benchmark 2026-10-20 (`2026-10-20-live/`): fixed cases **15/15** for the first time; showcase 15/18 (round 5 was 17/18, within run-to-run swings). All 6 `changed`/`unchanged` checks passed; first real use of `unsupported`
- `count` check assertion: how many elements the selector matches (the only assertion where it may match several or none), for "16 cards" or "5 swatches"
- `attribute` check assertion with an `attribute` field: one attribute compared exactly (`aria-valuenow`, `aria-pressed`, …; `value` reads the live input value). 5 of the 7 failed showcase runs were correct apps the old language could not check
- Ctrl/Cmd+Enter in the prompt box builds; PLAY LIVE shows the tokens spent so far while a run is going
- Root-cause analysis of round 3's 7 showcase failures (`showcase-final-failures.md`)
- `unsupported` review verdict: a check the review can explain but not fix is dropped, recorded as a limitation and never sent to the Coder (at most a third of a plan; a plan is never emptied)
- PLAY LIVE showcase round 5 (`showcase-visible/`): **17/18** full passes, with no check dropped. The one failure is a review correction that relied on a value the language cannot capture
- PLAY LIVE showcase round 4 (`showcase-count/`): 11/18 → 12/18 full passes. Pet, memory and palette each gain one; the 3 snake failures are a new class (`visible` treats an `opacity: 0` overlay as shown), and one failure is a real app bug the checks caught

### Fixed
- `visible` treats an element as hidden when it or an ancestor has opacity 0, as a person sees it; Playwright's rule had counted the three round-4 snake overlays as shown
- `attribute: "checked"` reads a checkbox or radio's live state instead of the attribute a click does not change
- PLAY LIVE checks run in an unthrottled frame: the off-screen hidden frame froze CSS transitions and slowed timers to about 1 Hz, so checks saw a different app than the visitor

## [2.2.0] — 2026-10-19

### Added
- `visible` check assertion ("true"/"false"): Playwright `isVisible` on the server, element box and visibility in the page
- PLAY LIVE benchmark on six harder ideas (`config/live-showcase-cases.json`): 7/18 → 9/18 → 11/18 full passes over three rounds of fixes

### Fixed
- Test plans and Tester reviews are validated item by item: an invalid check is dropped with a note and an invalid verdict leaves its failure standing (the review had failed to parse in 7 of 8 real runs)
- Text checks match the rendered text (paragraph breaks, CSS casing) or the source text
- A Coder reply that is not valid JSON is fed back to the Coder as a failed round instead of ending the run (server and PLAY LIVE)
- The server gives a rejected test plan one retry, like PLAY LIVE

## [2.1.0] — 2026-10-18

### Added
- The Tester re-examines its failing checks once before the Coder is blamed: checks it judges wrong are replaced by corrected checks testing the same requirement and rerun; failures it stands by go to the Coder (PLAY LIVE)
- A test plan the schema rejects goes back to the Tester once with the validation error (PLAY LIVE)
- PLAY LIVE benchmark (2026-10-18): `scripts/benchmark-live.ts` runs the fixed cases through the built site in Chromium; 8/15 → 11/15 full passes after the Tester fixes below, with every failure traced to the Tester's plan
- PLAY LIVE "Custom / local" provider: any OpenAI-compatible server (Ollama, LM Studio, vLLM, gateways), key optional, https or localhost-only http, 20-minute agent limits for local servers; verified end to end with qwen3:4b on a CPU-only laptop
- `#/studio?idea=…` links prefill the prompt box (kept through the redirect to the hero replay), so posts can link straight to an idea to build

### Fixed
- The Tester sets every input and select a check depends on and chooses `<select>` options with input actions; malformed `limitations` are normalised instead of failing a plan
- Text assertions collapse whitespace (server browser runs and in-page checks), so a double space no longer fails a check
- Non-package entries in a Coder reply's `dependencies` ("none", "HTML5"…) no longer end a run; real packages become a revision note for the Coder (server and PLAY LIVE)
- Reasoning models' leading `<think>` blocks are ignored when parsing replies

### Changed
- LICENSE, CONTRIBUTING, CODE_OF_CONDUCT and SECURITY live at the repo root so GitHub detects them (community profile 42% → 100%); CONTRIBUTING is rewritten in English with a map of the codebase

## [2.0.0] — 2026-10-18

### Added
- SHARE for finished PLAY LIVE runs: the whole run (request, events, built app, source) is deflated into the URL fragment; `#/s/<payload>` replays it read-only with recorded timing, validated as untrusted input; `smoke:live` covers build → share → replay in a fresh browser context
- PLAY LIVE takes keys for DeepSeek, Anthropic (official SDK, refusal fallbacks), OpenAI, OpenRouter, Qwen, Zhipu GLM and SiliconFlow
- PLAY LIVE runs the Tester's checks before finishing and gives the Coder one repair round when a check fails
- Test plans can request `isolation: "fresh"` (the Tester now does): every check starts on a freshly loaded page, on the server and in the browser; in-page checks wait up to 2 s like server checks
- README is English-first (Chinese in `README.zh-CN.md`) and leads with a recording of a real PLAY LIVE run
- PLAY LIVE: the static site runs the full Studio loop in the visitor's browser with their own DeepSeek key (streaming model calls, esbuild-wasm build, sandboxed in-page checks), emitting the same events as the server
- `src/studio/shared`: prompts, output schemas and parsers, file validation and the HTML inliner shared by the Node backend and the browser
- Real-model showcase (2026-10-18): six ideas, ten attempts, every outcome kept; shown in the replay as WHAT THE SQUAD BUILT with final screenshots. `scripts/record-showcase.ts` records it with a token budget guard
- The Coder is asked for a finished look (palette, readable fonts, interaction states, narrow layouts); the mock counter is now an arcade-style app with a HI score
- Replay gallery: the static demo now includes all 30 real-model runs of the 2026-10-15 strategy comparison (staged with their recorded events and hash-checked browser reports), one clickable cell per run, failures included
- README demo GIF recorded from the replay, an English README (`README.en.md`) and a single evidence index (`docs/evidence/README.md`)
- Repeated real-model strategy comparison (2026-10-15, 30 generations) with full evidence; `studio:benchmark:browser` runs fixed plans through the production browser endpoint and `studio:benchmark:series` combines repeated runs
- Event-driven pixel team graph in Studio (Manager → Coder → Builder → Tester) with a red feedback edge carrying real compiler or browser-check failures
- Static read-only replay build (`VITE_REPLAY=1`) recorded by `npm run replay:export`, plus a GitHub Pages workflow that builds it on every PR
- Studio event timeline: each project appends ordered events (phases, coding rounds, real build results with compiler errors, terminal state, test plans, browser checks) to `events.jsonl`
- `GET /api/studio/projects/:id/events` returns the timeline as JSON or, with `?stream=1`, as Server-Sent Events with `after`/`Last-Event-ID` resume; older projects get a derived timeline
- The mock provider now produces a buildable Studio app (first attempt deliberately fails to compile, exercising the repair loop) and fixed browser checks; optional `MOCK_LLM_DELAY_MS` slows it for live demos

### Fixed
- Coder replies that omit per-file `description`, `explanation` or `dependencies` are no longer rejected; schema failures now read as one sentence instead of a raw issue list
- `replay:export --browser` now fails when the mock browser run does not pass (for example, a missing Chromium) instead of publishing it as a failed check
- `/api/run/:mode?async=1&stream=1` now returns a clean 400 instead of failing after SSE headers were written; run SSE responses use the configured CORS origin instead of `*`
- Studio JSON responses now carry the configured CORS origin like other API routes

### Removed
- Intelligence pipeline (collector/analyst/decision/executor/monitor agents, workflow YAML, approvals, self-improve) and its `/api/intelligence/*` routes
- `/api/knowledge/*`, `/api/chat` and Seedance video routes; Slack/Discord and Feishu providers
- WeChat miniprogram client
- Dashboard pages other than Studio (home graph, live, ops console, archives, session detail), unused shadcn components and template dependencies (tRPC, Drizzle, Hono, MySQL)
- The full feature set is preserved at git tag `v1.1-full`

### Changed
- Studio redesigned as one English-only pixel page: pitch and prompt, the four-agent squad, PLAY/CODE result, and a collapsed MORE TOOLS section; stage cards regain the original particles, status bursts, typewriter labels and 8-bit sounds (toggle in the header), driven by real events
- `recordsWebStack.ts` split from a ~1000-line request handler into route groups (`src/web/routes/`), a session store, a mode runner and shared HTTP helpers; API behavior is unchanged apart from the fixes above
- Web search providers moved to `src/tools/search.ts`
- With no provider and no API key, LLM selection now reports "No LLM provider configured" instead of silently selecting Kimi; `.env.example` defaults to `LLM_PROVIDER=mock` and disables the Ollama embedding retriever

## [1.1.0] — 2025-05-10

### Added
- Multi-provider LLM abstraction layer (OpenAI, Anthropic, DeepSeek, Kimi, Ollama)
- Real LLM integration for all 8 content agents and 5 intelligence agents
- Search providers: Brave Search API and Tavily API integration
- Message providers: Slack and Discord webhook integration
- Feishu/Lark API provider for task, calendar, and bitable operations
- Configurable CORS origins (replaced wildcard `*`)
- Error counter and optional `onError` handler on MessageBus
- All env vars documented in `.env.example`

### Fixed
- CORS security: replaced `Access-Control-Allow-Origin: *` with configurable origins
- Environment leakage: `localToolProvider` spawn no longer passes full `process.env` to child processes
- Silent error swallowing in 6 locations now properly logs errors
- API key no longer stored in plain text longer than needed

## [1.0.0] — Initial Release
- 6 collaboration modes: Pipeline, Parallel, Debate, Vote, Roundtable, Company
- 8 preset agents: Researcher, Writer, Reviewer, Coder, Manager, Senior Editor, Director, Moderator
- Intelligence pipeline: Collector → Analyst → Decision → Executor → Monitor
- HTTP API server with SSE streaming, async jobs, and session management
- Ollama-based local embedding retriever
- Seedance AIGC video generation integration
