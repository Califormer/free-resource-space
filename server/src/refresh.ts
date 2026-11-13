// 羊毛空间 — 抓取器 + 单次刷新流水线（任务 §2、§8、§9、§12）。
// 顺序：抓取 → 标准化/解析时间 → 过滤 → 分类打标 → 打分/阈值 → 去重入库 →
//       全库重分类 → 时间核验 → 清过期 → 综合排名裁剪至 CONFIG.maxPosts → 写日志。
// 只用公开接口/公开搜索：无账号、无 cookie、无付费 API，不绕过任何拦截；
// 某来源失败只标该来源失败，保留其库内旧数据（§0.3）。

import type { Ctx } from "@hatch/space-sdk";
import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import {
CATALOG_SOURCES,
CONFIG,
EXCLUDED_TITLE_RE,
JIDAN_CATEGORIES,
THREADS_SEARCH_QUERIES,
X_SEARCH_QUERIES,
type SourceId,
} from "./config";
import { POST_OVERRIDES, OVERRIDE_KEYS } from "./overrides";
import {
classify,
classifyCategory,
compositeScore,
computeScores,
interpolateById,
isExpired,
isFiltered,
lagHoursForLatest,
parseRelativeTime,
parseXStatusUrl,
xSnowflakeMs,
type Anchor,
type RawPost,
type TimeQuality,
} from "./rules";

type Db = ReturnType<Ctx["db"]>;

const UA = "Mozilla/5.0 (compatible; YangMaoKongJian/1.0; public-feed-reader)";

export interface SourceRound {
  fetched: number;
  filtered: number;
  kept: number;
  status: "ok" | "failed" | "empty";
  error: string | null;
}

export interface RefreshResult {
  status: "ok" | "already_running" | "timeout";
  startedAt: string;
  finishedAt: string;
  totalPosts: number;
  perSource: Record<string, SourceRound>;
  timeQualityCounts: Record<string, number>;
  expiredRemoved: number;
  delistedRemoved: number;
  trimmed: number;
  verified: number;
  notes: string[];
}

