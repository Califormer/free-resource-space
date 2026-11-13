// 羊毛空间 — 确定性规则引擎（任务 §3–§10）。
// 全部为纯函数：只看标题+摘要做字面规则匹配，不做语义推断，不调用大模型。
// 词表/阈值/权重来自 config.ts。

import {
BUY_CONTAINS,
CATALOG_SOURCES,
CATEGORY_API_WORD_RE,
CATEGORY_API_WORDS,
CATEGORY_CLOUD_WORDS,
CATEGORY_COMPUTE_WORDS,
CATEGORY_DEFAULT,
CATEGORY_DEV_WORDS,
CONFIG,
type CategoryName,
GATEWAY_NORMALIZED,
GATEWAY_TOOLS,
GPT_PATTERNS,
KEYWORDS,
MAGPIE_CONTEXT,
MAGPIE_EXCLUDE,
RESIDENTIAL_PATTERNS,
SCORE_RULES,
SEEK_EXEMPT,
SEEK_PATTERNS,
TAG_RULES,
TUTORIAL_DO,
TUTORIAL_HOW,
TUTORIAL_WORDS,
WOOL_SIGNAL_WORDS,
type SourceId,
} from "./config";

export type TimeQuality = "exact" | "relative" | "snowflake" | "verified" | "estimated";

/** 抓取后、入库前的标准化帖子 */
export interface RawPost {
source: SourceId;
externalId: string;
title: string;
summary: string;
url: string;
/** 毫秒 epoch；LINUX DO 无日期时为 null，等待插值 */
publishedAtMs: number | null;
timeQuality: TimeQuality;
/** 结构化字段（免费额度雷达）：仅目录类来源在抓取时从原生字段填充，
 * 论坛类来源一律不填（null/undefined），界面不渲染其结构化明细 */
quota?: string | null;
claimUrl?: string | null;
claimNote?: string | null;
deadlineMs?: number | null;
deadlineText?: string | null;
region?: string | null;
lastVerified?: string | null;
conditions?: string | null;
costNote?: string | null;
riskNote?: string | null;
rawRef?: string | null;
vendor?: string | null;
/** 分类第 2 层用的来源原生字段（仅抓取时有，存库后不再保留） */
rawCategory?: string | null;
rawGoals?: string[];
}

/** 分类打标结果 */
export interface Classification {
qualityScore: number;
tags: string[];
keywordIds: string[];
gatewayIds: string[];
isTutorial: boolean;
passesThreshold: boolean;
}

const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------- §3 过滤

/** §3.1 求购过滤（字面规则，命中即丢弃） */
export function isBuyRequest(title: string): boolean {
// 去掉标题开头的空白与括号后以“收”开头（含 [收] 形式，括号会被剥掉）
const stripped = title.replace(/^[\s\[\]()（）]+/u, "");
if (stripped.startsWith("收")) return true;
for (const w of BUY_CONTAINS) {
if (title.includes(w)) return true;
}
// 价格表达与“收”相邻出现，如 “30元收” / “收 $20” / “收100u”
if (/(?:\d+(?:\.\d+)?\s*(?:元|u|块|刀)|[$￥¥]\s*\d+(?:\.\d+)?)\s*收/.test(title)) return true;
if (/收\s*(?:\d+(?:\.\d+)?\s*(?:元|u|块|刀)|[$￥¥]\s*\d+(?:\.\d+)?)/.test(title)) return true;
// 不带货币单位的纯数字紧挨“收”也算求购，如 “1000收” / “500收…”
if (/\d+\s*收/.test(title)) return true;
if (/收\s*\d+/.test(title)) return true;
return false;
}

/** §3.2 纯求推荐/求助过滤；含 how-to/攻略豁免词一律保留（豁免优先） */
export function isPureSeek(title: string): boolean {
if (SEEK_EXEMPT.test(title)) return false;
const stripped = title.replace(/^[\s\[\]()（）]+/u, "");
return SEEK_PATTERNS.some((re) => re.test(title) || re.test(stripped));
}

