// Actions for 羊毛空间.
// getState: 一次返回列表所需的全部数据（帖子+综合排名、统计、重点词 7 天计数、来源状态）。
// refresh: 手动刷新，与每小时定时任务走同一条确定性流水线（refresh.ts）。
// markRead / markUnread: 已读状态服务端保存（§11）。
// selfCheck: §7 算例核对 + §8 滞后 dry-run（纯函数计算，不写正式库）。

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import { CONFIG, KEYWORDS, SOURCES, CATALOG_SOURCES, CATEGORIES, type SourceId } from "./config";
import {
compositeScore,
freshnessScore,
isTodayPick,
lagHoursForLatest,
mergeVerifiedScores,
type PostScores,
type TimeQuality,
} from "./rules";
import { runIngest, runRefresh, type RefreshResult } from "./refresh";

const postSchema = z.object({
  id: z.number(),
  source: z.string(),
  sourceLabel: z.string(),
  externalId: z.string(),
  title: z.string(),
  /** 标题覆盖（核实轮次按官方页写入；非 null 时卡片显示此标题并注明已修正） */
  titleOverride: z.string().nullable(),
  /** 额度覆盖（核实轮次按官方页写入；非 null 时卡片额度栏显示此值并注明已修正） */
  quotaOverride: z.string().nullable(),
  /** 简介覆盖（核实轮次按官方页写入；非 null 时卡片显示此简介并注明已修正） */
  summaryOverride: z.string().nullable(),
  summary: z.string(),
  url: z.string(),
  publishedAt: z.string(),
  timeQuality: z.string(),
  isRead: z.boolean(),
  isTutorial: z.boolean(),
  qualityScore: z.number(),
  freshness: z.number(),
  rank: z.number(),
  tags: z.array(z.string()),
  keywordIds: z.array(z.string()),
  gatewayIds: z.array(z.string()),
  todayPick: z.boolean(),
  // 免费额度雷达结构化字段（目录来源原生/核实回填；论坛来源多为 null）
  category: z.string(),
  quota: z.string().nullable(),
  claimUrl: z.string().nullable(),
  claimNote: z.string().nullable(),
  deadline: z.string().nullable(),
  deadlineText: z.string().nullable(),
  region: z.string().nullable(),
  lastVerified: z.string().nullable(),
  conditions: z.string().nullable(),
  costNote: z.string().nullable(),
  riskNote: z.string().nullable(),
  rawRef: z.string().nullable(),
  vendor: z.string().nullable(),
  /** 首次入库时间（§9 已存 fetched_at，此处暴露为 first_seen） */
  firstSeen: z.string(),
  /** 七项评分（仅目录四站；每项 1–5 或 null=未知） */
  scores: z.object({
    quota: z.number().nullable(),
    urgency: z.number().nullable(),
    difficulty: z.number().nullable(),
    credibility: z.number().nullable(),
    risk: z.number().nullable(),
    usefulness: z.number().nullable(),
    audience: z.number().nullable(),
  }),
  scoreTotal: z.number().nullable(),
  scoreCoverage: z.number(),
  /** 核实覆盖层（人工核实轮次写入；有值时卡片优先显示并带已核实标记） */
  verifiedRegion: z.string().nullable(),
  verifiedCost: z.string().nullable(),
  verifiedRisk: z.string().nullable(),
  verifiedConditions: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  verifiedSourceUrl: z.string().nullable(),
  verifiedStatus: z.string().nullable(),
});

const sourceStatusSchema = z.object({
  source: z.string(),
  label: z.string(),
  status: z.string(),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  fetchedCount: z.number(),
  error: z.string().nullable(),
  lagHours: z.number().nullable(),
  storedCount: z.number(),
});

const stateResponse = z.object({
  posts: z.array(postSchema),
  total: z.number(),
  cap: z.number(),
  unreadCount: z.number(),
  todayPickCount: z.number(),
  keywordCounts: z.array(
    z.object({ id: z.string(), label: z.string(), count: z.number() }),
  ),
  gatewayCount: z.number(),
  /** 目录四站的五类计数（分类情报区用） */
  categoryCounts: z.array(z.object({ category: z.string(), count: z.number() })),
  /** 目录类来源 id 列表（首页三区与搜索默认范围用） */
  catalogSources: z.array(z.string()),
  sources: z.array(sourceStatusSchema),
  lastRefreshAt: z.string().nullable(),
  scheduleNote: z.string(),
});

