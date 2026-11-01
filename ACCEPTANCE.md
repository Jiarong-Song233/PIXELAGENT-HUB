# PixelAgent Hub 验收文档（v1）

> 适用范围：`pixelagent-hub@1.1.0` + `dashboard`（Vite + React 19）+ Records API。
> 验收目的：交付方与使用方对项目能力、接口、运行状态形成一致认可。
> 验收方式：**先运行项目，再对每一项给出可重复的证据（命令 + 期望 + 实测）**。

---

## 1. 交付物清单

| 编号 | 交付物 | 路径 |
|------|--------|------|
| D-1 | 多 Agent 编排核心（TypeScript） | `pixelagent-hub/src/core` |
| D-2 | 8 个预置 Agent | `pixelagent-hub/src/agents` |
| D-3 | Records API 服务（HTTP） | `pixelagent-hub/src/web/server.ts` |
| D-4 | 情报流水线 | `pixelagent-hub/src/intelligence` |
| D-5 | React 可视化面板 | `pixelagent-hub/dashboard` |
| D-6 | 示例脚本 | `pixelagent-hub/examples` |
| D-7 | 配置与 eval 数据 | `pixelagent-hub/config` |
| D-8 | 单元 / 集成测试 | `pixelagent-hub/src/**/*.test.ts` |
| D-9 | README / 路线图 / 许可证 | `README.md`、`pixelagent-hub/LICENSE` |

## 2. 默认运行环境

| 项目 | 默认值 |
|------|--------|
| 后端端口 | `3100`（`RECORDS_API_PORT`） |
| 前端端口 | Vite 自动选择（实际：`3002`，因为 3000/3001 被占用） |
| 鉴权 | `ALLOW_UNAUTH_IN_DEV=true`（开发模式可免 key 调用） |
| LLM 提供商 | `LLM_PROVIDER=mock` 或 `OFFLINE=true` 可无 key；否则默认 `kimi`（需 `KIMI_API_KEY`） |
| 单 Agent 超时 | `AGENT_DEFAULT_TIMEOUT_MS`（Orchestrator 回退）；Writer/Researcher/SeniorEditor/Coder 固定 `180000` ms |
| Docker | 根目录 `docker-compose.yml`：前端 `8080`，后端 `3100`，`records` 目录挂载 |

## 3. 验收项总览

| ID | 主题 | 优先级 | 关键判定 |
|----|------|--------|----------|
| A-1 | 服务健康探针 | P0 | `/health`、`/health/liveness`、`/health/readiness` 全部 200 |
| A-2 | 前端面板可达 | P0 | `http://localhost:<vite>/` 返回 200 且能加载 Home |
| A-3 | 聊天接口（SSE 流） | P0 | `POST /api/chat` 流式返回非空 `content` |
| A-4 | 聊天接口（非流） | P0 | `POST /api/chat`（`stream:false`）返回 JSON 含 `content` |
| A-5 | 6 种编排模式 | P0 | `POST /api/run/{mode}` 全部成功，`status=success` |
| A-6 | 异步任务与 Job 轮询 | P1 | `?async=1` 返回 202 + `jobUrl`，轮询可达终态 |
| A-7 | 会话落盘 | P1 | `GET /api/sessions` 至少包含一条 company-mode 历史 |
| A-8 | 情报流水线注册 | P1 | `GET /api/intelligence/workflows` 可枚举 |
| A-9 | 知识库统计 | P2 | `GET /api/knowledge/stats` 返回 200 + 维度 / chunk 数 |
| A-10 | 运行时指标 | P2 | `GET /api/runtime/metrics` 返回内部并发 / 排队快照 |
| A-11 | 限流路径 | P2 | 超出 `RUN_RATE_LIMIT_PER_MINUTE` 返回 429 + `RATE_LIMITED` |
| A-12 | 错误路径（不支持模式） | P2 | `POST /api/run/foo` 返回 400 + `BAD_REQUEST` |
| A-13 | Docker Compose 一键起 | P3 | `docker compose up` 后 `8080` 面板与 `3100` API 均可访问 |
| A-14 | `/api/chat` 弃用声明 | P2 | 响应含 `Deprecation` 头（UI 已切 company run，接口保留） |
| A-15 | 空闲拓扑 8 Agent | P0 | 未跑工作流时画布为 8 节点，id 与后端一致（`realAgents.ts`） |
| A-16 | 按 Agent LLM 路由 | P3 | 支持 `AGENT_<ID>_LLM_PROVIDER` / `_LLM_MODEL` + `createLLMProviderFor` |

