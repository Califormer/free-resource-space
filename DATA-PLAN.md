# Data Plan

## Context provenance
- `数据源只有 LINUX DO、V2EX、NodeSeek、X，不要接 AppInn 或其他。只用公开搜索/公开页面，无需登录` (verbatim build request §0.3; only these four sources are ever fetched or searched)
- `绝不编造：不写种子/示例/占位数据` (verbatim build request §0.1; zero seed rows, honest empty state, per-source failure status instead of substitute data)
- `绝不用抓取时间当发布时间。每帖分开存 published_at、time_quality、fetched_at` (verbatim build request §0.2; schema stores all three separately; fetched_at never feeds freshness/retention/sort)
- `词表、阈值、窗口、权重放独立配置，不硬编码` (verbatim build request §0.5; all lists/thresholds/windows live in server/src/config.ts)
- `刷新任务用确定性代码（规则匹配），不在定时任务里调用大模型逐条分类` (verbatim build request §0.4; refresh pipeline is pure rule code in server/src/rules.ts + refresh.ts, no ctx.inference)
- `V2EX 可直接抓：GET https://www.v2ex.com/api/topics/hot.json 与 /latest.json，200 JSON，每条含 id、title、url、created（Unix 秒，属 exact）` (handed-off feasibility probe in the supplement; confirmed by my own curl below)
- `LINUX DO：本机 VM 直接请求被 Cloudflare 拦（403），不得绕过；实现时先试直连 latest.json 与 search.json，失败就标为失败、保留旧数据` (handed-off supplement; confirmed by my own curl below)
- `NodeSeek：直接请求 403（IP 被屏蔽），不得绕过；直连失败标失败、保留旧数据；HTML 中须从 href="/post-<id>-1" 取 ID，相对时间分钟/小时级算 relative、天级算 estimated` (handed-off supplement; 403 confirmed by my own curl below)
- `X：无公开 API、无账号；只接受 https://(x|twitter).com/<handle>/status/<id> 并用 snowflake 推导时间；抓不到就标失败或空，不要用聚合页顶替` (handed-off supplement; my web_search probe below confirms Chinese site:x.com queries return no usable status links)
- `每小时 cron 已在创建时声明` (refresh triggers on the build request; one hourly space_action schedule on the refresh action)