type StateResponse = z.infer<typeof stateResponse>;

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type ScoresShape = {
  quota: number | null;
  urgency: number | null;
  difficulty: number | null;
  credibility: number | null;
  risk: number | null;
  usefulness: number | null;
  audience: number | null;
};
const EMPTY_SCORES: ScoresShape = {
  quota: null,
  urgency: null,
  difficulty: null,
  credibility: null,
  risk: null,
  usefulness: null,
  audience: null,
};

function parseScores(value: string | null): ScoresShape {
  if (!value) return EMPTY_SCORES;
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof ScoresShape, unknown>>;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    return {
      quota: num(parsed.quota),
      urgency: num(parsed.urgency),
      difficulty: num(parsed.difficulty),
      credibility: num(parsed.credibility),
      risk: num(parsed.risk),
      usefulness: num(parsed.usefulness),
      audience: num(parsed.audience),
    };
  } catch {
    return EMPTY_SCORES;
  }
}

const refreshResponse = z.object({
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  totalPosts: z.number(),
  perSource: z.record(
    z.string(),
    z.object({
      fetched: z.number(),
      filtered: z.number(),
      kept: z.number(),
      status: z.string(),
      error: z.string().nullable(),
    }),
  ),
  timeQualityCounts: z.record(z.string(), z.number()),
  expiredRemoved: z.number(),
  delistedRemoved: z.number(),
  trimmed: z.number(),
  verified: z.number(),
  notes: z.array(z.string()),
});

function toRefreshResponse(r: RefreshResult): z.infer<typeof refreshResponse> {
  const perSource: Record<
    string,
    { fetched: number; filtered: number; kept: number; status: string; error: string | null }
  > = {};
  for (const [k, v] of Object.entries(r.perSource)) {
    perSource[k] = {
      fetched: v.fetched,
      filtered: v.filtered,
      kept: v.kept,
      status: v.status,
      error: v.error,
    };
  }
  return {
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    totalPosts: r.totalPosts,
    perSource,
    timeQualityCounts: r.timeQualityCounts,
    expiredRemoved: r.expiredRemoved,
    delistedRemoved: r.delistedRemoved,
    trimmed: r.trimmed,
    verified: r.verified,
    notes: r.notes,
  };
}

