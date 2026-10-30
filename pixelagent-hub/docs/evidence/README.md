# 证据索引 · Evidence index

仓库里大部分文件是实验证据：真实模型生成的源码 ZIP、事件日志、检查计划、浏览器报告和截图。它们都保存在原位，以免破坏已有链接和 `npm run portfolio:demo -- --check` 的哈希校验。本页是唯一入口，按"先看哪个"排序。

## 实验（真实模型：`deepseek-chat`、`deepseek-v4-pro`、`gpt-6-luna`、`gemini-3.8-flash`）

| 日期 | 实验 | 一句话结论 |
| --- | --- | --- |
| 2026-10-30 | [让 Coder 看到失败时的页面](../software-studio/benchmark-results/2026-10-30-repair-context/README.md) | 历史上 144 次返修里有 106 次分数纹丝不动。离线配对 A/B：同样 38 个失败的应用，返修时附上检查失败那一刻的页面 HTML，完全修好 19 个，不附也是 19 个，没有提升，因此流程里不加 |
| 2026-10-30 | [v2.9.0 在留出集 O 上（Gemini）](../software-studio/benchmark-results/2026-10-30-gemini-o/README.md) | 8 个新想法 × 3 次：24 次全部可用，严格通过 23/24。唯一的失败是真实的应用 bug：内置的 4×4 数独题无解，“Solved!” 永远不会出现，检查没有冤枉正确的应用 |
| 2026-10-29 | [虚拟时钟（留出集 M、N，Gemini）](../software-studio/benchmark-results/2026-10-30-gemini-n/README.md) | 检查可以把应用的时钟快进最多 60 分钟。通过率不变（20/21 对 20/21），但检查能到达以前到不了的结束状态：煮蛋计时器的“完成”状态 3/3 次被检查，基线 0/3。顺带修好了 Gemini 丢引号的 JSON，可用对数从 13/24 升到 21/24 |
| 2026-10-23 | [留出集 K、L（gpt-6-luna）](../software-studio/benchmark-results/2026-10-24-luna-l/README.md) | contenteditable 输入、每个检查 16 个动作、浏览器固定 en-US/UTC：严格通过 22/24 对 17/24（p = 0.125）；内联编辑器从 0/3 到 3/3 |
| 2026-10-22 | [返修不再交付更差的应用](../software-studio/benchmark-results/2026-10-22-keep-better/README.md) | 返修后通过的检查变少、或运行时错误变多时，退回返修前的版本。用全部保存记录统计：122 次带返修的运行里，有 6 次会因此改发更好的那一版 |
| 2026-10-21 | [trace 在 gpt-6-luna 上复测](../software-studio/benchmark-results/2026-10-21-trace-luna/README.md) | 40 对交替运行，不花 API 费用：加 trace 31/40，基线 32/40，没有提升；每个计划的检查数还少了 21%，已撤回 |
| 2026-10-21 | [离线检查重放](../software-studio/benchmark-results/2026-10-21-replay/README.md) | 不调用模型，用当前检查执行器重放 742 条历史记录：97% 判定不变；38 条检查由败转胜（正是这期间的修复）；唯一一条由胜转败是抛硬币式的随机检查，不算回归 |
| 2026-10-21 | [trace 初步 A/B（DeepSeek）](../software-studio/benchmark-results/2026-10-21-trace/README.md) | 余额耗尽前只完成 10 对，8/10 对 5/10；后来在 luna 上没有复现 |
| 2026-10-21 | [规划 Agent 复测](../software-studio/benchmark-results/2026-10-21-strategy/README.md) | 用当前流程重比：先规划 28/31，直接写码 29/31，仍然没有可测提升；在 688 次运行里，复查救回了 44% 的首轮失败，而 Coder 返修只救回了它尝试次数的 17% |
| 2026-10-21 | [推理模型做 Tester](../software-studio/benchmark-results/2026-10-21-tester-model/README.md) | 只给 Tester 换上 deepseek-v4-pro：20/24 对 22/24，没有更好，用时是 3.4 倍 |
| 2026-10-21 | [留出想法测试](../software-studio/benchmark-results/2026-10-21-holdout/README.md) | 每一轮都在 8 个预先提交、从不用于调优的新想法上评分；干净集合上的严格通过从 10/16 稳定到约 13/16 |
| 2026-10-20 | [PLAY LIVE 第 6–7 轮](../software-studio/benchmark-results/2026-10-20-live/README.md) | 固定用例首次 15/15；新增 `changed`/`unchanged`、`matches`、`nth` 断言 |
| 2026-10-18 | [PLAY LIVE 基准](../software-studio/benchmark-results/2026-10-18-live/README.md) | 5 个固定用例 × 3 次，在构建好的静态站点里用 deepseek-chat 跑：完整通过 8/15 → 11/15 → 14/15；6 个较难想法从 7/18 提高到 17/18。几乎所有失败都来自 Tester 写的检查，而不是应用本身 |
| 2026-10-18 | [真实模型展示](../software-studio/benchmark-results/2026-10-18-showcase/README.md) | 6 个创意共 10 次尝试，5 个最终全部检查通过；像素宠物三次都没生成出来（Coder 超时），番茄钟第 1 次失败是 Tester 计划写错 |
| 2026-10-15 | [单 Agent vs 多 Agent 重复对比](../software-studio/benchmark-results/2026-10-15-repeated/README.md) | 5 个应用 × 2 种策略 × 3 次，共 30 次生成。先规划再写码 13/15 完整通过，直接写码 12/15，没有可测优势 |
| 2026-10-09 | [首次浏览器评测](../software-studio/benchmark-results/2026-10-09/README.md) | 10 次生成全部首次编译通过，浏览器检查 6 过 4 败；其中 2 次失败是构建器缺陷（`defer` 顺序），已修复 |
| 2026-10-09 | [测验应用的修订检查](../software-studio/benchmark-results/2026-10-09-quiz-disabled/README.md) | 同两个测验应用换用新的固定计划复测，没有新生成，也没有调用模型 |
| 2026-10-09 | [受控故障返修](../software-studio/benchmark-results/2026-10-09-real-repair/README.md) | 把计数器改成 `+= 2`，浏览器检查发现故障，失败证据交回 Coder 返修 |
| 2026-10-09 | [带源码上下文的返修复测](../software-studio/benchmark-results/2026-10-09-real-repair-source-context/README.md) | 返修只改 1 行，其余文件逐字节不变；原计划 4/4、额外 7/7 通过 |