/** §3 总过滤：true = 丢弃 */
export function isFiltered(title: string): boolean {
return isBuyRequest(title) || isPureSeek(title);
}

// ------------------------------------------------------- 主题分类（雷达 v2）

/**
 * 分类映射 v2（三层，优先级：标题关键词层 ＞ 来源原生字段层 ＞ 默认兜底），
 * ingest 时算出并存入 posts.category，不事后回填（原生字段事后拿不到）。
 * 第 1 层只看标题（摘要绝不参与），按 免费算力 → 云服务 → 大模型 API →
 * 开发工具 的顺序命中即定类；未命中才看第 2 层来源原生字段：
 * - 白嫖计 category：api→大模型 API；coding/agent/local→开发工具；
 *   chat/search/writing/image/video/audio/office/design/study/safety→AI 应用试用
 * - 懒猫 goals：含 api→大模型 API；含 code 不含 api→开发工具；其余→AI 应用试用
 * 赛博鸡蛋 category 是 offer 类型、AIHot kind 是节奏，都不是主题分类，
 * 这两家只走标题层。产品名 gazetteer（扣子 Coze 等）在第 1 层开发工具词表内。
 * 注：任务书第五部分给的实测分布（约 177/323/31）是标题层单独运行的结果；
 * 按第一部分映射规范落实第 2 层后分布约为 282/183/67/21/1（554 条目录帖实测），
 * 三个指定抽查样例（OpusClip/超算/Zed）两种口径下都分对——以映射规范为准。
 */
export interface NativeCategoryInput {
  /** 白嫖计原生 category */
  rawCategory?: string | null;
  /** 懒猫原生 goals */
  rawGoals?: string[];
}

const BAIPIAOJI_DEV_CATEGORIES = new Set(["coding", "agent", "local"]);
const BAIPIAOJI_APP_CATEGORIES = new Set([
  "chat", "search", "writing", "image", "video", "audio",
  "office", "design", "study", "safety",
]);

export function classifyCategory(
  title: string,
  native?: NativeCategoryInput,
): CategoryName {
  // 第 1 层：标题关键词（只看标题）
  if (CATEGORY_COMPUTE_WORDS.some((w) => title.includes(w))) return "免费算力";
  if (CATEGORY_CLOUD_WORDS.some((w) => title.includes(w))) return "云服务";
  if (
    CATEGORY_API_WORD_RE.test(title) ||
    CATEGORY_API_WORDS.some((w) => title.includes(w))
  ) {
    return "大模型 API";
  }
  if (CATEGORY_DEV_WORDS.some((w) => title.includes(w))) return "开发工具";
  // 第 2 层：来源原生字段
  if (native?.rawCategory) {
    if (native.rawCategory === "api") return "大模型 API";
    if (BAIPIAOJI_DEV_CATEGORIES.has(native.rawCategory)) return "开发工具";
    if (BAIPIAOJI_APP_CATEGORIES.has(native.rawCategory)) return "AI 应用试用";
  }
  if (native?.rawGoals && native.rawGoals.length > 0) {
    if (native.rawGoals.includes("api")) return "大模型 API";
    if (native.rawGoals.includes("code")) return "开发工具";
    return "AI 应用试用";
  }
  // 默认兜底
  return CATEGORY_DEFAULT;
}

// ------------------------------------------------------- §5 重点词 / 网关

function wordBoundaryHit(text: string, term: string): boolean {
const re = new RegExp(`(?<![a-z0-9])${term}(?![a-z0-9])`, "i");
return re.test(text);
}

/** 命中的重点词 id 列表（标题+摘要） */
export function matchKeywords(text: string): string[] {
const lower = text.toLowerCase();
const hits: string[] = [];
for (const kw of KEYWORDS) {
let hit = false;
if (kw.kind === "gpt") {
hit = GPT_PATTERNS.some((re) => re.test(text));
} else if (kw.kind === "word") {
hit = wordBoundaryHit(text, kw.term?? "");
} else if (kw.kind === "residential") {
hit = RESIDENTIAL_PATTERNS.some((re) => re.test(text));
} else {
hit = lower.includes(kw.term?? "");
}
if (hit) hits.push(kw.id);
}
return hits;
}