const emptyRound = (): SourceRound => ({
  fetched: 0,
  filtered: 0,
  kept: 0,
  status: "empty",
  error: null,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(
  url: string,
  ua: string = UA,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": ua, Accept: "application/json, text/html;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(CONFIG.fetchTimeoutMs),
    redirect: "follow",
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// ------------------------------------------------------------- V2EX

interface V2exTopic {
  id?: number;
  title?: string;
  url?: string;
  content?: string;
  created?: number;
}

async function fetchV2ex(): Promise<{ posts: RawPost[]; round: SourceRound }> {
  const round = emptyRound();
  const byId = new Map<string, RawPost>();
  let anyOk = false;
  let lastError: string | null = null;
  for (const endpoint of ["latest", "hot"]) {
    try {
      const r = await fetchText(`https://www.v2ex.com/api/topics/${endpoint}.json`);
      if (!r.ok) {
        lastError = `V2EX ${endpoint} HTTP ${r.status}`;
        continue;
      }
      const topics = JSON.parse(r.body) as V2exTopic[];
      anyOk = true;
      for (const t of topics) {
        if (t.id == null || !t.title || t.created == null) continue;
        const id = String(t.id);
        if (byId.has(id)) continue;
        byId.set(id, {
          source: "v2ex",
          externalId: id,
          title: t.title,
          summary: (t.content ?? "").slice(0, 400),
          url: t.url ?? `https://www.v2ex.com/t/${id}`,
          publishedAtMs: t.created * 1000,
          timeQuality: "exact",
        });
      }
    } catch (e) {
      lastError = `V2EX ${endpoint}: ${e instanceof Error ? e.message : String(e)}`;
    }
    await sleep(CONFIG.requestGapMs);
  }
  if (!anyOk) {
    round.status = "failed";
    round.error = lastError ?? "V2EX 接口不可用";
    return { posts: [], round };
  }
  const posts = [...byId.values()];
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  return { posts, round };
}

// ------------------------------------------------------------- LINUX DO

interface DiscourseTopic {
  id?: number;
  title?: string;
  created_at?: string;
  excerpt?: string;
}

function discourseToRaw(t: DiscourseTopic): RawPost | null {
  if (t.id == null || !t.title) return null;
  let ms: number | null = null;
  let quality: TimeQuality = "estimated";
  if (t.created_at) {
    const parsed = Date.parse(t.created_at);
    if (Number.isFinite(parsed)) {
      ms = parsed;
      quality = "exact";
    }
  }
  return {
    source: "linuxdo",
    externalId: String(t.id),
    title: t.title,
    summary: (t.excerpt ?? "").replace(/<[^>]*>/g, "").slice(0, 400),
    url: `https://linux.do/t/topic/${t.id}`,
    publishedAtMs: ms,
    timeQuality: quality,
  };
}

async function fetchLinuxDo(): Promise<{ posts: RawPost[]; round: SourceRound }> {
  const round = emptyRound();
  const byId = new Map<string, RawPost>();
  try {
    const latest = await fetchText("https://linux.do/latest.json");
    if (!latest.ok) {
      round.status = "failed";
      round.error = `LINUX DO latest.json HTTP ${latest.status}（公开接口被拦截，未绕过）`;
      return { posts: [], round };
    }
    const data = JSON.parse(latest.body) as { topic_list?: { topics?: DiscourseTopic[] } };
    for (const t of data.topic_list?.topics ?? []) {
      const raw = discourseToRaw(t);
      if (raw) byId.set(raw.externalId, raw);
    }
    // 注意：search.json 实测需登录（返回“您需要登录才能执行此操作”），
    // 用户未批准 LINUX DO 登录，刷新里不调用它。latest.json 全站列表的
    // 相关性由 rules.classify 的 LINUX DO 相关性门把关。
  } catch (e) {
    round.status = "failed";
    round.error = `LINUX DO: ${e instanceof Error ? e.message : String(e)}`;
    return { posts: [], round };
  }
  const posts = [...byId.values()];
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  return { posts, round };
}

// ------------------------------------------------------------- NodeSeek

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchNodeSeek(nowMs: number): Promise<{ posts: RawPost[]; round: SourceRound }> {
  const round = emptyRound();
  let html: string;
  try {
    const r = await fetchText("https://www.nodeseek.com/");
    if (!r.ok) {
      round.status = "failed";
      round.error = `NodeSeek 首页 HTTP ${r.status}（IP 被屏蔽，未绕过）`;
      return { posts: [], round };
    }
    html = r.body;
  } catch (e) {
    round.status = "failed";
    round.error = `NodeSeek: ${e instanceof Error ? e.message : String(e)}`;
    return { posts: [], round };
  }
  // 首页列表：从 href="/post-<id>-1" 取 ID，锚文本为标题；
  // 相对时间出现在同一列表项文本中（标题之后的片段内）。
  const posts: RawPost[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a[^>]+href="\/post-(\d+)-1"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const id = m[1] ?? "";
    const title = stripTags(m[2] ?? "");
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const tail = stripTags(html.slice(m.index, m.index + 1200));
    const rel = parseRelativeTime(tail.replace(title, " "), nowMs);
    posts.push({
      source: "nodeseek",
      externalId: id,
      title,
      summary: "",
      url: `https://www.nodeseek.com/post-${id}-1`,
      publishedAtMs: rel?.ms ?? null,
      timeQuality: rel?.quality ?? "estimated",
    });
  }
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  if (posts.length === 0) round.error = "NodeSeek 首页未解析到帖子列表";
  return { posts, round };
}

// ------------------------------------------------------------- X（公开搜索）

async function fetchX(
  ctx: Ctx,
  nowMs: number,
): Promise<{ posts: RawPost[]; round: SourceRound }> {
  const round = emptyRound();
  const byId = new Map<string, RawPost>();
  let searchFailed = false;
  let lastError: string | null = null;
  for (const q of X_SEARCH_QUERIES) {
    try {
      const res = await ctx.tool.web_search(q);
      for (const item of res.content.results) {
        if (!item.url) continue;
        const parsed = parseXStatusUrl(item.url);
        if (!parsed || byId.has(parsed.id)) continue;
        const ms = xSnowflakeMs(parsed.id);
        if (ms == null) continue;
        // 推导时间晚于当前或早于 2010-11 的丢弃（§8）
        if (ms > nowMs || ms < CONFIG.xMinTimeMs) continue;
        const title = (item.title || "").trim().slice(0, 80);
        if (!title) continue;
        byId.set(parsed.id, {
          source: "x",
          externalId: parsed.id,
          title,
          summary: (item.snippet ?? "").slice(0, 300),
          url: `https://x.com/${parsed.handle}/status/${parsed.id}`,
          publishedAtMs: ms,
          timeQuality: "snowflake",
        });
      }
    } catch (e) {
      searchFailed = true;
      lastError = `X 搜索: ${e instanceof Error ? e.message : String(e)}`;
    }
    await sleep(CONFIG.requestGapMs);
  }
  const posts = [...byId.values()];
  round.fetched = posts.length;
  if (posts.length > 0) {
    round.status = "ok";
  } else if (searchFailed) {
    round.status = "failed";
    round.error = lastError;
  } else {
    round.status = "empty";
    round.error = "公开搜索未找到符合严格链接格式的 X 帖子";
  }
  return { posts, round };
}

// ------------------------------------------------------------- Threads（公开页面）

// Threads 官方连接器（threads-cli）在主代理环境实测可搜到真实帖子与精确
// taken_at，但空间后端跑不了该 CLI；这里只尝试公开 threads.net 搜索页，
// 解析页面内嵌 JSON 中的 taken_at / code / username / caption。
// 解析不到（登录墙/脚本渲染）就如实标失败/空，绝不编造。
function unescapeJsonString(s: string): string {
  // s 是 JSON 字符串的原始内文（转义序列尚在），直接交给 JSON 解析还原
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function parseThreadsHtml(html: string, byId: Map<string, RawPost>): void {
  const takenRe = /"taken_at"\s*:\s*(\d{10})/g;
  let m: RegExpExecArray | null;
  while ((m = takenRe.exec(html)) !== null) {
    const windowText = html.slice(Math.max(0, m.index - 3000), m.index + 3000);
    const code = /"code"\s*:\s*"([A-Za-z0-9_-]{5,})"/.exec(windowText)?.[1];
    if (!code || byId.has(code)) continue;
    const username = /"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/.exec(windowText)?.[1];
    if (!username) continue;
    const capIdx = windowText.indexOf('"caption"');
    if (capIdx < 0) continue;
    const textMatch = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
      windowText.slice(capIdx, capIdx + 4000),
    );
    const text = textMatch?.[1] ? unescapeJsonString(textMatch[1]).trim() : "";
    if (!text) continue;
    byId.set(code, {
      source: "threads",
      externalId: code,
      title: text.replace(/\s+/g, " ").slice(0, 80),
      summary: text.slice(0, 400),
      url: `https://www.threads.com/@${username}/post/${code}`,
      publishedAtMs: Number(m[1]) * 1000,
      timeQuality: "exact",
    });
  }
}

async function fetchThreads(): Promise<{ posts: RawPost[]; round: SourceRound }> {
  const round = emptyRound();
  const byId = new Map<string, RawPost>();
  let anyOk = false;
  let lastError: string | null = null;
  for (const q of THREADS_SEARCH_QUERIES) {
    try {
      const r = await fetchText(
        `https://www.threads.net/search?q=${encodeURIComponent(q)}`,
      );
      if (!r.ok) {
        lastError = `Threads 公开搜索页 HTTP ${r.status}`;
        continue;
      }
      anyOk = true;
      parseThreadsHtml(r.body, byId);
    } catch (e) {
      lastError = `Threads: ${e instanceof Error ? e.message : String(e)}`;
    }
    await sleep(CONFIG.requestGapMs);
  }
  const posts = [...byId.values()];
  round.fetched = posts.length;
  if (posts.length > 0) {
    round.status = "ok";
  } else if (anyOk) {
    round.status = "empty";
    round.error = "Threads 公开页面未解析到帖子（页面需登录或脚本渲染，后端无法读取）";
  } else {
    round.status = "failed";
    round.error = lastError ?? "Threads 公开页面不可用";
  }
  return { posts, round };
}

// ------------------------------------------------- Sliverkiss（Telegram 公开频道）

// 频道 @sliverkiss_blog 是公开频道，网页预览 https://t.me/s/sliverkiss_blog
// 无需登录/token/会话，内容与登录后一致。解析方式与已实测的拉取器
// （~/workspace/telegram-channel-feed/fetch_sliverkiss.py）同一套正则：
// tgme_widget_message_wrap 块 → data-post 取 message_id、<time datetime>
// 取绝对发布时间（exact）、tgme_widget_message_text 取正文。
// 每轮只抓第一页（最新 20 条，约覆盖 7 天，正好是普通帖保留窗口），不翻页。
const SLIVERKISS_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const SLIVERKISS_BASE = "https://t.me/s/sliverkiss_blog";

/** HTML 实体解码（命名实体 + 十进制/十六进制数字实体），与拉取器的 html.unescape 对齐 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fetchSliverkiss(): Promise<{ posts: RawPost[]; round: SourceRound }> {
  const round = emptyRound();
  let html: string;
  try {
    const r = await fetchText(SLIVERKISS_BASE, SLIVERKISS_UA);
    if (!r.ok) {
      round.status = "failed";
      round.error = `Sliverkiss 公开预览页 HTTP ${r.status}`;
      return { posts: [], round };
    }
    html = r.body;
  } catch (e) {
    round.status = "failed";
    round.error = `Sliverkiss: ${e instanceof Error ? e.message : String(e)}`;
    return { posts: [], round };
  }
  const posts: RawPost[] = [];
  const seen = new Set<string>();
  const blockRe =
    /<div class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)(?=<div class="tgme_widget_message_wrap|$)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1] ?? "";
    const idMatch = /data-post="[^/]+\/(\d+)"/.exec(block);
    const id = idMatch?.[1] ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // 无绝对发布时间的消息不收录（绝不用抓取时间冒充）
    const dtRaw = /<time datetime="([^"]+)"/.exec(block)?.[1];
    const ms = dtRaw ? Date.parse(dtRaw) : NaN;
    if (!Number.isFinite(ms)) continue;
    const textMatch =
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    let text = "";
    if (textMatch) {
      text = decodeHtmlEntities(
        (textMatch[1] ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
      ).trim();
    }
    // Telegram 消息没有标题：标题取正文第一行（≤100 字）；无正文无法生成标题，不收录
    const firstLine = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!firstLine) continue;
    posts.push({
      source: "sliverkiss",
      externalId: id,
      title: firstLine.slice(0, 100),
      summary: text.slice(0, 400),
      url: `${SLIVERKISS_BASE}/${id}`,
      publishedAtMs: ms,
      timeQuality: "exact",
    });
  }
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  if (posts.length === 0) round.error = "Sliverkiss 公开预览页未解析到消息";
  return { posts, round };
}

// ------------------------------------------------- 目录类来源（四条新渠道）
// 这四家是常驻优惠目录：抓取成功时附带 seenIds（来源当前列表的全部 externalId），
// 流水线据此对账删除已下架条目；抓取失败则不带 seenIds，库内旧数据原样保留。

interface CatalogFetch {
  posts: RawPost[];
  round: SourceRound;
  /** 仅抓取成功时给出：来源当前列表中的 externalId 集合（对账下架用） */
  seenIds: Set<string> | null;
}

// ------------------------------------------------------------- 懒猫 AI

interface LanmaoEntry {
  id?: string;
  name?: string;
  vendor?: string;
  quota?: string;
  region?: string;
  deadline?: string | null;
  difficulty?: string;
  goals?: string[];
  lastVerified?: string;
  url?: string;
}

/** 懒猫 region 代码 → 展示文本（来源自身标注，未知代码原样保留） */
function lanmaoRegionText(code: string | undefined): string | null {
  if (!code) return null;
  if (code === "cn") return "中国大陆";
  if (code === "overseas") return "海外";
  return code;
}

const LANMAO_DIFFICULTY: Record<string, string> = {
  easy: "低",
  medium: "中",
  hard: "高",
};

async function fetchLanmao(): Promise<CatalogFetch> {
  const round = emptyRound();
  let entries: LanmaoEntry[];
  try {
    const r = await fetchText("https://lanmao.ai/feed/zh.json");
    if (!r.ok) {
      round.status = "failed";
      round.error = `懒猫 AI feed HTTP ${r.status}`;
      return { posts: [], round, seenIds: null };
    }
    const data = JSON.parse(r.body) as { entries?: LanmaoEntry[] };
    if (!Array.isArray(data.entries)) throw new Error("feed JSON 缺少 entries 数组");
    entries = data.entries;
  } catch (e) {
    round.status = "failed";
    round.error = `懒猫 AI: ${e instanceof Error ? e.message : String(e)}`;
    return { posts: [], round, seenIds: null };
  }
  const seenIds = new Set<string>();
  const posts: RawPost[] = [];
  for (const e of entries) {
    if (!e.id || !e.name) continue;
    seenIds.add(e.id);
    const ms = e.lastVerified ? Date.parse(e.lastVerified) : NaN;
    if (!Number.isFinite(ms)) continue;
    posts.push({
      source: "lanmao",
      externalId: e.id,
      title: e.name,
      summary: (e.quota ?? "").slice(0, 400),
      url: `https://lanmao.ai/zh/o/${e.id}/`,
      // lastVerified 为天级日期 → estimated
      publishedAtMs: ms,
      timeQuality: "estimated",
      // 结构化字段（来源原生）：quota/region/deadline/lastVerified/difficulty
      quota: e.quota ?? null,
      vendor: e.vendor ?? null,
      region: lanmaoRegionText(e.region),
      // deadline 为日期（无时刻）→ 取当日 23:59:59（北京时间）为到期时刻
      deadlineMs: e.deadline ? Date.parse(`${e.deadline}T23:59:59+08:00`) : null,
      deadlineText: null,
      lastVerified: e.lastVerified ?? null,
      conditions:
        e.difficulty && LANMAO_DIFFICULTY[e.difficulty]
          ? `领取难度：${LANMAO_DIFFICULTY[e.difficulty]}（懒猫 AI 标注）`
          : null,
      claimUrl: e.url ?? null,
      claimNote: e.url?.includes("lanmao.ai/go") ? "懒猫 AI 站方中转链接" : null,
      rawRef: e.id,
      // 分类第 2 层原生字段：goals（含 api→API、含 code 不含 api→开发工具）
      rawGoals: Array.isArray(e.goals) ? e.goals : undefined,
    });
  }
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  if (posts.length === 0) round.error = "懒猫 AI feed 未解析到可用条目";
  return { posts, round, seenIds };
}

// ------------------------------------------------------------- AIHot Token 羊毛

// aihot.news/free-tokens 是 React Router 单页应用，数据在页面内嵌的流式载荷里：
// streamController.enqueue("...") 的字符串参数两次 JSON 解码后得到扁平数组 data；
// 字符串 "deals" 的下一个元素是记录下标列表；每条记录是 data[下标] 上的
// {"_K": V} 字典：键名 = data[int(K[1:])]，值 V>=0 时取 data[V]，V==-5 为 null，
// 嵌套列表/字典按同样规则递归解析。
function decodeAihotData(html: string): unknown[] | null {
  const marker = "streamController.enqueue(";
  let from = 0;
  for (;;) {
    const at = html.indexOf(marker, from);
    if (at < 0) return null;
    let i = at + marker.length;
    while (i < html.length && /\s/.test(html[i] ?? "")) i += 1;
    if (html[i] !== '"') return null;
    // 扫描 JSON 字符串字面量（处理转义），取出完整字面量后交给 JSON.parse
    let j = i + 1;
    while (j < html.length) {
      const ch = html[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === '"') break;
      j += 1;
    }
    if (j >= html.length) return null;
    try {
      const once = JSON.parse(html.slice(i, j + 1)) as unknown;
      if (typeof once !== "string") return null;
      const twice = JSON.parse(once) as unknown;
      if (Array.isArray(twice) && twice.includes("deals")) return twice;
    } catch {
      // 本段不是目标载荷，继续找下一处 enqueue
    }
    from = j + 1;
  }
}

function resolveAihot(data: unknown[], value: unknown, depth: number): unknown {
  if (depth > 24) return null;
  if (typeof value === "number") {
    if (value === -5) return null;
    if (value >= 0) {
      const target = data[value];
      return target === value ? target : resolveAihot(data, target, depth + 1);
    }
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveAihot(data, v, depth + 1));
  }
  if (value != null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      let key = k;
      if (k.startsWith("_")) {
        const idx = Number(k.slice(1));
        const name = Number.isInteger(idx) ? data[idx] : undefined;
        if (typeof name !== "string") continue;
        key = name;
      }
      out[key] = resolveAihot(data, v, depth + 1);
    }
    return out;
  }
  return value;
}