方法说明：[benchmark.md](../software-studio/benchmark.md)。不花钱的回归检查用 `npm run checks:replay`；不花 API 费用的真实运行，用 `npm run codex:chat` 加 `benchmark-live.ts --base-url`。固定用例：[`config/studio-benchmark.json`](../../config/studio-benchmark.json)。

## 功能验证记录

- 浏览器验收：[browser-verification.md](../software-studio/browser-verification.md) · [browser-verification-evidence.md](../software-studio/browser-verification-evidence.md) · [browser-repair-evidence.md](../software-studio/browser-repair-evidence.md)
- 真实运行：[software-live-verification.md](../software-studio/software-live-verification.md) · [console-live-verification.md](../software-studio/console-live-verification.md)
- 修改、重试与恢复：[modification-verification.md](../software-studio/modification-verification.md) · [manual-retry-verification.md](../software-studio/manual-retry-verification.md) · [recovery.md](../software-studio/recovery.md)
- 数据来源说明：[data-provenance.md](../software-studio/data-provenance.md)

## 文章

- [我让 4 个 AI Agent 分工写代码，测了 30 次，结果并不比 1 个强](../articles/multi-agent-not-better.zh-CN.md)
- [发布文案草稿（Show HN / Reddit / V2EX）](../articles/launch-posts.md)

## 截图

界面截图在仓库根目录的 [`portfolio-screenshots/`](../../../portfolio-screenshots/)，文件名带拍摄日期。`studio-demo.gif` 是 README 顶部那张动图，从静态回放录制而成。