/** 归一化：小写、去掉空格与连字符（cc-switch / ccswitch / CC Switch 等价） */
export function normalizeToolText(text: string): string {
return text.toLowerCase().replace(/[\s\-_]+/g, "");
}

/** 命中的 AI 网关工具 id 列表（标题+摘要）；magpie 需网关语境且无排除词 */
export function matchGateways(text: string): string[] {
const lower = text.toLowerCase();
const norm = normalizeToolText(text);
const hits: string[] = [];
for (const tool of GATEWAY_TOOLS) {
const target = GATEWAY_NORMALIZED[tool.id];
if (!target ||!norm.includes(target)) continue;
if (tool.id === "magpie") {
// 排除优先于一切
if (MAGPIE_EXCLUDE.some((w) => lower.includes(w))) continue;
const hasContext = MAGPIE_CONTEXT.some((w) => lower.includes(w.toLowerCase()));
if (!hasContext) continue;
}
hits.push(tool.id);
}
return hits;
}

// ---------------------------------------------------------------- §6 教程

export function isTutorialTitle(title: string): boolean {
if (TUTORIAL_WORDS.some((w) => title.includes(w))) return true;
const hasHow = TUTORIAL_HOW.some((w) => title.includes(w));
const hasDo = TUTORIAL_DO.some((w) => title.includes(w));
return hasHow && hasDo;
}

export function retentionWindowDays(isTutorial: boolean): number {
return isTutorial? CONFIG.retentionDays.tutorial: CONFIG.retentionDays.normal;
}

// ------------------------------------------------------------- §10 自动标签

function extractPrices(text: string): { cny: number[]; usd: number[]} {
const cny: number[] = [];
const usd: number[] = [];
for (const m of text.matchAll(/[¥￥]\s*(\d+(?:\.\d+)?)/g)) cny.push(Number(m[1]));
for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*元/g)) cny.push(Number(m[1]));
for (const m of text.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)) usd.push(Number(m[1]));
for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:美元|刀)/g)) usd.push(Number(m[1]));
return { cny, usd};
}

export function autoTags(
title: string,
keywordIds: string[],
gatewayIds: string[],
isTutorial: boolean,
): string[] {
const tags: string[] = [];
if (TAG_RULES.free.some((w) => title.includes(w)) || TAG_RULES.freeEn.test(title)) {
tags.push("免费");
}
if (TAG_RULES.limited.some((w) => title.includes(w))) tags.push("限免");
const prices = extractPrices(title);
const lowByWord = TAG_RULES.lowPrice.some((w) => title.includes(w));
const lowByPrice =
prices.cny.some((v) => v <= TAG_RULES.lowPriceCnyMax) ||
prices.usd.some((v) => v <= TAG_RULES.lowPriceUsdMax);
if (lowByWord || lowByPrice) tags.push("低价");
if (isTutorial) tags.push("教程");
if (keywordIds.length > 0) tags.push("重点词");
if (gatewayIds.length > 0) tags.push("AI网关");
return tags;
}

// ------------------------------------------------------------- §4 质量分