interface AihotRecord {
  id?: unknown;
  title?: unknown;
  detail?: unknown;
  url?: unknown;
  label?: unknown;
  verifiedAt?: unknown;
  provider?: unknown;
  note?: unknown;
  appliesTo?: unknown;
  endsAt?: unknown;
  validity?: unknown;
  realName?: unknown;
  clientOnly?: unknown;
  desktopOnly?: unknown;
  studentOnly?: unknown;
  autoRenews?: unknown;
}

const aihotStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 毫秒 → 北京时间日期字符串 YYYY-MM-DD（来源核实日期展示用） */
function shanghaiDateStr(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

async function fetchAihot(nowMs: number): Promise<CatalogFetch> {
  const round = emptyRound();
  let html: string;
  try {
    const r = await fetchText("https://aihot.news/free-tokens");
    if (!r.ok) {
      round.status = "failed";
      round.error = `AIHot 页面 HTTP ${r.status}`;
      return { posts: [], round, seenIds: null };
    }
    html = r.body;
  } catch (e) {
    round.status = "failed";
    round.error = `AIHot: ${e instanceof Error ? e.message : String(e)}`;
    return { posts: [], round, seenIds: null };
  }
  const data = decodeAihotData(html);
  if (!data) {
    round.status = "failed";
    round.error = "AIHot 页面未找到可解码的内嵌数据载荷";
    return { posts: [], round, seenIds: null };
  }
  const dealsAt = data.indexOf("deals");
  const indexList = dealsAt >= 0 ? data[dealsAt + 1] : null;
  if (!Array.isArray(indexList)) {
    round.status = "failed";
    round.error = "AIHot 内嵌数据缺少 deals 记录列表";
    return { posts: [], round, seenIds: null };
  }
  const seenIds = new Set<string>();
  const posts: RawPost[] = [];
  for (const idx of indexList) {
    if (typeof idx !== "number") continue;
    const rec = resolveAihot(data, data[idx], 0) as AihotRecord | null;
    if (!rec || typeof rec !== "object") continue;
    const id = typeof rec.id === "string" ? rec.id : null;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!id || !title || !/^https:\/\//.test(url)) continue;
    seenIds.add(id);
    const ms = typeof rec.verifiedAt === "string" ? Date.parse(rec.verifiedAt) : NaN;
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    const label = typeof rec.label === "string" ? rec.label : "";
    const detail = typeof rec.detail === "string" ? rec.detail : "";
    // 结构化字段（来源原生）：detail/note/realName/clientOnly/desktopOnly/
    // endsAt/verifiedAt/url（官方直链）。kind 是节奏不是主题分类，不参与分类。
    const condParts: string[] = [];
    if (rec.realName === true) condParts.push("需实名认证");
    if (rec.clientOnly === true) condParts.push("仅限客户端内使用");
    if (rec.desktopOnly === true) condParts.push("桌面端限定");
    if (rec.studentOnly === true) condParts.push("限学生用户");
    if (rec.autoRenews === true) condParts.push("到期自动续费");
    const endsMs = typeof rec.endsAt === "string" ? Date.parse(rec.endsAt) : NaN;
    posts.push({
      source: "aihot",
      externalId: id,
      title,
      summary: [label, detail].filter(Boolean).join(" · ").slice(0, 400),
      url,
      // verifiedAt 带毫秒的 ISO 时间 → exact
      publishedAtMs: ms,
      timeQuality: "exact",
      quota: aihotStr(rec.appliesTo) || aihotStr(rec.note) || label || null,
      vendor: aihotStr(rec.provider) || null,
      conditions:
        condParts.length > 0 ? condParts.join("；") : detail || null,
      deadlineMs: Number.isFinite(endsMs) ? endsMs : null,
      // 无绝对到期时保留相对有效期原文（如「首次使用起 5 天」）
      deadlineText: Number.isFinite(endsMs) ? null : aihotStr(rec.validity) || null,
      lastVerified: shanghaiDateStr(ms),
      claimUrl: url,
      rawRef: id,
    });
  }
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  if (posts.length === 0) round.error = "AIHot deals 未解析到可用条目";
  return { posts, round, seenIds };
}

// ------------------------------------------------------------- 赛博鸡蛋

function xmlField(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!m) return "";
  let v = (m[1] ?? "").trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(v);
  if (cdata) v = cdata[1] ?? "";
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function xmlFields(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    let v = (m[1] ?? "").trim();
    const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(v);
    if (cdata) v = cdata[1] ?? "";
    out.push(v.trim());
  }
  return out;
}

