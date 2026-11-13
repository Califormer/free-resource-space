# 𝓕𝓻𝓮𝓮 𝓡𝓮𝓼𝓸𝓾𝓻𝓬𝓮 𝓢𝓹𝓪𝓬𝓮（𝓕𝓡𝓢）

羊毛空间 Yangmao Space

> **GLOBAL DEAL HUNTER｜全球羊毛情报中心**——免费额度雷达
>
> 聚合全网免费 AI 额度、试用与云服务情报：可搜索、可筛选、可评分、可核实。
> A free-quota radar that aggregates free AI credits, trials and cloud offers from public sources — searchable, filterable, scored and human-verified.

[English version below](#english)

---

## 中文

### 这是什么

羊毛空间是一个 TypeScript 全栈空间（React 客户端 + 服务端 actions + SQLite/Drizzle），每小时自动刷新一次，从 10 个公开来源抓取真实优惠情报，经过确定性规则过滤、分类、打分、去重后入库展示。

它**不是**爬虫大杂烩，也**不是** AI 生成的榜单：每一条都来自公开页面或公开接口，每一条的时间、来源、核实状态都可追溯。

### 数据快照

导出时刻：2026-11-13T06:13:56Z（UTC）

| 指标 | 数值 |
|---|---|
| 帖子总数 / 上限 | 612 / 700 |
| 未读 | 608 |
| 今日精选 | 102 |
| 已核实 | 464 |

分类（目录帖 552 条）：大模型 API 282、AI 应用试用 181、云服务 1、开发工具 67、免费算力 21。

### 功能

- **三区首页**：今日新上 / 即将到期 / 分类情报。
- **筛选与搜索**：来源 Tab、排序（综合排名 / 按到期时间 / 按综合分）、仅看未读 / 仅看今日精选、分类 chips、标签快筛、关键词搜索（标题 / 摘要 / 厂商），搜索范围可在「目录四站 / 全库」之间切换。
- **七项评分**（仅目录帖）：额度、紧迫性、领取难度、来源可信度由确定性规则算出；风险、实用性、适用人群只由人工核实写入。综合分 = 已评维度均值，未知维度不填 0、不填中值。
- **核实覆盖层**：人工按官方页核实后写入的地区 / 成本 / 风险 / 条件 / 证据链接，卡片优先显示；标题、额度、简介三项也可按官方页覆盖修正。**每小时刷新绝不覆盖核实层**。
- **已读管理**：已读帖子综合排名 −8，服务端持久化。
- **深色主题默认**，手机端 390px 适配，分页每页 50 条。

### 数据来源（10 个）

| 来源 | 抓取方式 |
|---|---|
| 懒猫 AI | `lanmao.ai/feed/zh.json` 公开 feed |
| AIHot Token 羊毛 | `aihot.news/free-tokens` 公开页面内嵌数据 |
| 赛博鸡蛋 | `jidan.si/rss.xml` 公开 RSS |
| 白嫖计 | `baipiaoji.com/limits.json` 公开 JSON |
| V2EX | 官方公开 API（latest + hot） |
| LINUX DO | 公开 `latest.json`（直连被 Cloudflare 拦时标失败，不绕过） |
| NodeSeek | 公开首页（IP 被屏蔽时标失败，不绕过） |
| X | 仅接受 `x.com/<handle>/status/<id>` 链接，时间用 snowflake 推导 |
| Threads | 公开搜索页解析（解析不出就标失败，不编造） |
| Sliverkiss | Telegram 公开频道 `t.me/s/sliverkiss_blog` 预览页 |

### 核心规则

1. **绝不编造**：不写种子、示例、占位数据；抓不到就把来源标失败、保留旧数据，绝不用别的来源顶替。
2. **绝不用抓取时间当发布时间**：每帖分开存 `published_at` / `time_quality` / `fetched_at`。
3. **刷新只用确定性规则代码**，定时任务里绝不调大模型逐条分类或打分。
4. **不登录、不绕过**：所有来源都是公开接口，不需要任何密钥、token 或账号。
5. 词表、阈值、窗口、权重全部集中在 `server/src/config.ts`，规则代码只引用、不硬编码。
6. 目录来源按「对账删除」（列表里消失即删除），论坛来源按 7 天 / 教程 30 天保留窗口；绝对 deadline 已过即下线。

完整口径见 [`DATA-PLAN.md`](DATA-PLAN.md)，规则实现见 `server/src/rules.ts` 与 `server/src/config.ts`。

### 仓库结构

```
client/                 React 客户端（App.tsx 界面与全部交互、theme.css 深/浅双主题）
server/src/             服务端：actions.ts（7 个 action）、refresh.ts（刷新流水线）、
                        rules.ts（过滤/分类/评分规则）、config.ts（全部词表与阈值）、
                        overrides.ts（人工核实回填）、schema.ts（数据模型）
drizzle/                数据库迁移 0001–0006
space.json              空间配置（slug: yang-mao-kong-jian，每小时刷新 cron）
data/                   数据快照：getstate.json（612 条全量）、posts.csv、
                        sources.json、stats.json
羊毛空间-复刻提示词.md    给全新 Muse 的完整复刻提示词（路线 A 原样恢复 / 路线 B 按规格重建）
DATA-PLAN.md            数据源与设计口径记录
AGENTS.md               构建说明
versions.md             v5–v14 版本大事记
```

### 如何复刻 / 部署

**路线 A（推荐，100% 一模一样）**：按 [`羊毛空间-复刻提示词.md`](羊毛空间-复刻提示词.md) 操作——在 Muse 里新建一个 TypeScript 空间，把本仓库的 `client/`、`server/`、`drizzle/`、`space.json`、`package.json`、`bunfig.toml`、`tsconfig.base.json` 按原路径放回，按 `data/getstate.json` 回填数据（唯一键 `(source, external_id)`，保留已读状态与核实覆盖层），确认每小时刷新 cron 已启用。**不需要任何密钥**。

**路线 B（无附件时）**：同一份提示词里有完整规格（§3 过滤、§4 质量分、§5 重点词/网关、分类映射 v2、七项评分、核实覆盖层、界面 v14），按规格重建即可，功能一样。

### 数据说明

`data/` 是 2026-11-13 导出时刻的快照：`getstate.json` 为 getState 全量输出（含 rank/freshness 等计算字段，回填时按 posts 表字段写入、计算字段忽略）；`posts.csv` 为同一份帖子的人可读表格（Excel 可直接打开，UTF-8 BOM），`title_effective` / `summary_effective` / `quota_effective` 是覆盖生效后的值。优惠信息以官方页面实时展示为准，领取前请自行核对。

### 许可

MIT License，见 [LICENSE](LICENSE)。

### 免责声明

本项目聚合的是公开来源的优惠情报，仅供参考；优惠的额度、条件与有效期以各厂商官方页面实时展示为准，与本项目无关。本项目与上述任何来源、厂商均无关联。

---

<a id="english"></a>

## English

### What is this?

Yangmao Space is a TypeScript full-stack space (React client + server actions + SQLite/Drizzle) that refreshes hourly. It fetches real deal posts from 10 public sources, then filters, classifies, scores and dedupes them with deterministic rules before storing them for display.

It is **not** a scrape-everything aggregator, and **not** an AI-generated list: every post comes from a public page or public API, and every post's time, source and verification status are traceable.

### Data snapshot

Exported at 2026-11-13T06:13:56Z (UTC).

| Metric | Value |
|---|---|
| Total posts / cap | 612 / 700 |
| Unread | 608 |
| Today's picks | 102 |
| Verified | 464 |

Categories (552 catalog posts): LLM API 282, AI app trials 181, cloud services 1, dev tools 67, free compute 21.

### Features

- **Three sections on the home page**: New today / Expiring soon / Browse by category.
- **Filters and search**: source tabs, sorting (composite rank / by deadline / by score), unread-only / today's-picks-only switches, category chips, tag quick filters, keyword search (title / summary / vendor), with scope toggle between "catalog four" and "all sources".
- **Seven-dimension scoring** (catalog posts only): quota, urgency, difficulty and credibility are computed by deterministic rules; risk, usefulness and audience are written only by human verification. The composite score is the mean of rated dimensions only — unknown dimensions are never filled with 0 or a median.
- **Verification overlay**: region / cost / risk / conditions / evidence links verified against official pages are shown first on cards; title, quota and summary can also be overridden from official pages. **Hourly refresh never overwrites the verification layer.**
- **Read management**: read posts drop 8 points in composite rank, persisted server-side.
- **Dark theme by default**, mobile-friendly at 390px, 50 posts per page.

### Sources (10)

| Source | Fetch method |
|---|---|
| Lanmao AI | Public feed `lanmao.ai/feed/zh.json` |
| AIHot Token Deals | Embedded data on the public page `aihot.news/free-tokens` |
| Jidan (Cyber Egg) | Public RSS `jidan.si/rss.xml` |
| Baipiaoji | Public JSON `baipiaoji.com/limits.json` |
| V2EX | Official public API (latest + hot) |
| LINUX DO | Public `latest.json` (marked failed when Cloudflare blocks direct access; never bypassed) |
| NodeSeek | Public homepage (marked failed when the IP is blocked; never bypassed) |
| X | Only `x.com/<handle>/status/<id>` links accepted; time derived from the snowflake ID |
| Threads | Public search pages (marked failed when nothing parses; never fabricated) |
| Sliverkiss | Public Telegram channel preview `t.me/s/sliverkiss_blog` |

### Core rules

1. **Never fabricate**: no seed, example or placeholder data. When a source cannot be fetched, mark it failed and keep its stored posts — never substitute another source.
2. **Never use fetch time as publish time**: every post stores `published_at`, `time_quality` and `fetched_at` separately.
3. **Refresh uses deterministic rule code only**; scheduled refresh never calls an LLM to classify or score posts one by one.
4. **No login, no bypass**: every source is a public endpoint. No API keys, tokens or accounts are needed.
5. Word lists, thresholds, windows and weights all live in `server/src/config.ts`; rule code references them instead of hard-coding values.
6. Catalog sources use "sync delete" (an entry missing from the source's current list is removed); forum sources use a 7-day retention window (30 days for tutorials); entries past their absolute deadline are taken down.

See [`DATA-PLAN.md`](DATA-PLAN.md) for the full data plan and `server/src/rules.ts` / `server/src/config.ts` for the implementation.

### Repository layout

```
client/                 React client (App.tsx UI and all interactions, theme.css dark/light themes)
server/src/             Server: actions.ts (7 actions), refresh.ts (refresh pipeline),
                        rules.ts (filter/classify/score rules), config.ts (all word lists
                        and thresholds), overrides.ts (human-verified backfills),
                        schema.ts (data model)
drizzle/                Database migrations 0001–0006
space.json              Space config (slug: yang-mao-kong-jian, hourly refresh cron)
data/                   Data snapshot: getstate.json (all 612 posts), posts.csv,
                        sources.json, stats.json
羊毛空间-复刻提示词.md    Full rebuild prompt for a fresh Muse (Route A: verbatim restore /
                        Route B: rebuild from spec; in Chinese)
DATA-PLAN.md            Source and design-notes record
AGENTS.md               Build notes
versions.md             Version history, v5–v14
```

### How to rebuild / deploy

**Route A (recommended, 100% identical)**: follow [`羊毛空间-复刻提示词.md`](羊毛空间-复刻提示词.md) — create a new TypeScript space in Muse, put this repo's `client/`, `server/`, `drizzle/`, `space.json`, `package.json`, `bunfig.toml` and `tsconfig.base.json` back at their original paths, backfill data from `data/getstate.json` (unique key `(source, external_id)`; keep read states and the verification overlay), and make sure the hourly refresh cron is enabled. **No credentials are needed.**

**Route B (no attachment)**: the same prompt file contains the complete spec (§3 filtering, §4 quality scoring, §5 keywords/gateways, category mapping v2, seven-dimension scoring, verification overlay, UI v14). Rebuild from the spec; the result is functionally identical.

### About the data

`data/` is a snapshot from the 2026-11-13 export: `getstate.json` is the full getState output (including computed rank/freshness fields — write only the posts-table fields when backfilling and ignore computed ones); `posts.csv` is the same posts in a human-readable table (opens directly in Excel, UTF-8 BOM), where `title_effective` / `summary_effective` / `quota_effective` are the values after overrides. Always check the vendor's official page for the live quota, conditions and expiry before claiming an offer.

### License

MIT License, see [LICENSE](LICENSE).

### Disclaimer

This project aggregates deal information from public sources for reference only. Quotas, conditions and expiry are governed by each vendor's official page as shown live, and this project is not affiliated with any of the sources or vendors above.