export function classify(
source: SourceId,
title: string,
summary: string,
): Classification {
const text = `${title}\n${summary}`;
const lower = text.toLowerCase();
const keywordIds = matchKeywords(text);
const gatewayIds = matchGateways(text);
const tutorial = isTutorialTitle(title);

let baseCount = 0;
for (const w of CONFIG.baseWords) {
if (lower.includes(w.toLowerCase())) baseCount += 1;
}
let score = Math.min(baseCount * CONFIG.baseWordPoints, CONFIG.baseWordCap);
let bonusHit = false;
for (const w of CONFIG.bonusWords) {
if (lower.includes(w.toLowerCase())) {
score += CONFIG.bonusWordPoints;
bonusHit = true;
}
}
const hasFocus = keywordIds.length > 0 || gatewayIds.length > 0;
// §5 绕过收紧（A）：论坛来源（非目录）命中重点词/网关时，标题或摘要还必须
// 至少含一个羊毛信号词才可绕过阈值；无信号词的重点词帖不收、不得分。
// 目录四家走原有目录规则不受影响；教程类帖子豁免，仍按旧规则收。
const hasSignal = WOOL_SIGNAL_WORDS.some((w) => lower.includes(w.toLowerCase()));
const focusBlocked =
hasFocus && !tutorial && !CATALOG_SOURCES.includes(source) && !hasSignal;
if (hasFocus && !focusBlocked) score += CONFIG.keywordBonus;

const threshold = CONFIG.thresholds[source];
let passesThreshold = (hasFocus && !focusBlocked) || score >= threshold;
if (focusBlocked) passesThreshold = false;
// LINUX DO 相关性门：latest.json 是全站最新列表而非按词搜索结果，阈值 ≥0 会把
// 无关闲聊全放进来淹没列表。此路径（刷新 latest + ingestPosts）额外要求至少命中
// 一个基础羊毛词、额外省钱词、重点词或 AI 网关才入库；search.json 按词搜索路径
// 本身已按词过滤，不需要此门（该接口需登录，当前未启用）。
if (source === "linuxdo") {
const hasWoolSignal = baseCount > 0 || bonusHit || hasFocus;
passesThreshold = passesThreshold && hasWoolSignal;
}
return {
qualityScore: score,
tags: autoTags(title, keywordIds, gatewayIds, tutorial),
keywordIds,
gatewayIds,
isTutorial: tutorial,
passesThreshold,
};
}

// ------------------------------------------------- §7 新鲜度与综合排名

/** 新鲜度 = 12 × (1 − 年龄/窗口)；年龄 ≥ 窗口为 0；estimated 再 −1，最低 0 */
export function freshnessScore(
publishedAtMs: number,
isTutorial: boolean,
timeQuality: TimeQuality,
nowMs: number,
): number {
const windowMs = retentionWindowDays(isTutorial) * DAY_MS;
const age = nowMs - publishedAtMs;
if (age >= windowMs) return 0;
let fresh = CONFIG.freshnessMax * (1 - Math.max(age, 0) / windowMs);
if (timeQuality === "estimated") fresh -= CONFIG.estimatedFreshnessPenalty;
return Math.max(0, fresh);
}

/** 综合排名 = 质量分 + 新鲜度 − (已读? 8: 0) */
export function compositeScore(
qualityScore: number,
publishedAtMs: number,
isTutorial: boolean,
timeQuality: TimeQuality,
isRead: boolean,
nowMs: number,
): number {
const fresh = freshnessScore(publishedAtMs, isTutorial, timeQuality, nowMs);
return qualityScore + fresh - (isRead? CONFIG.readPenalty: 0);
}

/** 是否已过保留窗口（年龄 ≥ 窗口） */
export function isExpired(
publishedAtMs: number,
isTutorial: boolean,
nowMs: number,
): boolean {
return nowMs - publishedAtMs >= retentionWindowDays(isTutorial) * DAY_MS;
}

/** 今日精选：近 24 小时且时间准确（estimated 不计） */
export function isTodayPick(publishedAtMs: number, timeQuality: TimeQuality, nowMs: number): boolean {
if (timeQuality === "estimated") return false;
const age = nowMs - publishedAtMs;
return age >= 0 && age < DAY_MS;
}

// ------------------------------------------------------------- §8 X 时间

/** X snowflake：发布时间 = (id >> 22) + 1288834974657 毫秒 */
export function xSnowflakeMs(statusId: string): number | null {
if (!/^\d+$/.test(statusId)) return null;
try {
const ms = (BigInt(statusId) >> 22n) + BigInt(CONFIG.xEpochMs);
const n = Number(ms);
return Number.isFinite(n)? n: null;
} catch {
return null;
}
}