async function fetchJidan(): Promise<CatalogFetch> {
  const round = emptyRound();
  let xml: string;
  try {
    const r = await fetchText("https://jidan.si/rss.xml");
    if (!r.ok) {
      round.status = "failed";
      round.error = `赛博鸡蛋 RSS HTTP ${r.status}`;
      return { posts: [], round, seenIds: null };
    }
    xml = r.body;
  } catch (e) {
    round.status = "failed";
    round.error = `赛博鸡蛋: ${e instanceof Error ? e.message : String(e)}`;
    return { posts: [], round, seenIds: null };
  }
  const seenIds = new Set<string>();
  const posts: RawPost[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1] ?? "";
    // 只收免费类分类，排除“付费折扣”
    const categories = xmlFields(block, "category");
    if (!categories.some((c) => JIDAN_CATEGORIES.includes(c))) continue;
    const guid = xmlField(block, "guid");
    const link = xmlField(block, "link");
    const title = xmlField(block, "title");
    const externalId = guid || link;
    if (!externalId || !title || !link) continue;
    seenIds.add(externalId);
    const ms = Date.parse(xmlField(block, "pubDate"));
    if (!Number.isFinite(ms)) continue;
    posts.push({
      source: "jidan",
      externalId,
      title,
      summary: stripTags(xmlField(block, "description")).slice(0, 400),
      url: link,
      publishedAtMs: ms,
      timeQuality: "exact",
      // 结构化字段在 description 文本内，无独立原生字段；link 是鸡蛋文章页
      // （本站链接，非官方领取入口），故 claimUrl 不填 → 界面显示「未核实」
      rawRef: externalId,
    });
  }
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  if (posts.length === 0) round.error = "赛博鸡蛋 RSS 未解析到免费类条目";
  return { posts, round, seenIds };
}

// ------------------------------------------------------------- 白嫖计

interface BaipiaojiEntry {
  slug?: string;
  name?: string;
  category?: string;
  quota?: string;
  checked?: string;
  page?: string;
}
async function fetchBaipiaoji(): Promise<CatalogFetch> {
  const round = emptyRound();
  let tools: BaipiaojiEntry[];
  try {
    const r = await fetchText("https://baipiaoji.com/limits.json");
    if (!r.ok) {
      round.status = "failed";
      round.error = `白嫖计 limits.json HTTP ${r.status}`;
      return { posts: [], round, seenIds: null };
    }
    const data = JSON.parse(r.body) as { tools?: BaipiaojiEntry[] };
    if (!Array.isArray(data.tools)) throw new Error("limits.json 缺少 tools 数组");
    tools = data.tools;
  } catch (e) {
    round.status = "failed";
    round.error = `白嫖计: ${e instanceof Error ? e.message : String(e)}`;
    return { posts: [], round, seenIds: null };
  }
  const seenIds = new Set<string>();
  const posts: RawPost[] = [];
  for (const e of tools) {
    if (!e.slug || !e.name) continue;
    seenIds.add(e.slug);
    const ms = e.checked ? Date.parse(e.checked) : NaN;
    if (!Number.isFinite(ms)) continue;
    posts.push({
      source: "baipiaoji",
      externalId: e.slug,
      title: e.name,
      summary: (e.quota ?? "").slice(0, 400),
      url: e.page || `https://baipiaoji.com/tools/${e.slug}`,
      // checked 为天级日期 → estimated
      publishedAtMs: ms,
      timeQuality: "estimated",
      // 结构化字段（来源原生）：quota 原文；checked 是来源的核查日期（多为
      // 2026-08，如实显示，绝不用抓取时间冒充）；page 是本站详情页（即帖子
      // 链接本身）、source 是文字说明非链接，故 claimUrl 不填 → 显示「未核实」
      quota: e.quota ?? null,
      lastVerified: e.checked ?? null,
      rawRef: e.slug,
      // 分类第 2 层原生字段：category（api→API、coding/agent/local→开发工具、其余→应用试用）
      rawCategory: e.category ?? null,
    });
  }
  round.fetched = posts.length;
  round.status = posts.length > 0 ? "ok" : "empty";
  if (posts.length === 0) round.error = "白嫖计 limits.json 未解析到可用条目";
  return { posts, round, seenIds };
}

// ------------------------------------------------------------- 流水线

/** §9 时间质量等级：estimated 不得覆盖 exact/verified/snowflake/relative */
const TIME_QUALITY_RANK: Record<string, number> = {
  estimated: 0,
  relative: 1,
  exact: 2,
  snowflake: 2,
  verified: 3,
};
const TIME_QUALITIES = ["exact", "relative", "snowflake", "verified", "estimated"];

async function runBatch(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  const CHUNK = 40;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK);
    const [first, ...rest] = chunk;
    if (first) await db.batch([first, ...rest]);
  }
}