## Tested sources
### V2EX public API (direct fetch from action runtime)
**Used by**: refresh fetcher (latest + hot lists; keyword posts found by filtering these lists' titles, per supplement — no search API exists)
**Test command**: `curl -s -A 'Mozilla/5.0' 'https://www.v2ex.com/api/topics/latest.json' | head -c 1200` and same for hot.json
**Sample output**: HTTP 200 JSON array; each topic has `id`, `title`, `url`, `created` (Unix seconds → time_quality=exact), `content` (summary), node/member objects
**Processing**: dedupe latest+hot by topic id; created*1000 = published_at (exact)

### LINUX DO (direct fetch attempt, expected to fail)
**Used by**: refresh fetcher (latest.json, then search.json?q=<term> per keyword on success only)
**Test command**: `curl -s -o /tmp/ldo.txt -w '%{http_code}' -A 'Mozilla/5.0' 'https://linux.do/latest.json'`
**Sample output**: HTTP 403, Cloudflare `Just a moment...` challenge page — no bypass attempted
**Processing**: fetcher tries direct fetch each round; on non-200 marks source status `failed` with the HTTP error, keeps stored posts untouched. If a future round succeeds, Discourse topics give id/title/created_at (exact); dateless items would use same-source real-date anchors with linear ID interpolation (estimated), <2 anchors → dropped

### NodeSeek (direct fetch attempt, expected to fail)
**Used by**: refresh fetcher (homepage HTML)
**Test command**: `curl -s -o /tmp/ns.txt -w '%{http_code}' -A 'Mozilla/5.0' 'https://www.nodeseek.com/'`
**Sample output**: HTTP 403 `You are blocked — The IP is blocked due to high risk` — no bypass attempted
**Processing**: on success, parse `href="/post-<id>-1"` for external IDs and adjacent relative-time text (s/m/h ago → relative back-computed from fetch instant; day-level → estimated). On failure mark `failed`, keep old data

### X via public web search (ctx.tool.web_search)
**Used by**: refresh fetcher for X (strict status-URL filter + snowflake time) and §8 verification searches for all sources
**Test command**: probe-ctx snippet `ctx.tool.web_search('site:linux.do 免费 VPS')`, `ctx.tool.web_search('x.com status 免费 限免')`, `ctx.tool.web_search('site:nodeseek.com 免费')` (note: the runtime takes a plain string argument, not an object)
**Sample output**: results[] with `title`, `url`, `snippet`, `published_at` (ISO date or null), `last_updated_raw` (display-only, never parsed). LINUX DO query returned real topic URLs with parseable IDs but published_at=null. X query returned only aggregator/news pages (desidime etc.), zero direct x.com/<handle>/status/<id> links → X honestly yields 0 posts unless a future round finds strict matches
**Processing**: X accepts only results whose URL matches `^https://(x|twitter)\.com/<handle>/status/<digits>$` (no /i/web/status, no t.co); published_at = (id >> 22) + 1288834974657 ms, time_quality=snowflake; reject derived times in the future or before 2010-11; title = result title truncated to 80 chars

## Long-term data behavior
- **Refresh policy**: hourly cron (space_action → refresh action) plus manual refresh button calling the same action; mutex lock row + total timeout in the action; single-source failure never clears that source's stored posts; requests are sequential with small delays (rate limiting)
- **Growth**: posts hard-capped at 200 per §7 (after expiry purge, trim lowest composite rank); refresh_logs one row per round; source_status one row per source (4 rows)
- **Ordering**: composite rank = quality + freshness − (read ? 8 : 0), computed at read time from stored published_at/quality_score/is_read; ties → newer published_at, then external ID
- **Time semantics**: published_at/fetched_at stored as UTC epoch ms; time_quality ∈ exact|relative|snowflake|verified|estimated stored per post; UI renders Asia/Shanghai; estimated shows 约 prefix and is excluded from 今日精选; verified shows 已核验

## Rejected approaches
- **Tried**: direct fetch of linux.do/latest.json and nodeseek.com from this network
  **Why rejected**: both return 403 blocks (Cloudflare challenge / IP block). Per the brief, no circumvention (no proxy, no crawler, no login) — the fetcher retries direct each round and honestly reports `failed` until the source is reachable
- **Tried**: X via site:x.com web search for tweet discovery
  **Why rejected** (as a volume source): probes return aggregator pages, not status links; the strict URL filter stays, X simply collects whatever genuinely matches (likely 0) and reports empty/failed honestly
- **Tried**: parsing search results' `last_updated_raw` ("30 days ago") as publish dates
  **Why rejected**: the runtime schema marks it display-only and unreliable in both directions; using it would violate the never-fabricate-time rule. Search `published_at` (ISO date) is used only for §8 verification matches, as the brief prescribes

Imagery not needed: the artifact is a text post aggregator; the brief's UI spec (§11) contains no image slots — source badges are text chips.

## 2026-11-12 edit: Threads source + ingestPosts + LINUX DO adjustments
- **User expansion (verbatim follow-up)**: `LINUX DO、NodeSeek 还有 Threads 的信息，请你绞尽脑汁，想办法获取（别的 Muse 都做到了），X 的给我登录就行` — user added Threads as a 5th source (beyond the original four) and asked for X login; per parent-agent instruction, NO account login is performed by this artifact (no credentials, no bypass), NodeSeek/X stay failed/empty in refresh, and X login is handled outside the artifact by the main agent.
- **Threads feasibility (parent-agent measured, main-agent environment)**: the user's Threads account (jesusbro67) is connected via the official Threads connector; `threads-cli search` returned real posts with exact `taken_at` timestamps (e.g. “免费 GPT” → 2 posts, “Claude 免费” → 1 post on 2026-11-12). The artifact backend cannot run that CLI, so refresh tries public `https://www.threads.net/search?q=...` pages and parses embedded JSON (`taken_at`/`code`/`username`/caption `text`); if nothing parses (login wall / JS rendering) the source is marked failed/empty honestly. Real connector-measured posts enter via `ingestPosts` instead. Threads links: `https://www.threads.com/@<username>/post/<code>`; time_quality=exact; title = post text head ≤80 chars; threshold ≥2.
- **ingestPosts action (new)**: accepts externally measured real posts `{source, externalId, title, url, publishedAt (ISO), timeQuality, summary?}` and runs the identical §3 filter → §4/§5 classify/score → §6 retention → §9 dedupe upsert (preserves isRead + first fetched_at; estimated never overwrites exact/verified) → expiry purge → trim to 200 → refresh-log row (trigger=`ingest`). Rejects items missing/invalid publishedAt or url, future timestamps, unknown sources/timeQuality, and ALL NodeSeek/X items (unverified — those sources may only enter via the refresh pipeline's own strict rules).
- **LINUX DO changes**: refresh no longer calls `search.json` (parent-agent measured: it returns “您需要登录才能执行此操作” without login; user has not approved LINUX DO login). Refresh keeps direct `latest.json` (still HTTP 403 from this backend → marked failed, retried hourly, no bypass). Because latest.json is the whole-site newest list (not keyword search), a relevance gate was added in `rules.classify` for source=linuxdo: a post must hit at least one base wool word, bonus saving word, focus keyword, or AI gateway tool to be stored (applies to both the latest.json refresh path and ingestPosts; the by-keyword search.json path would not need it but is not called). This gate only filters; it fabricates nothing.
- **NodeSeek / X**: unchanged — direct fetch still blocked (NodeSeek IP-block page / Cloudflare verification loop measured by parent agent), X has no public posts source; both report failed/empty and are never substituted by other sources.

## 2026-11-12 edit: four catalog sources （懒猫 AI / AIHot Token 羊毛 / 赛博鸡蛋 / 白嫖计）
- **User expansion (verbatim follow-up)**: `加四条渠道：1. 懒猫 AI https://lanmao.ai/zh/offers.md 2. AIHot Token 羊毛 https://aihot.news/free-tokens 3. 赛博鸡蛋 https://jidan.si/c/credit 4. 白嫖计 https://baipiaoji.com/limits.json` — with parent-verified fetch formats; all four re-verified live by the builder (HTTP 200 from the sandbox, 2026-11-12).
- **懒猫 AI**: fetch `https://lanmao.ai/feed/zh.json` (object with `entries[]`, 341 entries at verification; fields id/name/vendor/quota/addedDate/lastVerified/url). Stored: title=name, summary=quota, url=`https://lanmao.ai/zh/o/<id>/`, published_at=lastVerified (day-level), time_quality=estimated, externalId=id.
- **AIHot Token 羊毛**: fetch `https://aihot.news/free-tokens` HTML; decode `streamController.enqueue("...")` string arg with two JSON decodes → flat array; find `"deals"`, next element = record index list (56 records at verification; builder's Python prototype resolved 56/56 with id/title/url/verifiedAt). Records are `{"_K": V}` dicts: key = data[int(K[1:])], value = data[V] for V>=0, null for V==-5, recursive for nested lists/dicts. Stored: title=title, summary=label + detail, url=record url (official claim link), published_at=verifiedAt (ms ISO), time_quality=exact, externalId=id.
- **赛博鸡蛋**: fetch `https://jidan.si/rss.xml` (RSS 2.0, 40 items; title/link/guid/category/pubDate/description). Only categories 免费试用额度 / 免费模型试用 / 新用户免费活动 are kept （付费折扣 excluded). Stored: published_at=pubDate, time_quality=exact, externalId=guid, url=link.
- **白嫖计**: fetch `https://baipiaoji.com/limits.json` (object with `tools[]`, 131 entries; slug/name/category/quota/wall/source/checked/page). Stored: title=name, summary=quota, url=page, published_at=checked (day-level), time_quality=estimated, externalId=slug.
- **Catalog retention rule (new, these four only)**: no 7-day/30-day expiry. Each refresh, a stored catalog entry missing from that source's current fetched list is deleted as delisted (sync only runs when that source's fetch succeeded; on failure old data is kept). Freshness/composite rank still computed from published_at; the global cap (200 at the time, raised to 500 on 2026-11-12 — see below) and lowest-rank trim are unchanged. §3 filter still applies at ingest and at reclassification; thresholds are ≥0 (same tier as LINUX DO / X); §5 keyword/gateway 7-day counts include the new sources automatically (they read all stored posts).

## 2026-11-12 edit: 全库上限 200 → 500
- **User request (verbatim)**: `把上限提到 500 条` — 全库上限从 200 改为 500。
- **Change**: `CONFIG.maxPosts` 200 → 500 in `server/src/config.ts` (single source of truth). Both trim points in `refresh.ts` (refresh pipeline step 8 and ingestPosts) already compare against `CONFIG.maxPosts`, and `getState` returns `cap: CONFIG.maxPosts`, which the UI renders as 总数/上限 — no other code change needed. All other rules unchanged: catalog sync-delete, 7-day/30-day expiry, composite-rank lowest-trim, §3 filter, §4 scoring, hourly cron. Next refresh re-fetches catalog sources in full, so entries previously trimmed by the 200 cap come back automatically.

## 2026-11-12 edit: 全库上限 500 → 700
- **User request (verbatim)**: `上限提到700条` — 全库上限从 500 改为 700。
- **Change**: `CONFIG.maxPosts` 500 → 700 in `server/src/config.ts` (single source of truth; same three surfaces as the 500 edit — config value, both `refresh.ts` trim points, and the UI cap via `getState`). All other rules unchanged. Next refresh re-fetches catalog sources in full, so entries previously trimmed by the 500 cap (e.g. 懒猫 AI's remaining ~27) come back automatically.

## 2026-11-12 edit: 界面升级第 1 轮（仅客户端，数据层零改动）
- **User request**: 界面升级（OpenDesign 原型 + Astryx 实测定案）：分页、4 格统计卡、来源 TabList、卡片样式 token、筛选 Switch、无障碍细节；数据层规则一律不动，不做虚拟滚动、不做暗色模式。
- **Change（仅 client/src/App.tsx + theme.css，server 未改）**:
  - 分页：列表只渲染当前页 50 条（PAGE_SIZE=50，客户端对 getState 全量结果切片；服务端契约不变），底部分页控件（上一页/下一页/页码窗口/第 X / 总页数）；任一筛选变化 useEffect 回第 1 页；页码越界自动钳制；翻页不触碰已读状态。
  - 顶部统计改为 4 格卡片（总数/上限、未读、今日精选、刷新按钮），tabular-nums；统计随来源 Tab 同步（选某来源时只统计该来源）。
  - 来源 TabList：全部 + 9 来源（顺序沿用 getState.sources，即 config SOURCES 顺序）各带库内计数，单选过滤；过滤无结果给空态说明。
  - 样式 token：背景 #f7f7f5、卡片白底 + 1px 边框 #e5e5e0 + 圆角 12px + 间距 12px、已读卡 opacity 0.55、今日精选卡左缘 3px 绿线、强调色 #16a34a 仅用于未读标记/今日精选徽标/主按钮（刷新与开关）；theme.css 移除暗色模式（color-scheme: light）。
  - 筛选 Switch：仅看未读（默认开，替代原已读/未读分段）+ 仅看今日精选（替代原复选框），role=switch，可组合；原类型片/重点词片/搜索保留。
  - 无障碍：分页与全部交互控件 ≥44px 触控、.focus-ring 可见焦点、prefers-reduced-motion 关过渡动画。

## 2026-11-12 edit: 筛选收紧 A+B（仅规则层，界面与其它规则不动）
- **User request (verbatim 要点)**: `数据筛选再精准一点` → 用户拍板 `就按 A+B 改`。A：重点词/网关命中不再无条件绕过阈值；B：§3 求购过滤补漏。
- **A（改 §5 绕过规则）**: 五个论坛来源（LINUX DO / V2EX / NodeSeek / X / Threads）命中重点词或 AI 网关的帖子，标题或摘要还必须至少含一个羊毛信号词才收录；不含信号词的不得分、不入库。信号词表放独立配置 `WOOL_SIGNAL_WORDS`（config.ts）= §4 基础词 16 个（免费、限时免费、限免、白嫖、羊毛、0元、零元、永久免费、试用、体验金、优惠、折扣、特价、低价、福利、补贴）+ 扩展词 17 个（低成本、零成本、省钱、领、送、额度、抵扣、积分、邀请码、兑换码、赠送、不要钱、白拿、薅、抽奖、返现、直降）。目录四家（懒猫 AI / AIHot / 赛博鸡蛋 / 白嫖计）不受影响；教程类帖子豁免。实现：`rules.classify` 新增 focusBlocked 判定，命中时不加 keywordBonus 且 passesThreshold=false；刷新流水线已有的全库重分类步骤自动按新规则清掉库内已存的不达标帖。
- **B（改 §3.1）**: `rules.isBuyRequest` 新增纯数字与“收”相邻即丢弃（`/\d+\s*收/` 与 `/收\s*\d+/`，如“1000收claude解封号”）；原有带货币单位的价格规则与其它 §3 规则不变。
- **预期（用户实测估算）**: 论坛 44 条 → 约 17 条，总数 597 → 约 570，目录四家数量不变。

## 2026-11-12 edit: 新增数据源 Sliverkiss（Telegram 公开频道）
- **User request (verbatim 要点)**: `给羊毛空间加一个新数据源：Telegram 公开频道 Sliverkissの废弃文化研究所（@sliverkiss_blog，用户已点头）。只加这一个来源，其他规则、界面主题、分页全部不动。`
- **读取方式（用户实测通过，照搬拉取器）**: 服务端每轮刷新 GET `https://t.me/s/sliverkiss_blog`，请求头带 Chrome UA（`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36`），不用登录/token/会话；频道公开，网页预览与登录后内容一致。解析与 `~/workspace/telegram-channel-feed/fetch_sliverkiss.py` 同一套正则：`tgme_widget_message_wrap` 块 → `data-post` 取 message_id、`<time datetime>` 取发布时间（绝对时间，time_quality=exact）、`tgme_widget_message_text` 取正文（`<br>` 换行、去标签、解 HTML 实体）。每轮只抓第一页（最新 20 条，约覆盖 7 天）；抓取失败标失败、保留库内旧数据，不用别的来源顶替。构建时 builder 已实测：HTTP 200，20 条（id 1028→1048，2026-11-05 至 2026-11-12）。
- **入库映射**: 来源 id `sliverkiss`，显示名 Sliverkiss；externalId = message_id；url = `https://t.me/s/sliverkiss_blog/<id>`；标题取正文第一行（≤100 字），摘要取正文（截 400 字，与其他来源同长）；去重键（来源，externalId）。
- **规则（按论坛类来源办）**: §3 过滤、§4 打分适用，阈值 ≥2（与 V2EX/NodeSeek 同档，config.thresholds.sliverkiss=2）；§5 重点词/AI 网关 + A 规则适用（非目录来源自动生效：命中重点词/网关须带 WOOL_SIGNAL_WORDS 信号词才收，教程豁免）；§6 保留窗口普通帖 7 天/教程 30 天（非目录来源自动走过期清理，不走目录对账删除）；§7 排名、§9 去重、700 上限、每小时刷新全部沿用现有流水线；重点词 7 天计数自动包含新来源（getState 统计全库）。
- **界面**: 无客户端改动——来源 TabList、来源状态区、顶部统计都由 getState 的 SOURCES 驱动，新来源自动出现并带计数。
- **验证预期（用户 2026-11-12 23:5x UTC 实测）**: 最新 20 条中 17 条带羊毛信号，3 条不带（id 1043 Surge 更新、id 1039 超级马里奥手游移植教程、id 1030 裸链接）必须被筛掉；17 条中最老 id 1028（2026-11-05T14:22Z）已超 7 天窗口，预期入库约 16 条。

## 2026-11-12 edit: 界面升级第 2 轮（仅客户端，数据层零改动）
- **User request**: 深色主题默认 + 主题切换、统计条手机端修复（第 1 轮真机 bug：数字截成 "59..."、标签折三行）、页码跳转输入、来源 TabList 横向滚动、分页手机端收起、无障碍补强；数据层规则一律不动，单列 880px、每页 50 条不变，不做虚拟滚动。
- **Change（仅 client/src/App.tsx + theme.css，server 未改）**:
  - 深色默认：`:root` 深色 token（页面底 #16181d、卡片 #1e2126、次要表面 #15171b、边框 #2e3238、主文字 #e8e9eb、次要文字 #9aa0a6、强调绿提亮版 #22c55e / 焦点环 #4ade80）；`:root[data-theme="light"]` 浅色沿用第 1 轮 token（#f7f7f5 / 白卡 / #e5e5e0 / #16a34a）。右上常驻主题开关（role=switch），默认深色，状态写 localStorage（key `yangmao-theme`），读写失败时模块级内存变量兜底。
  - 已读态三重区分：已读卡底 var(--surface-read)（深色 #1a1d21）+ 标题转次要文字色 + 元信息行新增“已读”标记；透明度走 var(--read-opacity)（深色 0.8、浅色 0.55）。
  - 统计条：`.stats-grid` <640px 改 2×2 两列，每格 min-width:0；数字 `.stat-num` 用 clamp(20px, 2.2vw, 24px) + tabular-nums + nowrap；标签 `.stat-label` nowrap 单行；“总数/上限”改大数字 + 小字 /cap 分开渲染，不再整串截断。
  - 页码跳转：分页区新增数字输入 + “跳转”按钮（form 提交，回车同效）；非数字不跳转并提示“请输入 1–N 之间的页码”；越界夹到 1..总页数并提示“已跳到第 X 页（共 N 页，输入已修正）”；输入框 aria-label 含 1–总页数范围；跳转与翻页共用 goPage（回列表顶部，prefers-reduced-motion 时不用平滑滚动），不触碰已读状态。
  - 手机端：来源 TabList 改原生横向滚动（flex nowrap + overflow-x auto，隐藏滚动条，不加自定义滚动控件），按钮 flexShrink:0；分页页码按钮 <640px 收起（`.pager-numbers` display:none），只留上一页 / 第 X / Y 页 / 下一页 + 跳转输入；全部触控目标 ≥44px。
  - 无障碍：焦点环改用 var(--focus)（深色 #4ade80 2px）；prefers-reduced-motion 关过渡与平滑滚动（CSS + goPage 的 matchMedia 双保险）。

## 2026-11-13 edit: 免费额度雷达第一版（GLOBAL DEAL HUNTER 补调优）
- **User request (verbatim 要点)**: 按「GLOBAL DEAL HUNTER｜全球羊毛情报中心」第一版（免费额度雷达）补调优：帖子新增结构化字段（category/quota/claimUrl/deadline/region/lastVerified/conditions/costNote/riskNote/rawRef，getState 暴露 first_seen）；分类映射 v2；刷新流水线加 deadline 过期下线；回填 ZCode（AIHot + 鸡蛋 2 条）与七牛云 Conatus（懒猫 1 条）；OpenRouter Crouton Alpha 不收录；首页三区（今日新上/即将到期/分类情报，只含目录四站）；卡片 11 项；搜索加强为标题+摘要+厂商/来源名、默认目录四站可切全库。现有数据规则、深色主题、分页 50、TabList、Switch 不动；七项评分与全局到期排序不做。
- **数据来源（本轮实测）**: 懒猫 feed `https://lanmao.ai/feed/zh.json`（341 条，entry 含 vendor/quota/region/deadline/difficulty/goals/lastVerified/url=lanmao.ai/go 中转）；AIHot `https://aihot.news/free-tokens` 内嵌载荷解码 57 条记录（字段含 provider/detail/note/appliesTo/endsAt/validity/verifiedAt/realName/clientOnly/desktopOnly/studentOnly/url 官方直链；kind 是节奏不作分类）；鸡蛋 RSS 40 条（category 是 offer 类型、付费折扣已排除；link 是鸡蛋文章页非官方入口）；白嫖计 limits.json 131 条（category/quota/wall/source 文字说明/checked 核查日期/page 本站详情页）。回填依据：AIHot 原始记录 `zcode-trial-5day`（provider 智谱 ZCode，detail/appliesTo/validity「首次使用起 5 天」/verifiedAt 2026-11-13/url=https://zcode.z.ai/cn/docs/configuration，clientOnly+desktopOnly）、懒猫条目 `qiniu-conatus-free-daily-100m-tokens`（deadline 2026-11-30、lastVerified 2026-11-02、region cn、url 中转）与用户给出的官方核实表（Conatus 官方页 https://www.qiniu.com/ai/free-models/conatus-2026，2026-11-13 复核一致）；覆盖值集中存 `server/src/overrides.ts`，每轮刷新 upsert 后重新套用，只改字段不动 published_at/time_quality。
- **分类口径对账（重要，含一次口径修正）**: 任务书第一部分给出分类映射 v2 三层规范（标题层 ＞ 来源原生字段层 ＞ 默认），第五部分又给出实测分布（目录 553 条：API 约 177 / 应用试用约 323 / 开发工具 31 / 免费算力 21 / 云服务 1）。构建时逐条试算发现：标题层单独运行得 179/322/31/21/1（与第五部分数字仅差快照漂移），而落实第 2 层（懒猫 goals：341 条中 197 条含 api；白嫖计 category 与标题层 50 条不一致）得约 282/183/67/21/1。首版曾按第五部分数字只做标题层，审计复核判定第一部分的映射规范为合规口径、P0 要求落实第 2 层，故最终实现严格按三层规范：config.ts CATEGORY_* 词表（顺序 算力→云服务→API→开发工具，API 词边界、英文名大小写敏感、摘要不参与、厂商名单独不作云服务信号、gazetteer 含扣子 Coze）+ rules.classifyCategory 的原生字段层（白嫖计 category 映射、懒猫 goals 映射；鸡蛋 category/AIHot kind 非主题分类不参与），ingest 时算出存入；重分类步骤对目录条目保留已存 category（原生字段只在抓取时有）。沙箱实测分布（552 条目录帖）：API 282 / 应用试用 183 / 开发工具 67 / 免费算力 21 / 云服务 1；指定抽查样例两种口径下都分对（OpusClip→AI 应用试用、超算互联网领 Token→免费算力、Zed 卖模型额度→大模型 API、扣子 Coze→开发工具）。
- **Crouton Alpha**: 官方页 https://openrouter.ai/stealth 已确认免费预览结束（用户核实）；config.EXCLUDED_TITLE_RE 在抓取分类、重分类、ingestPosts 三处拦截标题/id 含 crouton 的条目，库内现无此条目（仅有 OpenRouter 免费模型类一般条目，不在此列）。
- **deadline 过期**: 懒猫 deadline（日期→当日 23:59:59+08）与 AIHot endsAt 入库为 posts.deadline；流水线清过期步骤对全来源增加「deadline 已过即下线」（目录来源仍豁免保留窗口）；实测懒猫 3 条已过期（tencent-workbuddy 2026-10-10、aliyun-bailian-student-300-voucher 2026-11-10、unisound-u2-flash-free-api 2026-10-31）将在下轮刷新下线。相对有效期（AIHot validity）存 deadline_text，只进卡片不进即将到期区。
- **下架同步豁免**: 带人工核实覆盖的条目豁免目录对账删除——鸡蛋 RSS 仅最近 40 条滚动窗口，ZCode 条目（free/252）已滚出窗口但并非下架，覆盖保留；其余条目对账规则不变。
- **三区与搜索（客户端）**: 今日新上=目录帖 publishedAt≤24h 或 first_seen≤24h；即将到期=绝对 deadline 在 (0,30天] 内、区内按到期升序、标题带计数；分类情报=categoryCounts 五类 Tab + 每类按综合排名前 10。卡片对目录帖渲染结构化明细（额度/条件/地区/成本/风险/到期/官方入口/最后核实），fallback：到期未公布写「未公布」、无依据标「未核实」、风险缺省带通用提示、成本缺省只写「未核实」不写 0 元；白嫖计 checked 旧日期（多为 2026-08）如实显示。

## 2026-11-13 edit: 到期排序 + 七项评分 + 核实覆盖层
- **User request (verbatim 要点)**: 按建议顺序三项都做（排序 → 评分 → 核实轮次准备）：① 列表加「按到期时间」排序选项（默认仍综合排名）；② 七项评分（额度/紧迫性/领取难度/可信度先上，风险/实用性/适用人群留 null）+「按综合分」排序；③ 核实覆盖层数据模型 + setVerified action + verifiedStatus（ok/ended）。评分与排序只作用于目录四站，论坛/Sliverkiss 不参与。
- **评分实现**: 规则表集中在 config.SCORE_RULES，纯函数在 rules.computeScores（scoreQuota/scoreUrgency/scoreDifficulty/scoreCredibility），只读已存结构化字段（quota/conditions/deadline/deadlineText/claimUrl/claimNote/url/lastVerified），不调大模型。刷新流水线在 overrides 套用之后新增 5.6 步：对全部目录帖重算并回填 scores（JSON 列）/score_total/score_coverage，新帖同轮即算；非目录帖恒 null/0。额度解析：Token 类取文本中第一个「数字+单位」（万/亿/K/M/B）按最早出现的周期词换算日均（每月 ÷30，一次性按总额）；小时/美元/积分次数类各自档位；解析不到数字记 null。难度：条件+额度文本扫描门槛词组，含「未核实」的分句剔除后再判（未核实的要求不算已确认门槛）。可信度按链接形态（官方直链/中转=lanmao.ai/go 或 claimNote 含「中转」/站内页）× 核实日期新鲜度分档，卡片上命名「来源可信度」。
- **实测核对（构建时 curl 原始数据）**: 懒猫 Conatus 条目 quota 原文「…每日可免费调用 Conatus 融合模型 1 亿 Token」、difficulty=medium；AIHot ZCode 记录（zcode-trial-5day）verifiedAt 2026-11-13、url 为官方直链、validity「首次使用起 5 天」、**realName=false**——与任务书预期「难度应含实名 −1」不一致：现行原始数据与已核实 conditions 文本均无实名要求，确定性规则不编造门槛，ZCode 难度按规则为基础 3 + 无门槛 1 = 4，已在交付报告中标注此出入。另：任务书 §四 预期 ZCode 额度=4，但其 §二 档位表为 ≥1000 万/天=4、≥100 万/天=3，800 万/天按表只能得 3——两处自相矛盾，本轮按档位表实现（ZCode 额度=3），出入已在交付报告中标注。
- **核实覆盖层**: posts 新增 verified_region/cost/risk/conditions/at/source_url/status 六列（migration 0004，连同 scores/score_total/score_coverage）；刷新流水线的 upsert/重分类/评分回填均不写 verified_* 列，覆盖层只由 setVerified action 写入（参数 source+externalId+各 verified 字段，只写覆盖层）；getState 原样暴露，卡片有 verified 值时优先显示并带「已核实」标记 + 核实日期 + 证据链接；verifiedStatus=ended 显示「已结束」徽标并移出今日新上/即将到期两区。
- **排序（客户端）**: 筛选卡新增排序片（综合排名/按到期时间/按综合分），默认综合排名；到期排序=目录帖有绝对 deadline 者升序在前、无 deadline 目录帖随后、非目录帖沉底（组内保持综合排名序）；综合分排序=coverage 降序 → scoreTotal 降序 → 综合排名；排序仍服从现有筛选与分页（筛选/排序变化回第 1 页）。

## 2026-11-13 edit: 核实分数落库 + 标题覆盖（七项评分收尾）
- **User request (verbatim 要点)**: 七项评分收尾两项：① 核实分数落库——setVerified 扩展 scoreRisk/scoreUsefulness/scoreAudience 三个可选参数（1–5 或 null），只更新 scores 对应三维与 scoreTotal/scoreCoverage；口径统一写进评分配置（七维方向一致 5=对用户最有利，风险 5=最安全；核实建议分若按「5=风险最高」给出，落库前由写入方按 6−x 翻转，setVerified 收到的即统一口径分）；落库以核实分为准，每小时刷新重算时三维一旦写入不得被规则覆盖（规则只能填 null 维度），其余四维仍每轮重算。② 标题覆盖——posts 新增 title_override 列（migration 0005），setVerified 增加 titleOverride 参数，卡片优先显示覆盖标题并小字注明「标题已按官方页修正」，刷新绝不覆盖；本轮不预填任何覆盖值。现有规则、分类、三区、排序、每小时刷新其余部分不动。
- **实现**: rules 新增 summarizeScores（computeScores 复用）与 mergeVerifiedScores（只合并三维、重算 total/coverage）；refresh 5.6 步从库内已存 scores 读出三维作为 preserved 传入 computeScores 原样保留，解析失败按无核实分处理；setVerified 改为读整行后合并写回 scores/scoreTotal/scoreCoverage，并写 title_override；getState 暴露 titleOverride；客户端 PostCard 标题改 `titleOverride ?? title` + 覆盖注明（三区与主列表共用 PostCard，自动生效）。评分配置注释（config.SCORE_RULES 上方）与 rules 评分段注释已写入统一口径与翻转约定。

## 2026-11-13 edit: 额度覆盖 + 简介覆盖（沿用 titleOverride 模式）
- **User request (verbatim 要点)**: `给羊毛空间加额度覆盖与简介覆盖两个字段，沿用已有的 titleOverride 模式。只建字段与接口，不预填任何覆盖值。` 动机：第 3 批核实发现多条简介/额度文字与官方不符（人脸融合额度「每月」实为一次性包、Claude Free / ChatGPT / Poe / Anthropic / 沉浸式翻译 / AI Studio / DuckDuckGo 简介与官方不符），titleOverride 改不了；覆盖值由后续单独一轮写入，本轮不写任何值。
- **实现**: posts 新增 quota_override / summary_override 两列（migration 0006）；setVerified 增加 quotaOverride / summaryOverride 两个可选参数（字符串或 null，不传=不动、传 null=清除），只写覆盖层；getState 暴露两字段；客户端 PostCard：额度栏 `quotaOverride ?? quota` + 小字「额度已按官方页修正」，简介 `summaryOverride ?? summary` + 小字「简介已按官方页修正」（三区与主列表共用 PostCard，行为一致）。
- **刷新安全性**: refresh 流水线全部写操作（upsert 的 insert 与 onConflictDoUpdate、时间保护、重分类、overrides 回填、5.6 评分回填）均为显式列清单，均不含 quota_override / summary_override / title_override，故每小时刷新与评分回填绝不覆盖这三列；本轮已逐处核对代码。

## 2026-11-13 edit: 筛选区回归顶部 + 分类 chips（仅客户端，数据层零改动）
- **User request (verbatim 要点)**: `手机打开变成图一这样的了，可以不砍现在的功能，把之前的排序分类，搜索那些的都带回来吗？（跟现在有冲突的就跳过）` —— 真机截图显示统计条下面直接是「今日新上」三区，筛选控件（来源 TabList、排序、开关、搜索、来源状态）被排到了三区之后、手机上要滑很久才见得到，看起来像丢了。
- **实情核对**: 上一轮（三区上线）后筛选控件本身都还在 App.tsx 里，只是位于三区之后；本轮把「来源 TabList + 筛选卡片」整块移回顶部统计条之下、三区之上，控件与逻辑一项未删。
- **新增分类 chips**: 筛选卡新增一排「分类：全部 + 五类（大模型 API / AI 应用试用 / 云服务 / 开发工具 / 免费算力，计数取 getState.categoryCounts）」，按帖子 category 字段单选过滤，与来源/排序/开关/标签/重点词/网关/搜索全部 AND 组合，切换回第 1 页。「分类情报」区自己的分类 Tab（zoneCategory）保持独立、互不影响。
- **标签快筛口径（旧图第二排 chips 的对应关系）**: 免费 / 限免 / 低价 / 教程 / AI网关（标签行）→ posts.tags（classify 入库时按规则写入，教程与 isTutorial 同源）；重点词行另有一个带计数的「AI网关」→ gatewayIds 非空。两处 AI网关 都是前几轮已有的控件、映射不同字段，本轮原样保留（旧图里出现两次正是这两处）。五项均能干净对应现有字段，作为第二排快筛保留（多选 OR 组内、与其它条件 AND）。
- **排序口径对齐本轮任务书**: 「按到期时间」改为对筛选结果全集生效——有绝对 deadline 者升序在前、无 deadline 者沉底（组内保持综合排名序）；实际只有目录条目带绝对 deadline，论坛帖自然沉底，与上一轮「目录优先」口径的可见结果一致。「按综合分」改为全集按 coverage 降序 → scoreTotal 降序 → 综合排名；未评分条目（coverage 0 / total null）自然沉底。默认仍综合排名；排序变化回第 1 页。
- **触控目标**: Chip 最小高度 40 → 44px，全页交互控件 ≥44px 对齐。
- **跳过项**: 无。任务书 6 项控件全部恢复/保留，无旧控件因冲突被跳过。

## 2026-11-13 edit: 三区与筛选联动（"点了没反应"根因修复，仅客户端）
- **User request (verbatim)**: `回是回来了，但是点了还是没有任何的反应（包括搜索）` —— 真机截图实测：① 12:13 选了 AIHot 来源、搜索框输入 "Hy4"、范围全库，但下方「今日新上（528 条）」仍是未过滤原列表，第一条还是赛博鸡蛋的帖子；② 12:11「大模型 API」分类 chip 已选中（白底），列表无任何变化。上一轮桌面探针点击全过，但真机首屏不动。
- **根因**: 点按与状态更新其实正常（截图里选中态都变了）；问题是首页三区（今日新上 / 即将到期 / 分类情报）直接由全量 `catalogPosts` 计算，**完全绕过筛选状态**（来源/分类/未读/精选/类型/重点词/网关/搜索词一概不看）。真正吃筛选的主列表排在三区几十张卡片之后，手机上滑不到，"点了没反应"是首屏不动造成的错觉，与控件本身无关。
- **修法（只加联动、不删功能）**: 筛选逻辑抽成统一谓词 `applyFilters(posts, withCategory)`，主列表与三区共用：今日新上/即将到期吃全套条件（含分类）；分类情报吃除分类外的条件、分类由该区自己的 chip 决定。筛选卡里点分类 chip 时同步把分类情报区切到同一分类（zoneCategory），首屏立刻可见变化。搜索匹配新增 titleOverride/summaryOverride 两字段（卡片显示的就是覆盖文字，理应可搜）。筛选卡正下方新增「当前筛选：共 N 条结果（搜索「X」· 范围…）+ 清除全部筛选」横幅，任一筛选偏离默认即出现，数字随点按实时变。清除全部筛选同时把 zoneCategory 复位到默认「大模型 API」。
- **未动**: 数据层、actions、刷新流水线、评分/核实覆盖、三区构成与条数（新上 8 条/情报 10 条）、分页与排序口径全部原样。