const X_STATUS_RE = /^https:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,30})\/status\/(\d+)(?:[/?#].*)?$/;

/** 严格校验 X 帖子链接；返回 {handle, id} 或 null（排除 /i/web/status 等） */
export function parseXStatusUrl(url: string): { handle: string; id: string} | null {
const m = X_STATUS_RE.exec(url.trim());
if (!m) return null;
const handle = m[1]?? "";
const id = m[2]?? "";
if (handle.toLowerCase() === "i") return null;
return { handle, id};
}

// ------------------------------------------- §8 LINUX DO 主题 ID 插值

export interface Anchor {
id: number;
timeMs: number;
}

/**
* 用同来源真实日期锚点按主题 ID 线性插值估算时间。
* 锚点少于 2 个返回 null（不收录）；超出范围用最近两个锚点外推，
* 结果不得晚于当前时间。
*/
export function interpolateById(
targetId: number,
anchors: Anchor[],
nowMs: number,
): number | null {
const sorted = [...anchors].sort((a, b) => a.id - b.id);
if (sorted.length < 2) return null;
const exact = sorted.find((a) => a.id === targetId);
if (exact) return exact.timeMs;

let before: Anchor | undefined;
let after: Anchor | undefined;
for (const a of sorted) {
if (a.id < targetId) before = a;
if (a.id > targetId &&!after) after = a;
}
let t: number;
if (before && after) {
const ratio = (targetId - before.id) / (after.id - before.id);
t = before.timeMs + ratio * (after.timeMs - before.timeMs);
} else if (!before && after) {
// 低于最小锚点：用最小的两个锚点外推
const a1 = sorted[0];
const a2 = sorted[1];
if (!a1 ||!a2 || a2.id === a1.id) return null;
const slope = (a2.timeMs - a1.timeMs) / (a2.id - a1.id);
t = a1.timeMs + slope * (targetId - a1.id);
} else if (before &&!after) {
// 高于最大锚点：用最大的两个锚点外推
const a1 = sorted[sorted.length - 2];
const a2 = sorted[sorted.length - 1];
if (!a1 ||!a2 || a2.id === a1.id) return null;
const slope = (a2.timeMs - a1.timeMs) / (a2.id - a1.id);
t = a2.timeMs + slope * (targetId - a2.id);
} else {
return null;
}
if (!Number.isFinite(t)) return null;
return Math.min(Math.round(t), nowMs);
}

// ------------------------------------------------------------- §8 滞后

/** 某来源最新帖子距现在的滞后小时数；未超过阈值返回 null */
export function lagHoursForLatest(latestPublishedMs: number | null, nowMs: number): number | null {
if (latestPublishedMs == null) return null;
const lagMs = nowMs - latestPublishedMs;
if (lagMs > CONFIG.lagThresholdHours * 3600 * 1000) {
return Math.floor(lagMs / (3600 * 1000));
}
return null;
}

// ------------------------------------------------- 相对时间解析（抓取用）

/**
* 解析英文/中文相对时间文本（NodeSeek 列表等）。
* 返回 {ms, quality}：分钟/小时级 → relative（按抓取时刻反推），
* 天级 → estimated。无法解析返回 null。
*/
export function parseRelativeTime(
text: string,
nowMs: number,
): { ms: number; quality: TimeQuality} | null {
const t = text.toLowerCase().replace(/\s+/g, " ").trim();
let m = /(\d+)\s*(s|sec|secs|second|seconds)\s*ago/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * 1000, quality: "relative"};
m = /(\d+)\s*(m|min|mins|minute|minutes)\s*ago/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * 60 * 1000, quality: "relative"};
m = /(\d+)\s*(h|hr|hrs|hour|hours)\s*ago/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * 3600 * 1000, quality: "relative"};
m = /(\d+)\s*(d|day|days)\s*ago/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * DAY_MS, quality: "estimated"};
m = /(\d+)\s*秒前/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * 1000, quality: "relative"};
m = /(\d+)\s*分钟前/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * 60 * 1000, quality: "relative"};
m = /(\d+)\s*小时前/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * 3600 * 1000, quality: "relative"};
m = /(\d+)\s*天前/.exec(t);
if (m) return { ms: nowMs - Number(m[1]) * DAY_MS, quality: "estimated"};
if (/just now|刚刚/.test(t)) return { ms: nowMs, quality: "relative"};
return null;
}