export const Actions = {
  getState: defineAction({
    description: "Returns all posts with computed composite rank, stats, keyword 7-day counts, and per-source status for the 羊毛空间 UI.",
    request: z.object({}),
    response: stateResponse,
    async handler(ctx): Promise<StateResponse> {
      const db = ctx.db<typeof schema>();
      const now = Date.now();
      const rows = await db.select().from(schema.posts);
      const statusRows = await db.select().from(schema.sourceStatus);
      const logRows = await db
        .select()
        .from(schema.refreshLogs)
        .orderBy(desc(schema.refreshLogs.id))
        .limit(1);

      const labelOf = (s: string) => SOURCES.find((x) => x.id === s)?.label ?? s;

      const posts = rows.map((r) => {
        const tq = r.timeQuality as TimeQuality;
        const publishedMs = r.publishedAt.getTime();
        return {
          id: r.id,
          source: r.source,
          sourceLabel: labelOf(r.source),
          externalId: r.externalId,
          title: r.title,
          titleOverride: r.titleOverride,
          quotaOverride: r.quotaOverride,
          summaryOverride: r.summaryOverride,
          summary: r.summary,
          url: r.url,
          publishedAt: r.publishedAt.toISOString(),
          timeQuality: r.timeQuality,
          isRead: r.isRead,
          isTutorial: r.isTutorial,
          qualityScore: r.qualityScore,
          freshness: freshnessScore(publishedMs, r.isTutorial, tq, now),
          rank: compositeScore(r.qualityScore, publishedMs, r.isTutorial, tq, r.isRead, now),
          tags: parseJsonArray(r.tags),
          keywordIds: parseJsonArray(r.keywordIds),
          gatewayIds: parseJsonArray(r.gatewayIds),
          todayPick: isTodayPick(publishedMs, tq, now),
          category: r.category,
          quota: r.quota,
          claimUrl: r.claimUrl,
          claimNote: r.claimNote,
          deadline: r.deadline?.toISOString() ?? null,
          deadlineText: r.deadlineText,
          region: r.region,
          lastVerified: r.lastVerified,
          conditions: r.conditions,
          costNote: r.costNote,
          riskNote: r.riskNote,
          rawRef: r.rawRef,
          vendor: r.vendor,
          firstSeen: r.fetchedAt.toISOString(),
          scores: parseScores(r.scores),
          scoreTotal: r.scoreTotal,
          scoreCoverage: r.scoreCoverage,
          verifiedRegion: r.verifiedRegion,
          verifiedCost: r.verifiedCost,
          verifiedRisk: r.verifiedRisk,
          verifiedConditions: r.verifiedConditions,
          verifiedAt: r.verifiedAt,
          verifiedSourceUrl: r.verifiedSourceUrl,
          verifiedStatus: r.verifiedStatus,
        };
      });
      // §7 排序：综合排名降序，同分发布时间新者在前，再按外部 ID
      posts.sort(
        (a, b) =>
          b.rank - a.rank ||
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
          b.externalId.localeCompare(a.externalId),
      );

      const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
      const recent = rows.filter((r) => r.publishedAt.getTime() >= sevenDaysAgo);
      const keywordCounts = KEYWORDS.map((kw) => ({
        id: kw.id,
        label: kw.label,
        count: recent.filter((r) => parseJsonArray(r.keywordIds).includes(kw.id)).length,
      }));
      const gatewayCount = recent.filter((r) => parseJsonArray(r.gatewayIds).length > 0).length;

      const catalogRows = rows.filter((r) =>
        CATALOG_SOURCES.includes(r.source as SourceId),
      );
      const categoryCounts = CATEGORIES.map((c) => ({
        category: c as string,
        count: catalogRows.filter((r) => r.category === c).length,
      }));

      const sources = SOURCES.map((s) => {
        const st = statusRows.find((x) => x.source === s.id);
        return {
          source: s.id as string,
          label: s.label,
          status: st?.status ?? "empty",
          lastAttemptAt: st?.lastAttemptAt?.toISOString() ?? null,
          lastSuccessAt: st?.lastSuccessAt?.toISOString() ?? null,
          fetchedCount: st?.fetchedCount ?? 0,
          error: st?.error ?? null,
          lagHours: st?.lagHours ?? null,
          storedCount: rows.filter((r) => r.source === s.id).length,
        };
      });

      const lastLog = logRows[0];
      return {
        posts,
        total: rows.length,
        cap: CONFIG.maxPosts,
        unreadCount: rows.filter((r) => !r.isRead).length,
        todayPickCount: posts.filter((p) => p.todayPick).length,
        keywordCounts,
        gatewayCount,
        categoryCounts,
        catalogSources: CATALOG_SOURCES.map((s) => s as string),
        sources,
        lastRefreshAt: lastLog?.finishedAt.toISOString() ?? null,
        scheduleNote: "每小时自动刷新一次（定时任务与手动刷新走同一流水线）",
      };
    },
  }),

  refresh: defineAction({
    description: "Runs the full deterministic refresh pipeline (fetch, filter, classify, score, dedupe, verify, purge, trim, log) across LINUX DO, V2EX, NodeSeek, X, Threads, the Telegram public channel Sliverkiss (t.me/s preview page, no login), and the four catalog sources 懒猫 AI, AIHot Token 羊毛, 赛博鸡蛋, 白嫖计 (catalog sources sync-delete delisted entries instead of expiring by age). Catalog posts also get a title-keyword category and structured radar fields (quota/claimUrl/deadline/region/lastVerified/conditions) from native source fields, hand-verified overrides are re-applied each round, seven-dimension rule-based scores (quota/urgency/difficulty/credibility; risk/usefulness/audience stay null) are recomputed for all catalog posts from stored fields, the human verification overlay (verified_*) is never overwritten, entries past an absolute deadline are removed, and Crouton Alpha is never ingested.",
    request: z.object({
      trigger: z.enum(["manual", "cron"]).default("manual"),
    }),
    response: refreshResponse,
    async handler(ctx, args): Promise<z.infer<typeof refreshResponse>> {
      const result = await runRefresh(ctx, args.trigger);
      if (result.status === "ok" || result.status === "timeout") {
        ctx.invalidateQueries();
      }
      return toRefreshResponse(result);
    },
  }),

  ingestPosts: defineAction({
    description: "Ingests real posts measured/fetched externally (e.g. via browser or the Threads connector) through the same filter/score/dedupe pipeline as refresh. Rejects items missing publishedAt or url, and rejects all NodeSeek/X items as unverified.",
    request: z.object({
      posts: z
        .array(
          z.object({
            source: z.string(),
            externalId: z.string(),
            title: z.string(),
            url: z.string(),
            publishedAt: z.string(),
            timeQuality: z.string(),
            summary: z.string().optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    response: z.object({
      status: z.string(),
      accepted: z.number(),
      rejected: z.array(z.object({ externalId: z.string(), reason: z.string() })),
      totalPosts: z.number(),
    }),
    async handler(ctx, args) {
      const result = await runIngest(ctx, args.posts);
      if (result.accepted > 0) ctx.invalidateQueries();
      return result;
    },
  }),

  setVerified: defineAction({
    description: "Writes the human-verification overlay for one post identified by (source, externalId): verified region/cost/risk/conditions, verification date, evidence URL, status ok|ended, the three human-scored dimensions scoreRisk/scoreUsefulness/scoreAudience (unified direction, 5 = most favorable; for risk 5 = safest — a suggestion given as 5=highest-risk must be flipped to 6−x by the caller before invoking), titleOverride (corrected title shown on the card), quotaOverride (corrected quota text shown in the card's quota row) and summaryOverride (corrected summary shown on the card). Only overlay columns, the three verified score dimensions (plus recomputed scoreTotal/scoreCoverage), and the title/quota/summary override columns are written; source fields, the four rule-scored dimensions, published_at and time_quality are never touched, and hourly refresh never overwrites verified scores or any override column. Omitting an optional parameter leaves that field untouched; pass null explicitly to clear an override.",
    request: z.object({
      source: z.string(),
      externalId: z.string(),
      verifiedRegion: z.string().nullable().optional(),
      verifiedCost: z.string().nullable().optional(),
      verifiedRisk: z.string().nullable().optional(),
      verifiedConditions: z.string().nullable().optional(),
      verifiedAt: z.string().nullable().optional(),
      verifiedSourceUrl: z.string().nullable().optional(),
      verifiedStatus: z.enum(["ok", "ended"]).nullable().optional(),
      /** 核实分数（统一口径 1–5，5=对用户最有利；风险 5=最安全）；null=清除回未知 */
      scoreRisk: z.number().int().min(1).max(5).nullable().optional(),
      scoreUsefulness: z.number().int().min(1).max(5).nullable().optional(),
      scoreAudience: z.number().int().min(1).max(5).nullable().optional(),
      /** 标题覆盖（按官方页修正的标题）；null=清除覆盖、恢复来源原标题 */
      titleOverride: z.string().nullable().optional(),
      /** 额度覆盖（按官方页修正的额度文本）；null=清除覆盖、恢复来源原额度 */
      quotaOverride: z.string().nullable().optional(),
      /** 简介覆盖（按官方页修正的简介）；null=清除覆盖、恢复来源原简介 */
      summaryOverride: z.string().nullable().optional(),
    }),
    response: z.object({ ok: z.boolean(), found: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: boolean; found: boolean }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.posts)
        .where(
          and(
            eq(schema.posts.source, args.source),
            eq(schema.posts.externalId, args.externalId),
          ),
        );
      const row = rows[0];
      if (!row) return { ok: false, found: false };
      const set: Partial<{
        verifiedRegion: string | null;
        verifiedCost: string | null;
        verifiedRisk: string | null;
        verifiedConditions: string | null;
        verifiedAt: string | null;
        verifiedSourceUrl: string | null;
        verifiedStatus: string | null;
        titleOverride: string | null;
        quotaOverride: string | null;
        summaryOverride: string | null;
        scores: string;
        scoreTotal: number | null;
        scoreCoverage: number;
      }> = {};
      if (args.verifiedRegion !== undefined) set.verifiedRegion = args.verifiedRegion;
      if (args.verifiedCost !== undefined) set.verifiedCost = args.verifiedCost;
      if (args.verifiedRisk !== undefined) set.verifiedRisk = args.verifiedRisk;
      if (args.verifiedConditions !== undefined) {
        set.verifiedConditions = args.verifiedConditions;
      }
      if (args.verifiedAt !== undefined) set.verifiedAt = args.verifiedAt;
      if (args.verifiedSourceUrl !== undefined) {
        set.verifiedSourceUrl = args.verifiedSourceUrl;
      }
      if (args.verifiedStatus !== undefined) set.verifiedStatus = args.verifiedStatus;
      if (args.titleOverride !== undefined) set.titleOverride = args.titleOverride;
      if (args.quotaOverride !== undefined) set.quotaOverride = args.quotaOverride;
      if (args.summaryOverride !== undefined) {
        set.summaryOverride = args.summaryOverride;
      }
      // 核实分数落库：只改 risk/usefulness/audience 三个维度，其余四个规则
      // 维度原样保留；scoreTotal/scoreCoverage 按合并后的七项重算。
      if (
        args.scoreRisk !== undefined ||
        args.scoreUsefulness !== undefined ||
        args.scoreAudience !== undefined
      ) {
        const patch: Partial<Pick<PostScores, "risk" | "usefulness" | "audience">> = {};
        if (args.scoreRisk !== undefined) patch.risk = args.scoreRisk;
        if (args.scoreUsefulness !== undefined) patch.usefulness = args.scoreUsefulness;
        if (args.scoreAudience !== undefined) patch.audience = args.scoreAudience;
        const merged = mergeVerifiedScores(parseScores(row.scores), patch);
        set.scores = JSON.stringify(merged.scores);
        set.scoreTotal = merged.total;
        set.scoreCoverage = merged.coverage;
      }
      if (Object.keys(set).length > 0) {
        await db.update(schema.posts).set(set).where(eq(schema.posts.id, row.id));
        ctx.invalidateQueries();
      }
      return { ok: true, found: true };
    },
  }),

  markRead: defineAction({
    description: "Marks one post as read (server-persisted); its composite rank drops by 8.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.posts)
        .set({ isRead: true })
        .where(eq(schema.posts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  markUnread: defineAction({
    description: "Marks one post as unread (server-persisted).",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.posts)
        .set({ isRead: false })
        .where(eq(schema.posts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  selfCheck: defineAction({
    description: "Dry-run self checks: verifies the §7 composite-score examples and the §8 lag-warning trigger using pure functions on synthetic timestamps; writes nothing to the database.",
    request: z.object({}),
    response: z.object({
      scoreCases: z.array(
        z.object({
          name: z.string(),
          expected: z.number(),
          actual: z.number(),
          pass: z.boolean(),
        }),
      ),
      lagDryRun: z.object({
        injectedStaleHours: z.number(),
        triggered: z.boolean(),
        lagHours: z.number().nullable(),
        freshCaseTriggered: z.boolean(),
      }),
      allPass: z.boolean(),
    }),
    async handler() {
      const now = Date.now();
      const DAY = 24 * 3600 * 1000;
      const cases = [
        {
          name: "普通帖 质量4 发布3.5天前 未读",
          expected: 10.0,
          actual: compositeScore(4, now - 3.5 * DAY, false, "exact", false, now),
        },
        {
          name: "同一帖 已读",
          expected: 2.0,
          actual: compositeScore(4, now - 3.5 * DAY, false, "exact", true, now),
        },
        {
          name: "教程帖 质量2 发布15天前 未读",
          expected: 8.0,
          actual: compositeScore(2, now - 15 * DAY, true, "exact", false, now),
        },
        {
          name: "LINUX DO 估算时间 质量0 发布3.5天前 未读",
          expected: 5.0,
          actual: compositeScore(0, now - 3.5 * DAY, false, "estimated", false, now),
        },
      ].map((c) => ({ ...c, pass: Math.abs(c.actual - c.expected) < 1e-9 }));

      // §8 滞后 dry-run：注入 30 小时前的“最新帖时间”，同一纯函数应触发滞后；
      // 注入 1 小时前则不应触发。全程不写正式库。
      const staleLag = lagHoursForLatest(now - 30 * 3600 * 1000, now);
      const freshLag = lagHoursForLatest(now - 1 * 3600 * 1000, now);
      const lagDryRun = {
        injectedStaleHours: 30,
        triggered: staleLag != null,
        lagHours: staleLag,
        freshCaseTriggered: freshLag != null,
      };
      return {
        scoreCases: cases,
        lagDryRun,
        allPass: cases.every((c) => c.pass) && lagDryRun.triggered && !lagDryRun.freshCaseTriggered,
      };
    },
  }),
} satisfies ActionsModule;

// 供定时任务与类型引用
export type { SourceId };