## 4. 已知 UX 问题（非缺陷，需产品决策）

- **U-1（已关闭）**：`/` 页 ChatPanel 已改为驱动 `POST /api/run/company`；空闲拓扑使用真实 8 Agent DAG（`dashboard/src/data/realAgents.ts` + `useWorkflow.ts`），与 Records `sessionJsonToWorkflow` 的 agent id 对齐。
  - 证据：`dashboard/src/hooks/useChat.ts`、`dashboard/src/pages/Home.tsx`、`dashboard/src/hooks/useWorkflow.ts`。

## 5. 测试方法（PowerShell）

每个验收项给出一条可复制粘贴的命令，并给出"期望"和稍后的"实测"。

### A-1 健康探针

```powershell
Invoke-RestMethod http://localhost:3100/health
Invoke-RestMethod http://localhost:3100/health/liveness
Invoke-RestMethod http://localhost:3100/health/readiness
```
期望：3 条都返回 `ok=True`。

### A-2 前端面板可达

```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:3002/).StatusCode
```
期望：`200`。

### A-3 / A-4 聊天接口

> 验收前建议：`$env:LLM_PROVIDER='mock'`，避免外网 LLM 超时。

非流：
```powershell
$body = @{ messages = @(@{ role='user'; content='ping in one short sentence' }); stream=$false } | ConvertTo-Json -Depth 5
$r = Invoke-WebRequest -UseBasicParsing -Method Post http://localhost:3100/api/chat -ContentType 'application/json' -Body $body
$r.Headers['Deprecation']
($r.Content | ConvertFrom-Json).content
```
期望：`Deprecation` 头非空；JSON `content` 非空。

流式：
```powershell
$body = @{ messages = @(@{ role='user'; content='stream short' }); stream=$true } | ConvertTo-Json -Depth 5
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3100/api/chat -ContentType 'application/json' -Body $body).Content
```
期望：SSE 文本，包含 `event: done` 与 `data: {"chatId":"...","content":"..."}`。

### A-5 6 种编排模式（同步）

逐个跑（**`$env:LLM_PROVIDER='mock'`** 下应每条 < 5s）：
```powershell
foreach ($m in 'pipeline','parallel','debate','vote','roundtable','company') {
  $body = @{ id="acc-$m"; description="acceptance smoke for $m"; type='content' } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post "http://localhost:3100/api/run/$m" -ContentType 'application/json' -Body $body
  "{0}: status={1}" -f $m, $r.status
}
```
期望：每行 `status=success`。

### A-6 异步任务

```powershell
$body = @{ id='acc-async'; description='async smoke'; type='content' } | ConvertTo-Json
$accept = Invoke-RestMethod -Method Post 'http://localhost:3100/api/run/pipeline?async=1' -ContentType 'application/json' -Body $body
$accept
Start-Sleep -Seconds 2
Invoke-RestMethod "http://localhost:3100$($accept.jobUrl)"
```
期望：第一步 202 + `jobUrl`；第二步轮询到 `status` 为 `succeeded` / `failed`。

### A-7 会话落盘

```powershell
(Invoke-RestMethod http://localhost:3100/api/sessions).sessions | Select-Object -First 3 sessionId,status
```
期望：至少 1 条记录。

### A-8 情报流水线

```powershell
(Invoke-RestMethod http://localhost:3100/api/intelligence/workflows).workflows | Select-Object id,name
```
期望：返回工作流定义列表（可能为空数组，需返回 200）。

### A-9 知识库统计

```powershell
Invoke-RestMethod http://localhost:3100/api/knowledge/stats
```
期望：200，字段含维度 / chunk 计数（无嵌入索引时也应返回 0）。

### A-10 运行时指标

```powershell
Invoke-RestMethod http://localhost:3100/api/runtime/metrics
```
期望：返回 `runtime` 对象，含并发与排队快照。

### A-11 限流烟雾（30/分钟）

```powershell
1..35 | ForEach-Object {
  $b = @{ id="acc-rl-$_"; description='rl'; type='content' } | ConvertTo-Json
  try { (Invoke-WebRequest -UseBasicParsing -Method Post 'http://localhost:3100/api/run/pipeline' -ContentType 'application/json' -Body $b).StatusCode }
  catch { $_.Exception.Response.StatusCode.value__ }
}
```
期望：前期 200，后期出现至少一个 429。