// ------------------------------------------------- 七项评分（目录四站专用）
// 确定性规则（规则表在 config.SCORE_RULES），只读已存的结构化字段计算，
// 不调大模型。口径统一：七个维度方向一致，5 = 对用户最有利；风险维度
// 5 = 风险最低、最安全，1 = 风险最高。risk / usefulness / audience 三项规则
// 恒为 null，只能由核实轮次经 setVerified 写入（见 mergeVerifiedScores /
// refresh 5.6 的保留逻辑）：一旦写入，刷新重算绝不用规则覆盖，规则只能
// 填这三项仍为 null 的维度（其余四项 quota/urgency/difficulty/credibility
// 仍每轮按规则重算）。

export interface PostScores {
  quota: number | null;
  urgency: number | null;
  difficulty: number | null;
  credibility: number | null;
  risk: number | null;
  usefulness: number | null;
  audience: number | null;
}

/** 评分输入：帖子已存的结构化字段（覆盖回填之后的值） */
export interface ScoreInput {
  quota: string | null;
  conditions: string | null;
  deadlineMs: number | null;
  deadlineText: string | null;
  claimUrl: string | null;
  claimNote: string | null;
  url: string;
  lastVerified: string | null;
}

export interface ScoreResult {
  scores: PostScores;
  /** 已评维度均值（1 位小数）；无已评维度为 null */
  total: number | null;
  /** 已评维度数 0–7 */
  coverage: number;
}

const CN_UNIT_MULT: Record<string, number> = {
  "亿": 100_000_000,
  "千万": 10_000_000,
  "百万": 1_000_000,
  "万": 10_000,
};
const EN_UNIT_MULT: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

interface AmountHit {
  value: number;
  index: number;
}

/** 在文本中按出现顺序找「数字 + 单位」（中文 万/亿系或英文 K/M/B）或带千分位的纯数字 */
function findAmounts(text: string): AmountHit[] {
  const hits: AmountHit[] = [];
  const re =
    /(\d+(?:\.\d+)?)\s*(亿|千万|百万|万)|(\d+(?:\.\d+)?)\s*([KMB])(?![a-zA-Z])|(\d{1,3}(?:,\d{3})+|\d{4,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] != null && m[2] != null) {
      hits.push({ value: Number(m[1]) * (CN_UNIT_MULT[m[2]] ?? 1), index: m.index });
    } else if (m[3] != null && m[4] != null) {
      hits.push({
        value: Number(m[3]) * (EN_UNIT_MULT[m[4].toLowerCase()] ?? 1),
        index: m.index,
      });
    } else if (m[5] != null) {
      hits.push({ value: Number(m[5].replace(/,/g, "")), index: m.index });
    }
  }
  return hits;
}

type Period = "daily" | "monthly" | "once" | null;

/** 周期词在文本中最早出现的位置决定周期（每天/每月/一次性） */
function detectPeriod(text: string): Period {
  const candidates: { period: Period; index: number }[] = [];
  const daily = /每天|每日|每24小时|日均|per\s*day|\/\s*天/i.exec(text);
  if (daily) candidates.push({ period: "daily", index: daily.index });
  const monthly = /每月|每30天|月均|per\s*month|\/\s*月/i.exec(text);
  if (monthly) candidates.push({ period: "monthly", index: monthly.index });
  const once = /一次性|单次|一次领取|总量/.exec(text);
  if (once) candidates.push({ period: "once", index: once.index });
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.period ?? null;
}

function tierScore(
  value: number,
  tiers: readonly { min: number; score: number }[],
  fallback: number,
): number {
  for (const t of tiers) if (value >= t.min) return t.score;
  return fallback;
}

