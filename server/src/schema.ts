// Drizzle schema for 羊毛空间.
// posts: 抓到的真实帖子（唯一键 (source, external_id)，§9）。
// source_status: 每来源最近一轮抓取状态与滞后提示（§8/§11/§12）。
// refresh_logs: 每轮刷新日志（§12）。
// meta: 刷新互斥锁等键值状态（§12）。

import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(), // linuxdo | v2ex | nodeseek | x | threads
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    url: text("url").notNull(),
    /** 发布时间（UTC epoch ms）——绝不用抓取时间冒充（§0.2） */
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    /** exact | relative | snowflake | verified | estimated */
    timeQuality: text("time_quality").notNull(),
    /** 首次入库时间（UTC epoch ms），只用于显示“最近刷新/首次入库” */
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    qualityScore: integer("quality_score").notNull().default(0),
    isTutorial: integer("is_tutorial", { mode: "boolean" }).notNull().default(false),
    tags: text("tags").notNull().default("[]"), // JSON string[]
    keywordIds: text("keyword_ids").notNull().default("[]"), // JSON string[]
    gatewayIds: text("gateway_ids").notNull().default("[]"), // JSON string[]
    /** 主题分类（五类，ingest 时按标题关键词层算出并存入，见 rules.classifyCategory） */
    category: text("category").notNull().default("AI 应用试用"),
    /** 额度原文（来源原生字段，如懒猫 quota / AIHot appliesTo） */
    quota: text("quota"),
    /** 官方领取入口（取不到为 null，界面显示「未核实」） */
    claimUrl: text("claim_url"),
    /** 领取入口备注（如懒猫 lanmao.ai/go 为站方中转） */
    claimNote: text("claim_note"),
    /** 绝对到期时间（UTC epoch ms，可空）；相对有效期走 deadlineText */
    deadline: integer("deadline", { mode: "timestamp_ms" }),
    /** 相对有效期原文（如「首次使用起 5 天」），与 deadline 二选一 */
    deadlineText: text("deadline_text"),
    /** 适用地区原文 */
    region: text("region"),
    /** 最后核实日期（来源原生日期字符串，如 2026-11-02；不得用抓取时间冒充） */
    lastVerified: text("last_verified"),
    /** 领取条件 */
    conditions: text("conditions"),
    /** 成本说明（严禁无依据写 0 元） */
    costNote: text("cost_note"),
    /** 风险说明 */
    riskNote: text("risk_note"),
    /** 原始条目 id（懒猫 entry id / AIHot id / 白嫖计 slug / 鸡蛋 guid） */
    rawRef: text("raw_ref"),
    /** 厂商名（懒猫 vendor / AIHot provider），供搜索三字段之一 */
    vendor: text("vendor"),
    /** 七项评分 JSON {quota,urgency,difficulty,credibility,risk,usefulness,audience}，
     * 每项 1–5 或 null（未知）；仅目录四站条目计算，入库/回填时由确定性规则算出 */
    scores: text("scores"),
    /** 综合分 = 已评维度均值（1 位小数）；无已评维度为 null */
    scoreTotal: real("score_total"),
    /** 已评维度数 0–7（界面显示「已评 N/7」） */
    scoreCoverage: integer("score_coverage").notNull().default(0),
    /** 核实覆盖层：人工核实轮次写入，刷新流水线绝不覆盖；有值时卡片优先显示 */
    verifiedRegion: text("verified_region"),
    verifiedCost: text("verified_cost"),
    verifiedRisk: text("verified_risk"),
    verifiedConditions: text("verified_conditions"),
    /** 核实日期（YYYY-MM-DD） */
    verifiedAt: text("verified_at"),
    /** 核实证据链接（官方页） */
    verifiedSourceUrl: text("verified_source_url"),
    /** 核实状态：ok | ended（ended 显示「已结束」并移出今日新上/即将到期） */
    verifiedStatus: text("verified_status"),
    /** 标题覆盖：核实轮次按官方页写入的修正标题（null=用来源原标题）；
     * 卡片优先显示并注明「标题已按官方页修正」；刷新流水线绝不覆盖此列 */
    titleOverride: text("title_override"),
    /** 额度覆盖：核实轮次按官方页写入的修正额度文本（null=用来源原额度）；
     * 卡片额度栏优先显示并注明「已按官方页修正」；刷新流水线绝不覆盖此列 */
    quotaOverride: text("quota_override"),
    /** 简介覆盖：核实轮次按官方页写入的修正简介（null=用来源原简介）；
     * 卡片优先显示并注明「已按官方页修正」；刷新流水线绝不覆盖此列 */
    summaryOverride: text("summary_override"),
  },
  (t) => [uniqueIndex("posts_source_external_idx").on(t.source, t.externalId)],
);

export const sourceStatus = sqliteTable("source_status", {
  source: text("source").primaryKey(),
  /** ok | failed | empty */
  status: text("status").notNull().default("empty"),
  lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
  lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
  fetchedCount: integer("fetched_count").notNull().default(0),
  error: text("error"),
  /** §8 滞后小时数（真实计算触发，未滞后为 null） */
  lagHours: real("lag_hours"),
});

export const refreshLogs = sqliteTable("refresh_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
  trigger: text("trigger").notNull(), // manual | cron
  /** JSON: 每来源 {fetched, filtered, kept, expired, error}、time_quality 分布、裁剪数、核验与滞后说明 */
  detail: text("detail").notNull().default("{}"),
});

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