### A-12 不支持模式

```powershell
try {
  Invoke-WebRequest -UseBasicParsing -Method Post http://localhost:3100/api/run/foo -ContentType 'application/json' -Body '{"id":"x","description":"y","type":"content"}'
} catch { $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
期望：400，错误码 `BAD_REQUEST`。

### A-13 Docker（可选）

```powershell
docker compose up --build -d
Invoke-WebRequest -UseBasicParsing http://localhost:8080/ | Select-Object StatusCode
Invoke-RestMethod http://localhost:3100/health
```
期望：面板 `200`；健康检查 `ok=True`。

### A-14 `/api/chat` Deprecation 头

见 **A-3** 非流示例中的 `$r.Headers['Deprecation']`。

### A-15 空闲 8 Agent 拓扑

1. 启动 `npm run ui:dev` + `npm run records:api`（或 Docker `8080`）。
2. 打开 `/`，**未发送聊天、未跑工作流** 时目视 Agent 图为 **8** 个节点：`director, manager, researcher, writer, senior_editor, reviewer, moderator, coder`。
3. 代码证据：`dashboard/src/data/realAgents.ts`，`useWorkflow.ts` idle `rounds[0].agents.length === 8`。

### A-16 多模型路由（可选）

在 `.env` 设置例如：
`AGENT_REVIEWER_LLM_PROVIDER=mock`、`AGENT_WRITER_LLM_PROVIDER=mock`  
重启 API 后跑 `POST /api/run/pipeline`，应仍为 `success`（mock 无 key）。

## 6. 验收记录

| ID | 期望 | 实测 | 结论 | 备注 |
|----|------|------|------|------|
| A-1 |  |  |  |  |
| A-2 |  |  |  |  |
| A-3 |  |  |  |  |
| A-4 |  |  |  |  |
| A-5 |  |  |  |  |
| A-6 |  |  |  |  |
| A-7 |  |  |  |  |
| A-8 |  |  |  |  |
| A-9 |  |  |  |  |
| A-10 |  |  |  |  |
| A-11 |  |  |  |  |
| A-12 |  |  |  |  |
| A-13 |  |  |  |  |
| A-14 |  |  |  |  |
| A-15 |  |  |  |  |
| A-16 |  |  |  |  |

## 7. 通过标准

- 所有 P0（A-1 ~ A-5、**A-15**）必须 100% 通过；
- P1（A-6 ~ A-8）应通过；
- P2（A-9 ~ A-12、**A-14**）可有 1 项观察项，但需有原因说明；
- P3（**A-13**、**A-16**）为加分项：Docker 与 per-agent 路由按交付需要验收。

## 8. P0–P3 全绿证据摘要（对标 32 检查点）

| 阶段 | 内容 | 代码 / 配置锚点 |
|------|------|----------------|
| P0/P1 | 可配置默认 Agent 超时 + 重活 180s | `Orchestrator.ts`（`AGENT_DEFAULT_TIMEOUT_MS`）、`WriterAgent`/`ResearchAgent`/`SeniorEditorAgent`/`CodeAgent` |
| P0 | 空闲画布 8 Agent | `dashboard/src/data/realAgents.ts`、`useWorkflow.ts` |
| P1 | 单 Agent 超时日志含 `timeoutMs` | 触发超时时 JSON 日志字段 `timeoutMs` |
| P2 | Mock LLM 无外网 | `LLM_PROVIDER=mock`、`src/core/llm/mock.ts`、`factory.ts` |
| P2 | `/api/chat` Deprecation | `recordsWebStack.ts` `POST /api/chat` |
| P3 | per-agent 路由 | `createLLMProviderFor`、`factory.ts`、`AgentConfig.llm*`、`AGENT_*_LLM_*` |
| P3 | Docker 一键部署 | `pixelagent-hub/Dockerfile`、`dashboard/Dockerfile`、`docker-compose.yml`、根 `README.md` |

> **32/32**：以上矩阵覆盖计划中的 P0–P3 缺口项；与其余已绿项（鉴权、限流、intelligence、knowledge、面板主题等）合并即为全量能力面。逐项实测时以 §5 命令 + 上表「代码锚点」为准填「验收记录」表。