/** ① 额度：从 quota 文本解析数字+单位后按类分档；解析不到具体数字记 null */
export function scoreQuota(quota: string | null): number | null {
  if (!quota) return null;
  const text = quota;
  const amounts = findAmounts(text);
  const period = detectPeriod(text);
  // Token 类
  if (/token/i.test(text) || text.includes("令牌")) {
    if (amounts.length === 0) return null;
    let daily = amounts[0]?.value ?? 0;
    if (period === "monthly") daily = daily / SCORE_RULES.monthlyDivisor;
    return tierScore(daily, SCORE_RULES.tokenDailyTiers, SCORE_RULES.tokenFallbackScore);
  }
  // 小时类（档位按每月小时）
  const hoursMatch = /(\d+(?:\.\d+)?)\s*(?:小时|hours?|hrs?)/i.exec(text);
  if (hoursMatch) {
    let monthly = Number(hoursMatch[1]);
    if (period === "daily") monthly = monthly * SCORE_RULES.monthlyDivisor;
    return tierScore(monthly, SCORE_RULES.hoursMonthlyTiers, SCORE_RULES.hoursFallbackScore);
  }
  // 金额类（美元）
  const moneyMatch =
    /\$\s*(\d+(?:\.\d+)?)/.exec(text) ?? /(\d+(?:\.\d+)?)\s*(?:美元|USD)/i.exec(text);
  if (moneyMatch) {
    return tierScore(Number(moneyMatch[1]), SCORE_RULES.moneyTiers, SCORE_RULES.moneyFallbackScore);
  }
  // 积分/次数类
  if (/积分|次数|次调用|请求次数/.test(text) || /\d[\d,]*\s*次/.test(text)) {
    const near = /(\d+(?:\.\d+)?)\s*(亿|千万|百万|万)?\s*(?:积分|次)/.exec(text);
    if (near) {
      const value = Number(near[1]) * (near[2] ? (CN_UNIT_MULT[near[2]] ?? 1) : 1);
      return tierScore(value, SCORE_RULES.pointsTiers, SCORE_RULES.pointsFallbackScore);
    }
    if (amounts.length > 0) {
      return tierScore(amounts[0]?.value ?? 0, SCORE_RULES.pointsTiers, SCORE_RULES.pointsFallbackScore);
    }
    return null;
  }
  return null;
}

/** ② 紧迫性：绝对到期按剩余天数分档；只有相对有效期文本记 3；无任何到期信息记 1 */
export function scoreUrgency(input: ScoreInput, nowMs: number): number {
  if (input.deadlineMs != null) {
    const days = (input.deadlineMs - nowMs) / DAY_MS;
    for (const t of SCORE_RULES.urgencyDayTiers) {
      if (days <= t.maxDays) return t.score;
    }
    return SCORE_RULES.urgencyFallbackScore;
  }
  if (input.deadlineText && input.deadlineText.trim().length > 0) {
    return SCORE_RULES.urgencyRelativeScore;
  }
  return SCORE_RULES.urgencyNoneScore;
}

/** ③ 领取难度：5 最容易。基础 3；懒猫难度标注作基准；门槛词组每组 −1；
 * 无任何门槛且确有文本可判读时 +1；钳制 1–5 */
export function scoreDifficulty(input: ScoreInput): number {
  let score: number = SCORE_RULES.difficultyBase;
  const conditions = input.conditions ?? "";
  const lanmao = /领取难度：(低|中|高)/.exec(conditions);
  if (lanmao?.[1]) {
    score = SCORE_RULES.difficultyLanmaoMap[lanmao[1]] ?? score;
  }
  // 扫描文本 = 条件 + 额度；含「未核实」的分句剔除（未核实的要求不算已确认门槛）
  const scanText = [input.conditions ?? "", input.quota ?? ""]
    .join("；")
    .split(/[；;。\n]/)
    .filter((clause) => !clause.includes("未核实"))
    .join("；");
  let penalties = 0;
  for (const group of SCORE_RULES.difficultyBarrierGroups) {
    if (group.some((w) => scanText.includes(w))) penalties += 1;
  }
  score -= penalties;
  const hasReadableText =
    (input.conditions ?? "").trim().length > 0 || (input.quota ?? "").trim().length > 0;
  if (penalties === 0 && hasReadableText) score += SCORE_RULES.difficultyNoBarrierBonus;
  return Math.min(5, Math.max(1, score));
}