export async function runRefresh(ctx: Ctx, trigger: "manual" | "cron"): Promise<RefreshResult> {
  const db = ctx.db<typeof schema>();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs);
  const notes: string[] = [];
  const perSource: Record<string, SourceRound> = {
    linuxdo: emptyRound(),
    v2ex: emptyRound(),
    nodeseek: emptyRound(),
    x: emptyRound(),
    threads: emptyRound(),
    sliverkiss: emptyRound(),
    lanmao: emptyRound(),
    aihot: emptyRound(),
    jidan: emptyRound(),
    baipiaoji: emptyRound(),
  };

  // §12 互斥锁：meta 表 refresh_lock 存开始时间；10 分钟内的锁视为仍在运行
  const lockRows = await db.select().from(schema.meta).where(eq(schema.meta.key, "refresh_lock"));
  const lockVal = lockRows[0]?.value;
  if (lockVal && startedMs - Number(lockVal) < 10 * 60 * 1000) {
    return {
      status: "already_running",
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      totalPosts: 0,
      perSource,
      timeQualityCounts: {},
      expiredRemoved: 0,
      delistedRemoved: 0,
      trimmed: 0,
      verified: 0,
      notes: ["已有刷新在运行，本轮跳过"],
    };
  }
  await db
    .insert(schema.meta)
    .values({ key: "refresh_lock", value: String(startedMs) })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(startedMs) } });

  const timedOut = () => Date.now() - startedMs > CONFIG.refreshTimeoutMs;

  try {
    // ---- 1) 抓取（顺序执行 + 间隔限速；单来源失败不影响其他来源）
    const fetched: RawPost[] = [];
    const v2ex = await fetchV2ex();
    perSource.v2ex = v2ex.round;
    fetched.push(...v2ex.posts);
    await sleep(CONFIG.requestGapMs);

    const ldo = await fetchLinuxDo();
    perSource.linuxdo = ldo.round;
    fetched.push(...ldo.posts);
    await sleep(CONFIG.requestGapMs);

    const ns = await fetchNodeSeek(startedMs);
    perSource.nodeseek = ns.round;
    fetched.push(...ns.posts);
    await sleep(CONFIG.requestGapMs);

    const xr = await fetchX(ctx, startedMs);
    perSource.x = xr.round;
    fetched.push(...xr.posts);
    await sleep(CONFIG.requestGapMs);

    const th = await fetchThreads();
    perSource.threads = th.round;
    fetched.push(...th.posts);
    await sleep(CONFIG.requestGapMs);

    const sk = await fetchSliverkiss();
    perSource.sliverkiss = sk.round;
    fetched.push(...sk.posts);
    await sleep(CONFIG.requestGapMs);

    // 目录类来源：抓取成功时记录当前列表全集，供入库后对账下架
    const catalogSeen = new Map<SourceId, Set<string>>();
    const lm = await fetchLanmao();
    perSource.lanmao = lm.round;
    fetched.push(...lm.posts);
    if (lm.seenIds) catalogSeen.set("lanmao", lm.seenIds);
    await sleep(CONFIG.requestGapMs);

    const ah = await fetchAihot(startedMs);
    perSource.aihot = ah.round;
    fetched.push(...ah.posts);
    if (ah.seenIds) catalogSeen.set("aihot", ah.seenIds);
    await sleep(CONFIG.requestGapMs);

    const jd = await fetchJidan();
    perSource.jidan = jd.round;
    fetched.push(...jd.posts);
    if (jd.seenIds) catalogSeen.set("jidan", jd.seenIds);
    await sleep(CONFIG.requestGapMs);

    const bp = await fetchBaipiaoji();
    perSource.baipiaoji = bp.round;
    fetched.push(...bp.posts);
    if (bp.seenIds) catalogSeen.set("baipiaoji", bp.seenIds);

    // ---- 2) LINUX DO 无日期帖：同来源真实日期锚点插值（§8）
    const existing = await db.select().from(schema.posts);
    const anchors: Anchor[] = [];
    for (const p of fetched) {
      if (p.source === "linuxdo" && p.publishedAtMs != null && p.timeQuality !== "estimated") {
        anchors.push({ id: Number(p.externalId), timeMs: p.publishedAtMs });
      }
    }
    for (const p of existing) {
      if (
        p.source === "linuxdo" &&
        (p.timeQuality === "exact" || p.timeQuality === "relative" || p.timeQuality === "verified")
      ) {
        anchors.push({ id: Number(p.externalId), timeMs: p.publishedAt.getTime() });
      }
    }
    const normalized: RawPost[] = [];
    for (const p of fetched) {
      if (p.publishedAtMs != null) {
        normalized.push(p);
        continue;
      }
      if (p.source === "linuxdo") {
        const est = interpolateById(Number(p.externalId), anchors, startedMs);
        if (est == null) {
          notes.push(`LINUX DO 主题 ${p.externalId} 无足够真实日期锚点，未收录`);
          continue;
        }
        normalized.push({ ...p, publishedAtMs: est, timeQuality: "estimated" });
      } else {
        // 其他来源拿不到任何时间线索：不收录（绝不用抓取时间冒充发布时间）
        notes.push(`${p.source} 帖子 ${p.externalId} 无发布时间线索，未收录`);
      }
    }

    // ---- 3) 过滤 → 分类打标 → 阈值（§3/§4/§5）+ 主题分类（雷达 v2，ingest 时算出存入）
    interface Scored extends RawPost {
      publishedAtMs: number;
      qualityScore: number;
      tags: string[];
      keywordIds: string[];
      gatewayIds: string[];
      isTutorial: boolean;
      category: string;
    }
    const scored: Scored[] = [];
    for (const p of normalized) {
      const round = perSource[p.source] ?? emptyRound();
      if (isFiltered(p.title)) {
        round.filtered += 1;
        continue;
      }
      // 不收录名单（Crouton Alpha：免费预览已结束，不作在售免费额度收录）
      if (EXCLUDED_TITLE_RE.test(p.title) || EXCLUDED_TITLE_RE.test(p.externalId)) {
        round.filtered += 1;
        notes.push(`不收录名单剔除: [${p.source}] ${p.externalId}`);
        continue;
      }
      const c = classify(p.source, p.title, p.summary);
      if (!c.passesThreshold) {
        round.filtered += 1;
        continue;
      }
      scored.push({
        ...p,
        publishedAtMs: p.publishedAtMs as number,
        qualityScore: c.qualityScore,
        tags: c.tags,
        keywordIds: c.keywordIds,
        gatewayIds: c.gatewayIds,
        isTutorial: c.isTutorial,
        category: classifyCategory(p.title, p),
      });
    }

    // ---- 4) 按 (来源, 外部ID) 去重入库（§9 upsert）
    const fetchedDate = new Date(startedMs);
    const upserts: BatchItem<"sqlite">[] = scored.map((p) =>
      db
        .insert(schema.posts)
        .values({
          source: p.source,
          externalId: p.externalId,
          title: p.title,
          summary: p.summary,
          url: p.url,
          publishedAt: new Date(p.publishedAtMs),
          timeQuality: p.timeQuality,
          fetchedAt: fetchedDate,
          qualityScore: p.qualityScore,
          isTutorial: p.isTutorial,
          tags: JSON.stringify(p.tags),
          keywordIds: JSON.stringify(p.keywordIds),
          gatewayIds: JSON.stringify(p.gatewayIds),
          category: p.category,
          quota: p.quota ?? null,
          claimUrl: p.claimUrl ?? null,
          claimNote: p.claimNote ?? null,
          deadline: p.deadlineMs != null ? new Date(p.deadlineMs) : null,
          deadlineText: p.deadlineText ?? null,
          region: p.region ?? null,
          lastVerified: p.lastVerified ?? null,
          conditions: p.conditions ?? null,
          costNote: p.costNote ?? null,
          riskNote: p.riskNote ?? null,
          rawRef: p.rawRef ?? null,
          vendor: p.vendor ?? null,
        })
        .onConflictDoUpdate({
          target: [schema.posts.source, schema.posts.externalId],
          set: {
            title: p.title,
            summary: p.summary,
            url: p.url,
            qualityScore: p.qualityScore,
            isTutorial: p.isTutorial,
            tags: JSON.stringify(p.tags),
            keywordIds: JSON.stringify(p.keywordIds),
            gatewayIds: JSON.stringify(p.gatewayIds),
            category: p.category,
            quota: p.quota ?? null,
            claimUrl: p.claimUrl ?? null,
            claimNote: p.claimNote ?? null,
            deadline: p.deadlineMs != null ? new Date(p.deadlineMs) : null,
            deadlineText: p.deadlineText ?? null,
            region: p.region ?? null,
            lastVerified: p.lastVerified ?? null,
            conditions: p.conditions ?? null,
            costNote: p.costNote ?? null,
            riskNote: p.riskNote ?? null,
            rawRef: p.rawRef ?? null,
            vendor: p.vendor ?? null,
            // 发布时间单独处理（见下方保护规则），此处不覆盖
          },
        }),
    );
    await runBatch(db, upserts);

    // §9 时间保护：仅当新时间质量不低于已存时才更新 published_at；
    // estimated 不得覆盖 exact/verified/snowflake/relative。
    const qualityRank: Record<string, number> = {
      estimated: 0,
      relative: 1,
      exact: 2,
      snowflake: 2,
      verified: 3,
    };
    const timeUpdates: BatchItem<"sqlite">[] = [];
    for (const p of scored) {
      const round = perSource[p.source] ?? emptyRound();
      round.kept += 1;
      const old = existing.find((e) => e.source === p.source && e.externalId === p.externalId);
      if (!old) continue;
      const oldRank = qualityRank[old.timeQuality] ?? 0;
      const newRank = qualityRank[p.timeQuality] ?? 0;
      if (newRank >= oldRank && old.publishedAt.getTime() !== p.publishedAtMs) {
        timeUpdates.push(
          db
            .update(schema.posts)
            .set({ publishedAt: new Date(p.publishedAtMs), timeQuality: p.timeQuality })
            .where(
              and(eq(schema.posts.source, p.source), eq(schema.posts.externalId, p.externalId)),
            ),
        );
      }
    }
    await runBatch(db, timeUpdates);

    // ---- 5) 用当前词表对库内已存帖重分类/重打分/重套过滤与阈值（§2）
    let all = await db.select().from(schema.posts);
    const reclassStmts: BatchItem<"sqlite">[] = [];
    for (const row of all) {
      if (isFiltered(row.title) || EXCLUDED_TITLE_RE.test(row.title)) {
        reclassStmts.push(db.delete(schema.posts).where(eq(schema.posts.id, row.id)));
        notes.push(`重分类移除（过滤）: [${row.source}] ${row.externalId}`);
        continue;
      }
      const c = classify(row.source as SourceId, row.title, row.summary);
      // 目录类来源不因阈值移除：它们的去留由来源列表对账（下架同步）决定
      if (!c.passesThreshold && !CATALOG_SOURCES.includes(row.source as SourceId)) {
        reclassStmts.push(db.delete(schema.posts).where(eq(schema.posts.id, row.id)));
        notes.push(`重分类移除（阈值）: [${row.source}] ${row.externalId}`);
        continue;
      }
      reclassStmts.push(
        db
          .update(schema.posts)
          .set({
            qualityScore: c.qualityScore,
            isTutorial: c.isTutorial,
            tags: JSON.stringify(c.tags),
            keywordIds: JSON.stringify(c.keywordIds),
            gatewayIds: JSON.stringify(c.gatewayIds),
            // 主题分类：目录条目的分类在 ingest 时已由原生字段算出并存入，
            // 库内行拿不到原生字段，重分类时保留已存值不覆盖；非目录条目按标题层重算
            category: CATALOG_SOURCES.includes(row.source as SourceId)
              ? row.category
              : classifyCategory(row.title),
          })
          .where(eq(schema.posts.id, row.id)),
      );
    }
    await runBatch(db, reclassStmts);
    all = await db.select().from(schema.posts);

    // ---- 5.5) 人工核实回填（overrides.ts）：按 (来源, 外部ID) 套用已核实
    // 结构化字段；只改字段，不动 published_at / time_quality。
    const overrideStmts: BatchItem<"sqlite">[] = [];
    for (const o of POST_OVERRIDES) {
      const row = all.find((r) => r.source === o.source && r.externalId === o.externalId);
      if (!row) continue;
      overrideStmts.push(
        db
          .update(schema.posts)
          .set({
            quota: o.quota !== undefined ? o.quota : row.quota,
            claimUrl: o.claimUrl !== undefined ? o.claimUrl : row.claimUrl,
            claimNote: o.claimNote !== undefined ? o.claimNote : row.claimNote,
            deadline:
              o.deadlineMs !== undefined
                ? o.deadlineMs != null
                  ? new Date(o.deadlineMs)
                  : null
                : row.deadline,
            deadlineText: o.deadlineText !== undefined ? o.deadlineText : row.deadlineText,
            region: o.region !== undefined ? o.region : row.region,
            lastVerified: o.lastVerified !== undefined ? o.lastVerified : row.lastVerified,
            conditions: o.conditions !== undefined ? o.conditions : row.conditions,
            costNote: o.costNote !== undefined ? o.costNote : row.costNote,
            riskNote: o.riskNote !== undefined ? o.riskNote : row.riskNote,
            rawRef: o.rawRef !== undefined ? o.rawRef : row.rawRef,
          })
          .where(eq(schema.posts.id, row.id)),
      );
    }
    if (overrideStmts.length > 0) {
      await runBatch(db, overrideStmts);
      all = await db.select().from(schema.posts);
    }

    // ---- 5.6) 七项评分回填（仅目录四站）：用确定性规则对全部目录帖重算
    // 分数（新帖入库即算、旧帖每轮补算/刷新紧迫性）；只写 scor* 列，
    // 绝不触碰核实覆盖层（verified_*）、标题/额度/简介覆盖
    // （title_override / quota_override / summary_override）与来源字段。
    // risk / usefulness / audience 三项：先从库内已存 scores 读出核实轮次
    // 写入的值，作为 preserved 传给 computeScores 原样保留——核实分数一旦
    // 写入，刷新绝不用规则覆盖；仍为 null 的维度规则也只能保持 null。
    // 其余四项（额度/紧迫性/领取难度/来源可信度）每轮按规则重算。
    const scoreNow = Date.now();
    const scoreStmts: BatchItem<"sqlite">[] = [];
    for (const row of all) {
      if (!CATALOG_SOURCES.includes(row.source as SourceId)) continue;
      let preserved: { risk: number | null; usefulness: number | null; audience: number | null } = {
        risk: null,
        usefulness: null,
        audience: null,
      };
      if (row.scores) {
        try {
          const prev = JSON.parse(row.scores) as Record<string, unknown>;
          const num = (v: unknown): number | null =>
            typeof v === "number" && Number.isFinite(v) ? v : null;
          preserved = {
            risk: num(prev.risk),
            usefulness: num(prev.usefulness),
            audience: num(prev.audience),
          };
        } catch {
          // scores 损坏时按无核实分数处理（四项规则维度照常重算）
        }
      }
      const r = computeScores(
        {
          quota: row.quota,
          conditions: row.conditions,
          deadlineMs: row.deadline?.getTime() ?? null,
          deadlineText: row.deadlineText,
          claimUrl: row.claimUrl,
          claimNote: row.claimNote,
          url: row.url,
          lastVerified: row.lastVerified,
        },
        scoreNow,
        preserved,
      );
      scoreStmts.push(
        db
          .update(schema.posts)
          .set({
            scores: JSON.stringify(r.scores),
            scoreTotal: r.total,
            scoreCoverage: r.coverage,
          })
          .where(eq(schema.posts.id, row.id)),
      );
    }
    if (scoreStmts.length > 0) {
      await runBatch(db, scoreStmts);
      notes.push(`七项评分回填 ${scoreStmts.length} 条目录帖`);
    }

    // ---- 6) 时间核验（§8：每轮最多 6 条，estimated 且综合排名靠前者优先）
    let verifiedCount = 0;
    const verifyLagHours: Partial<Record<SourceId, number>> = {};
    if (!timedOut()) {
      const now = Date.now();
      const candidates = all
        .filter((r) => r.timeQuality === "estimated")
        .map((r) => ({
          row: r,
          rank: compositeScore(
            r.qualityScore,
            r.publishedAt.getTime(),
            r.isTutorial,
            "estimated",
            r.isRead,
            now,
          ),
        }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, CONFIG.verifyPerRound);
      for (const { row } of candidates) {
        try {
          const res = await ctx.tool.web_search(row.title);
          const match = res.content.results.find(
            (it) =>
              it.url != null &&
              (it.url.replace(/[?#].*$/, "").replace(/\/$/, "") ===
                row.url.replace(/[?#].*$/, "").replace(/\/$/, "") ||
                it.url.includes(`/${row.externalId}`) ||
                it.url.includes(`-${row.externalId}`) ||
                it.url.includes(`topic/${row.externalId}`)),
          );
          if (match?.published_at) {
            const parsed = Date.parse(match.published_at);
            if (Number.isFinite(parsed) && parsed <= Date.now()) {
              const diffHours = Math.abs(parsed - row.publishedAt.getTime()) / 3600000;
              await db
                .update(schema.posts)
                .set({ publishedAt: new Date(parsed), timeQuality: "verified" })
                .where(eq(schema.posts.id, row.id));
              verifiedCount += 1;
              if (diffHours > CONFIG.lagThresholdHours) {
                notes.push(
                  `核验滞后: [${row.source}] ${row.externalId} 核验时间与估算相差 ${Math.floor(diffHours)} 小时`,
                );
                const srcId = row.source as SourceId;
                verifyLagHours[srcId] = Math.max(
                  verifyLagHours[srcId] ?? 0,
                  Math.floor(diffHours),
                );
              }
            }
          }
        } catch {
          // 核验失败不影响主流程
        }
        await sleep(CONFIG.requestGapMs);
      }
    }
    if (verifiedCount > 0) {
      all = await db.select().from(schema.posts);
    }

    // ---- 6.5) 目录类下架同步：本轮抓取成功时，库内条目若已不在来源当前
    // 列表中，视为来源方已下架 → 删除（目录来源不走过期窗口，靠对账维护时效）
    let delistedRemoved = 0;
    if (catalogSeen.size > 0) {
      const delistedIds: number[] = [];
      for (const row of all) {
        const seen = catalogSeen.get(row.source as SourceId);
        // 人工核实回填条目豁免对账删除（鸡蛋 RSS 滚动窗口滚出 ≠ 下架）
        if (seen && !seen.has(row.externalId) && !OVERRIDE_KEYS.has(`${row.source}:${row.externalId}`)) {
          delistedIds.push(row.id);
        }
      }
      if (delistedIds.length > 0) {
        await db.delete(schema.posts).where(inArray(schema.posts.id, delistedIds));
        delistedRemoved = delistedIds.length;
        all = all.filter((r) => !delistedIds.includes(r.id));
        notes.push(`目录下架同步删除 ${delistedRemoved} 条（已不在来源当前列表中）`);
      }
    }

    // ---- 7) 清过期（§6/§7；目录类来源豁免保留窗口，由 6.5 对账维护；
    // 但有绝对到期日且已过期的条目全来源一律下线，相对有效期无法算绝对日期不在此列）
    const nowAfter = Date.now();
    const expiredIds = all
      .filter(
        (r) =>
          (r.deadline != null && r.deadline.getTime() < nowAfter) ||
          (!CATALOG_SOURCES.includes(r.source as SourceId) &&
            isExpired(r.publishedAt.getTime(), r.isTutorial, nowAfter)),
      )
      .map((r) => r.id);
    if (expiredIds.length > 0) {
      await db.delete(schema.posts).where(inArray(schema.posts.id, expiredIds));
      all = all.filter((r) => !expiredIds.includes(r.id));
    }

    // ---- 8) 综合排名 + 总数 >CONFIG.maxPosts 只裁最低溢出（§7）
    let trimmed = 0;
    if (all.length > CONFIG.maxPosts) {
      const ranked = all
        .map((r) => ({
          id: r.id,
          rank: compositeScore(
            r.qualityScore,
            r.publishedAt.getTime(),
            r.isTutorial,
            r.timeQuality as TimeQuality,
            r.isRead,
            nowAfter,
          ),
          publishedMs: r.publishedAt.getTime(),
          externalId: r.externalId,
        }))
        .sort((a, b) => a.rank - b.rank || a.publishedMs - b.publishedMs || a.externalId.localeCompare(b.externalId));
      const overflow = ranked.slice(0, all.length - CONFIG.maxPosts).map((r) => r.id);
      await db.delete(schema.posts).where(inArray(schema.posts.id, overflow));
      trimmed = overflow.length;
      all = all.filter((r) => !overflow.includes(r.id));
    }

    // ---- 9) 来源状态 + 滞后计算（§8/§12）
    const statusStmts: BatchItem<"sqlite">[] = [];
    for (const src of Object.keys(perSource) as SourceId[]) {
      const round = perSource[src] ?? emptyRound();
      const srcPosts = all.filter((r) => r.source === src);
      const latestMs =
        srcPosts.length > 0
          ? Math.max(...srcPosts.map((r) => r.publishedAt.getTime()))
          : null;
      const lagLatest = lagHoursForLatest(latestMs, nowAfter);
      const lagVerify = verifyLagHours[src] ?? null;
      const lag =
        lagLatest != null || lagVerify != null
          ? Math.max(lagLatest ?? 0, lagVerify ?? 0)
          : null;
      if (lagLatest != null) {
        notes.push(`来源滞后: ${src} 最新帖子距今 ${lagLatest} 小时`);
      }
      const prevRows = await db
        .select()
        .from(schema.sourceStatus)
        .where(eq(schema.sourceStatus.source, src));
      const prev = prevRows[0];
      statusStmts.push(
        db
          .insert(schema.sourceStatus)
          .values({
            source: src,
            status: round.status,
            lastAttemptAt: new Date(startedMs),
            lastSuccessAt: round.status === "failed" ? (prev?.lastSuccessAt ?? null) : new Date(startedMs),
            fetchedCount: round.fetched,
            error: round.error,
            lagHours: lag,
          })
          .onConflictDoUpdate({
            target: schema.sourceStatus.source,
            set: {
              status: round.status,
              lastAttemptAt: new Date(startedMs),
              lastSuccessAt: round.status === "failed" ? (prev?.lastSuccessAt ?? null) : new Date(startedMs),
              fetchedCount: round.fetched,
              error: round.error,
              lagHours: lag,
            },
          }),
      );
    }
    await runBatch(db, statusStmts);

    // ---- 10) 刷新日志（§12）
    const tqCounts: Record<string, number> = {};
    for (const r of all) tqCounts[r.timeQuality] = (tqCounts[r.timeQuality] ?? 0) + 1;
    const finishedMs = Date.now();
    await db.insert(schema.refreshLogs).values({
      startedAt,
      finishedAt: new Date(finishedMs),
      trigger,
      detail: JSON.stringify({
        perSource,
        timeQualityCounts: tqCounts,
        expiredRemoved: expiredIds.length,
        delistedRemoved,
        trimmed,
        verified: verifiedCount,
        totalPosts: all.length,
        notes,
        timedOut: timedOut(),
      }),
    });

    return {
      status: timedOut() ? "timeout" : "ok",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(finishedMs).toISOString(),
      totalPosts: all.length,
      perSource,
      timeQualityCounts: tqCounts,
      expiredRemoved: expiredIds.length,
      delistedRemoved,
      trimmed,
      verified: verifiedCount,
      notes,
    };
  } finally {
    await db.delete(schema.meta).where(eq(schema.meta.key, "refresh_lock"));
  }
}

// ------------------------------------------------------------- ingestPosts
// 供主代理把人工/浏览器实测抓到的真实帖子推进库。入库前走与刷新完全相同的
// §3 过滤、§4/§5 分类打分（含 LINUX DO 相关性门）、§6 保留窗口、§9 去重 upsert；
// 缺 publishedAt/url 的条目拒绝；NodeSeek/X 的条目一律拒绝（未核实，
// 这两个来源只能由刷新流水线按各自严格规则收录）。

export interface IngestItemInput {
  source: string;
  externalId: string;
  title: string;
  url: string;
  publishedAt: string;
  timeQuality: string;
  summary?: string;
}

export interface IngestResult {
  status: "ok" | "already_running";
  accepted: number;
  rejected: { externalId: string; reason: string }[];
  totalPosts: number;
}

export async function runIngest(ctx: Ctx, items: IngestItemInput[]): Promise<IngestResult> {
  const db = ctx.db<typeof schema>();
  const nowMs = Date.now();
  const rejected: { externalId: string; reason: string }[] = [];

  // 与刷新共用互斥锁，避免与定时刷新并发写库
  const lockRows = await db.select().from(schema.meta).where(eq(schema.meta.key, "refresh_lock"));
  const lockVal = lockRows[0]?.value;
  if (lockVal && nowMs - Number(lockVal) < 10 * 60 * 1000) {
    return { status: "already_running", accepted: 0, rejected, totalPosts: 0 };
  }
  await db
    .insert(schema.meta)
    .values({ key: "refresh_lock", value: String(nowMs) })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(nowMs) } });

  try {
    const validSources = new Set<string>(["linuxdo", "v2ex", "nodeseek", "x", "threads"]);
    interface Accepted extends RawPost {
      publishedAtMs: number;
      qualityScore: number;
      tags: string[];
      keywordIds: string[];
      gatewayIds: string[];
      isTutorial: boolean;
      category: string;
    }
    const accepted: Accepted[] = [];
    for (const item of items) {
      const extId = (item.externalId ?? "").trim();
      const reject = (reason: string) => rejected.push({ externalId: extId || "(无ID)", reason });
      if (!validSources.has(item.source)) {
        reject(`未知来源 ${item.source}`);
        continue;
      }
      if (item.source === "nodeseek" || item.source === "x") {
        reject("NodeSeek/X 条目未经核实，ingestPosts 不收（仅刷新流水线可收录）");
        continue;
      }
      if (!extId) {
        reject("缺少 externalId");
        continue;
      }
      const title = (item.title ?? "").trim();
      if (!title) {
        reject("缺少标题");
        continue;
      }
      const url = (item.url ?? "").trim();
      if (!url || !/^https:\/\//.test(url)) {
        reject("缺少 url 或 url 不是 https 链接");
        continue;
      }
      const publishedRaw = (item.publishedAt ?? "").trim();
      const publishedMs = publishedRaw ? Date.parse(publishedRaw) : NaN;
      if (!Number.isFinite(publishedMs)) {
        reject("缺少 publishedAt 或时间不可解析");
        continue;
      }
      if (publishedMs > nowMs) {
        reject("publishedAt 晚于当前时间");
        continue;
      }
      if (!TIME_QUALITIES.includes(item.timeQuality)) {
        reject(`timeQuality 不合法：${item.timeQuality}`);
        continue;
      }
      // §3 过滤
      if (isFiltered(title)) {
        reject("被 §3 过滤规则丢弃（求购/纯求推荐）");
        continue;
      }
      // 不收录名单（Crouton Alpha 不走 ingestPosts）
      if (EXCLUDED_TITLE_RE.test(title) || EXCLUDED_TITLE_RE.test(extId)) {
        reject("在不收录名单内（Crouton Alpha 免费预览已结束）");
        continue;
      }
      // §4/§5 分类打分与阈值（含 LINUX DO 相关性门）
      const source = item.source as SourceId;
      const summary = (item.summary ?? "").slice(0, 400);
      const c = classify(source, title, summary);
      if (!c.passesThreshold) {
        reject(
          source === "linuxdo"
            ? "未通过 LINUX DO 相关性门/阈值（未命中羊毛词、重点词或 AI 网关）"
            : "未达到该来源质量分阈值",
        );
        continue;
      }
      // §6 保留窗口
      if (isExpired(publishedMs, c.isTutorial, nowMs)) {
        reject("已超过保留窗口（普通帖 7 天 / 教程 30 天）");
        continue;
      }
      accepted.push({
        source,
        externalId: extId,
        title,
        summary,
        url,
        publishedAtMs: publishedMs,
        timeQuality: item.timeQuality as TimeQuality,
        qualityScore: c.qualityScore,
        tags: c.tags,
        keywordIds: c.keywordIds,
        gatewayIds: c.gatewayIds,
        isTutorial: c.isTutorial,
        category: classifyCategory(title),
      });
    }

    // §9 去重入库：upsert 更新标题/摘要/评分，保留已读状态与首次入库时间
    const fetchedDate = new Date(nowMs);
    const existing = await db.select().from(schema.posts);
    const upserts: BatchItem<"sqlite">[] = accepted.map((p) =>
      db
        .insert(schema.posts)
        .values({
          source: p.source,
          externalId: p.externalId,
          title: p.title,
          summary: p.summary,
          url: p.url,
          publishedAt: new Date(p.publishedAtMs),
          timeQuality: p.timeQuality,
          fetchedAt: fetchedDate,
          qualityScore: p.qualityScore,
          isTutorial: p.isTutorial,
          tags: JSON.stringify(p.tags),
          keywordIds: JSON.stringify(p.keywordIds),
          gatewayIds: JSON.stringify(p.gatewayIds),
          category: p.category,
        })
        .onConflictDoUpdate({
          target: [schema.posts.source, schema.posts.externalId],
          set: {
            title: p.title,
            summary: p.summary,
            url: p.url,
            qualityScore: p.qualityScore,
            isTutorial: p.isTutorial,
            tags: JSON.stringify(p.tags),
            keywordIds: JSON.stringify(p.keywordIds),
            gatewayIds: JSON.stringify(p.gatewayIds),
            category: p.category,
          },
        }),
    );
    await runBatch(db, upserts);

    // §9 时间保护：新时间质量不低于已存时才更新 published_at
    const timeUpdates: BatchItem<"sqlite">[] = [];
    for (const p of accepted) {
      const old = existing.find((e) => e.source === p.source && e.externalId === p.externalId);
      if (!old) continue;
      const oldRank = TIME_QUALITY_RANK[old.timeQuality] ?? 0;
      const newRank = TIME_QUALITY_RANK[p.timeQuality] ?? 0;
      if (newRank >= oldRank && old.publishedAt.getTime() !== p.publishedAtMs) {
        timeUpdates.push(
          db
            .update(schema.posts)
            .set({ publishedAt: new Date(p.publishedAtMs), timeQuality: p.timeQuality })
            .where(
              and(eq(schema.posts.source, p.source), eq(schema.posts.externalId, p.externalId)),
            ),
        );
      }
    }
    await runBatch(db, timeUpdates);

    // 清过期（目录类来源豁免，与刷新同一规则）+ 总数 >CONFIG.maxPosts 裁最低
    let all = await db.select().from(schema.posts);
    const expiredIds = all
      .filter(
        (r) =>
          !CATALOG_SOURCES.includes(r.source as SourceId) &&
          isExpired(r.publishedAt.getTime(), r.isTutorial, nowMs),
      )
      .map((r) => r.id);
    if (expiredIds.length > 0) {
      await db.delete(schema.posts).where(inArray(schema.posts.id, expiredIds));
      all = all.filter((r) => !expiredIds.includes(r.id));
    }
    if (all.length > CONFIG.maxPosts) {
      const ranked = all
        .map((r) => ({
          id: r.id,
          rank: compositeScore(
            r.qualityScore,
            r.publishedAt.getTime(),
            r.isTutorial,
            r.timeQuality as TimeQuality,
            r.isRead,
            nowMs,
          ),
          publishedMs: r.publishedAt.getTime(),
          externalId: r.externalId,
        }))
        .sort((a, b) => a.rank - b.rank || a.publishedMs - b.publishedMs || a.externalId.localeCompare(b.externalId));
      const overflow = ranked.slice(0, all.length - CONFIG.maxPosts).map((r) => r.id);
      await db.delete(schema.posts).where(inArray(schema.posts.id, overflow));
      all = all.filter((r) => !overflow.includes(r.id));
    }

    // 来源状态：本轮 ingest 涉及的来源记为 ok（真实入库成功）
    const touchedSources = [...new Set(accepted.map((p) => p.source))];
    const statusStmts: BatchItem<"sqlite">[] = [];
    for (const src of touchedSources) {
      const srcPosts = all.filter((r) => r.source === src);
      const latestMs =
        srcPosts.length > 0 ? Math.max(...srcPosts.map((r) => r.publishedAt.getTime())) : null;
      const lag = lagHoursForLatest(latestMs, nowMs);
      const acceptedCount = accepted.filter((p) => p.source === src).length;
      statusStmts.push(
        db
          .insert(schema.sourceStatus)
          .values({
            source: src,
            status: "ok",
            lastAttemptAt: new Date(nowMs),
            lastSuccessAt: new Date(nowMs),
            fetchedCount: acceptedCount,
            error: null,
            lagHours: lag,
          })
          .onConflictDoUpdate({
            target: schema.sourceStatus.source,
            set: {
              status: "ok",
              lastAttemptAt: new Date(nowMs),
              lastSuccessAt: new Date(nowMs),
              fetchedCount: acceptedCount,
              error: null,
              lagHours: lag,
            },
          }),
      );
    }
    await runBatch(db, statusStmts);

    // 写日志（trigger=ingest，与刷新日志同表）
    const tqCounts: Record<string, number> = {};
    for (const r of all) tqCounts[r.timeQuality] = (tqCounts[r.timeQuality] ?? 0) + 1;
    await db.insert(schema.refreshLogs).values({
      startedAt: new Date(nowMs),
      finishedAt: new Date(),
      trigger: "ingest",
      detail: JSON.stringify({
        accepted: accepted.length,
        rejected,
        timeQualityCounts: tqCounts,
        totalPosts: all.length,
        notes: ["ingestPosts 人工实测帖子入库（走与刷新相同的过滤/打分/去重流水线）"],
      }),
    });

    return { status: "ok", accepted: accepted.length, rejected, totalPosts: all.length };
  } finally {
    await db.delete(schema.meta).where(eq(schema.meta.key, "refresh_lock"));
  }
}