type LinkKind = "official" | "relay" | "site" | "none";

function linkKindOf(input: ScoreInput): LinkKind {
  if (input.claimUrl) {
    const isRelay =
      SCORE_RULES.credibilityRelayMarkers.some((marker) => input.claimUrl?.includes(marker)) ||
      (input.claimNote ?? "").includes("中转");
    return isRelay ? "relay" : "official";
  }
  // 无领取入口：只有帖子自身的站内详情页
  return input.url ? "site" : "none";
}

/** ④ 来源可信度（线索可追溯程度，非优惠真实性） */
export function scoreCredibility(input: ScoreInput, nowMs: number): number {
  const kind = linkKindOf(input);
  if (kind === "none") return 1;
  let verifiedDays: number | null = null;
  if (input.lastVerified) {
    const ms = Date.parse(input.lastVerified);
    if (Number.isFinite(ms)) verifiedDays = Math.max(0, (nowMs - ms) / DAY_MS);
  }
  if (kind === "official" && verifiedDays != null && verifiedDays <= SCORE_RULES.credibilityFreshDays) {
    return 5;
  }
  if (
    (kind === "official" || kind === "relay") &&
    verifiedDays != null &&
    verifiedDays <= SCORE_RULES.credibilityRecentDays
  ) {
    return 4;
  }
  if ((kind === "relay" || kind === "site") && verifiedDays != null && verifiedDays <= SCORE_RULES.credibilityRecentDays) {
    return 3;
  }
  return 2;
}

/** 综合分与已评维度数：只由非 null 维度算，未知维度不填充 */
export function summarizeScores(scores: PostScores): { total: number | null; coverage: number } {
  const rated = Object.values(scores).filter((v): v is number => v != null);
  const coverage = rated.length;
  const total =
    coverage > 0
      ? Math.round((rated.reduce((a, b) => a + b, 0) / coverage) * 10) / 10
      : null;
  return { total, coverage };
}

/** 七项评分汇总：四项规则维度现算；risk / usefulness / audience 三项取
 * 已存的核实分数（preserved，由刷新流水线从库内 scores 读出后传入），
 * 规则本身恒不产生这三项的值。 */
export function computeScores(
  input: ScoreInput,
  nowMs: number,
  preserved?: Pick<PostScores, "risk" | "usefulness" | "audience">,
): ScoreResult {
  const scores: PostScores = {
    quota: scoreQuota(input.quota),
    urgency: scoreUrgency(input, nowMs),
    difficulty: scoreDifficulty(input),
    credibility: scoreCredibility(input, nowMs),
    risk: preserved?.risk ?? null,
    usefulness: preserved?.usefulness ?? null,
    audience: preserved?.audience ?? null,
  };
  const { total, coverage } = summarizeScores(scores);
  return { scores, total, coverage };
}

/** 核实分数合并（setVerified 写入路径）：只覆盖 risk / usefulness / audience
 * 三个维度中显式给出的项（undefined=不动，null=清除回未知，1–5=写入），
 * 其余四个规则维度与未给出的维度原样保留；综合分/已评数随之重算。 */
export function mergeVerifiedScores(
  current: PostScores,
  patch: Partial<Pick<PostScores, "risk" | "usefulness" | "audience">>,
): ScoreResult {
  const scores: PostScores = { ...current };
  if (patch.risk !== undefined) scores.risk = patch.risk;
  if (patch.usefulness !== undefined) scores.usefulness = patch.usefulness;
  if (patch.audience !== undefined) scores.audience = patch.audience;
  const { total, coverage } = summarizeScores(scores);
  return { scores, total, coverage };
}
