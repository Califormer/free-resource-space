import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Post = State["posts"][number];
type SourceStatus = State["sources"][number];

const TYPE_FILTERS = ["免费", "限免", "低价", "教程", "AI网关"] as const;
const PAGE_SIZE = 50;

const dtf = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dtfFull = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtTime(iso: string, timeQuality: string): string {
  const base = dtf.format(new Date(iso));
  if (timeQuality === "estimated") return `约 ${base}`;
  if (timeQuality === "verified") return `${base} · 已核验`;
  return base;
}

function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="chip focus-ring"
      style={{
        borderRadius: 999,
        padding: "6px 12px",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        background: active ? "var(--text)" : "var(--space-surface-alt)",
        color: active ? "var(--on-text)" : "var(--text)",
        border: "none",
        cursor: "pointer",
        minHeight: 44,
      }}
    >
      {label}
      {count != null && (
        <span style={{ opacity: 0.75, marginLeft: 5, fontSize: 12 }}>{count}</span>
      )}
    </button>
  );
}

function FilterSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="focus-ring"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "4px 2px",
        fontSize: 14,
        color: "var(--text)",
        borderRadius: 6,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 42,
          height: 24,
          borderRadius: 999,
          background: checked ? "var(--accent)" : "var(--switch-off)",
          position: "relative",
          flexShrink: 0,
          transition: "background 0.15s ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 21 : 3,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.15s ease",
          }}
        />
      </span>
      {label}
    </button>
  );
}

function SourceLine({ s }: { s: SourceStatus }) {
  const statusText =
    s.status === "ok"
      ? `正常 · 本轮抓取 ${s.fetchedCount} 条 · 库内 ${s.storedCount} 条`
      : s.status === "failed"
        ? `抓取失败 · 库内保留 ${s.storedCount} 条${s.error ? ` · ${s.error}` : ""}`
        : `暂无数据 · 库内 ${s.storedCount} 条${s.error ? ` · ${s.error}` : ""}`;
  return (
    <div style={{ fontSize: 12.5, color: "var(--dim)", lineHeight: 1.7 }}>
      <span style={{ color: "var(--text)", fontWeight: 600 }}>{s.label}</span>
      {"："}
      {statusText}
      {s.lagHours != null && (
        <span style={{ color: "var(--warn)", fontWeight: 600 }}>
          {" · "}
          {s.label} 滞后 {Math.floor(s.lagHours)} 小时
        </span>
      )}
    </div>
  );
}

/** 目录条目的结构化明细（免费额度雷达 11 项中的结构化部分）。
 * fallback 口径：到期没公布写「未公布」；无官方依据标「未核实」；
 * 风险取不到时带通用提示；成本严禁无依据写 0 元（只显示未核实）。
 * 核实覆盖层：verified 值存在时优先显示 verified 值，并带已核实标记。 */
function CatalogDetails({ post }: { post: Post }) {
  const deadlineText = post.deadline
    ? dtfFull.format(new Date(post.deadline))
    : (post.deadlineText ?? "未公布");
  const hasVerified = Boolean(
    post.verifiedRegion ||
      post.verifiedCost ||
      post.verifiedRisk ||
      post.verifiedConditions ||
      post.verifiedAt ||
      post.verifiedSourceUrl,
  );
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "额度",
      value:
        post.quotaOverride != null ? (
          <span>
            {post.quotaOverride}
            <span style={{ color: "var(--dim)", fontSize: 12, marginLeft: 6 }}>
              额度已按官方页修正
            </span>
          </span>
        ) : (
          (post.quota ?? "未核实")
        ),
    },
    { label: "领取条件", value: post.verifiedConditions ?? post.conditions ?? "未核实" },
    { label: "适用地区", value: post.verifiedRegion ?? post.region ?? "未核实" },
    { label: "成本", value: post.verifiedCost ?? post.costNote ?? "未核实" },
    {
      label: "风险",
      value:
        post.verifiedRisk ??
        post.riskNote ??
        "未核实（通用提示：额度与规则以官方页实时展示为准）",
    },
    { label: "到期时间", value: deadlineText },
    {
      label: "官方领取入口",
      value: post.claimUrl ? (
        <span>
          <a
            href={post.claimUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring"
            style={{ color: "var(--accent)", overflowWrap: "anywhere", borderRadius: 4 }}
          >
            {post.claimUrl}
          </a>
          {post.claimNote && <span style={{ color: "var(--dim)" }}>（{post.claimNote}）</span>}
        </span>
      ) : (
        "未核实"
      ),
    },
    { label: "最后核实", value: post.lastVerified ?? "未核实" },
  ];
  return (
    <div
      style={{
        margin: "10px 0 0",
        padding: "10px 12px",
        background: "var(--space-surface-alt)",
        borderRadius: 8,
      }}
    >
      {hasVerified && (
        <div
          style={{
            fontSize: 12.5,
            marginBottom: 8,
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span
            style={{
              background: "var(--accent)",
              color: "var(--on-accent)",
              borderRadius: 6,
              padding: "2px 8px",
              fontWeight: 600,
            }}
          >
            已核实
          </span>
          {post.verifiedAt && <span style={{ color: "var(--dim)" }}>{post.verifiedAt}</span>}
          {post.verifiedSourceUrl && (
            <a
              href={post.verifiedSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring"
              style={{ color: "var(--accent)", overflowWrap: "anywhere", borderRadius: 4 }}
            >
              核实证据
            </a>
          )}
        </div>
      )}
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          columnGap: 12,
          rowGap: 5,
          fontSize: 12.5,
          lineHeight: 1.55,
        }}
      >
        {rows.map((r) => (
          <div key={r.label} style={{ display: "contents" }}>
            <dt style={{ color: "var(--dim)", fontWeight: 600, whiteSpace: "nowrap" }}>{r.label}</dt>
            <dd style={{ margin: 0, color: "var(--text)", overflowWrap: "anywhere" }}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 七项评分（仅目录四站）：综合分与「已评 N/7」在顶部，7 个维度逐行小分，
 * 未知维度显示「未知」，不显示假分数。可信度维度按口径命名为「来源可信度」。 */
const SCORE_DIMS: { key: keyof Post["scores"]; label: string }[] = [
  { key: "quota", label: "额度" },
  { key: "urgency", label: "紧迫性" },
  { key: "difficulty", label: "领取难度" },
  { key: "credibility", label: "来源可信度" },
  { key: "risk", label: "风险" },
  { key: "usefulness", label: "实用性" },
  { key: "audience", label: "适用人群" },
];

function ScoreBlock({ post }: { post: Post }) {
  if (post.scoreCoverage === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        综合分 {post.scoreTotal != null ? post.scoreTotal.toFixed(1) : "—"}
        <span style={{ color: "var(--dim)", fontWeight: 400, marginLeft: 8 }}>
          已评 {post.scoreCoverage}/7
        </span>
      </div>
      <dl
        style={{
          margin: "6px 0 0",
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 16px",
          fontSize: 12.5,
          lineHeight: 1.55,
        }}
      >
        {SCORE_DIMS.map((d) => {
          const v = post.scores[d.key];
          return (
            <div key={d.key} style={{ display: "flex", gap: 6 }}>
              <dt style={{ color: "var(--dim)" }}>{d.label}</dt>
              <dd
                style={{
                  margin: 0,
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  color: v == null ? "var(--dim)" : "var(--text)",
                }}
              >
                {v == null ? "未知" : v}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function PostCard({
  post,
  isCatalog,
  onMarkRead,
  onMarkUnread,
}: {
  post: Post;
  isCatalog: boolean;
  onMarkRead: (id: number) => void;
  onMarkUnread: (id: number) => void;
}) {
  return (
    <article
      style={{
        background: post.isRead ? "var(--surface-read)" : "var(--surface)",
        border: "1px solid var(--border)",
        borderLeft: post.todayPick ? "3px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: 12,
        padding: "16px 18px",
        opacity: post.isRead ? "var(--read-opacity)" : 1,
      }}
    >
      <a
        href={post.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          if (!post.isRead) onMarkRead(post.id);
        }}
        className="focus-ring"
        style={{
          color: post.isRead ? "var(--dim)" : "var(--text)",
          textDecoration: "none",
          fontSize: 17,
          fontWeight: 600,
          lineHeight: 1.5,
          display: "block",
          overflowWrap: "anywhere",
          borderRadius: 4,
        }}
      >
        {post.titleOverride ?? post.title}
      </a>
      {post.titleOverride != null && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--dim)" }}>
          标题已按官方页修正
        </p>
      )}
      {(post.summaryOverride ?? post.summary) && (
        <p
          style={{
            margin: "8px 0 0",
            fontSize: 13.5,
            color: "var(--dim)",
            lineHeight: 1.6,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {post.summaryOverride ?? post.summary}
        </p>
      )}
      {post.summaryOverride != null && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--dim)" }}>
          简介已按官方页修正
        </p>
      )}
      {isCatalog && <ScoreBlock post={post} />}
      {isCatalog && <CatalogDetails post={post} />}
      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          fontSize: 12.5,
          color: "var(--dim)",
        }}
      >
        <span
          style={{
            background: "var(--space-surface-alt)",
            color: "var(--text)",
            borderRadius: 6,
            padding: "2px 8px",
            fontWeight: 600,
          }}
        >
          {post.sourceLabel}
        </span>
        {isCatalog && (
          <span
            style={{
              background: "var(--space-surface-alt)",
              color: "var(--text)",
              borderRadius: 6,
              padding: "2px 8px",
              fontWeight: 600,
            }}
          >
            {post.category}
          </span>
        )}
        {!post.isRead && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: "var(--accent)",
              fontWeight: 600,
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }}
            />
            未读
          </span>
        )}
        {post.isRead && (
          <span
            style={{
              background: "var(--space-surface-alt)",
              color: "var(--dim)",
              borderRadius: 6,
              padding: "2px 8px",
              fontWeight: 600,
            }}
          >
            已读
          </span>
        )}
        {post.todayPick && (
          <span
            style={{
              background: "var(--accent)",
              color: "var(--on-accent)",
              borderRadius: 6,
              padding: "2px 8px",
              fontWeight: 600,
            }}
          >
            今日精选
          </span>
        )}
        {post.verifiedStatus === "ended" && (
          <span
            style={{
              background: "var(--warn)",
              color: "#16181d",
              borderRadius: 6,
              padding: "2px 8px",
              fontWeight: 600,
            }}
          >
            已结束
          </span>
        )}
        {post.tags.map((t) => (
          <span key={t} style={{ color: "var(--dim)", fontWeight: 600 }}>
            {t}
          </span>
        ))}
        <span>{fmtTime(post.publishedAt, post.timeQuality)}</span>
        <span
          style={{
            marginLeft: "auto",
            fontWeight: 600,
            color: "var(--text)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          综合 {post.rank.toFixed(1)}
        </span>
        {post.isRead && (
          <button
            type="button"
            aria-label={`将《${post.title}》标为未读`}
            onClick={() => onMarkUnread(post.id)}
            className="focus-ring"
            style={{
              background: "none",
              border: "none",
              color: "var(--text)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              padding: "6px 4px",
              minHeight: 44,
              borderRadius: 4,
            }}
          >
            标为未读
          </button>
        )}
      </div>
    </article>
  );
}

/** 页码窗口：总数 ≤7 全列；否则 1 … 当前±1 … 末页 */
function pageWindow(page: number, pageCount: number): (number | "…")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const keep = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const nums = [...keep].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const n of nums) {
    if (prev && n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
}) {
  const [jumpValue, setJumpValue] = useState("");
  const [jumpMsg, setJumpMsg] = useState<string | null>(null);

  const submitJump = () => {
    const raw = jumpValue.trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
      setJumpMsg(`请输入 1–${pageCount} 之间的页码`);
      return;
    }
    const target = Math.min(Math.max(1, n), pageCount);
    if (target !== n) {
      setJumpMsg(`已跳到第 ${target} 页（共 ${pageCount} 页，输入已修正）`);
    } else {
      setJumpMsg(null);
    }
    setJumpValue("");
    onChange(target);
  };

  const btnStyle = (disabled: boolean): CSSProperties => ({
    minWidth: 44,
    minHeight: 44,
    padding: "0 12px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 14,
    fontVariantNumeric: "tabular-nums",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1,
  });
  return (
    <nav
      aria-label="分页"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        marginTop: 20,
      }}
    >
      <button
        type="button"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="focus-ring"
        style={btnStyle(page <= 1)}
      >
        上一页
      </button>
      <span className="pager-numbers">
        {pageWindow(page, pageCount).map((n, i) =>
          n === "…" ? (
            <span
              key={`gap-${i}`}
              aria-hidden="true"
              style={{ color: "var(--dim)", padding: "0 2px", alignSelf: "center" }}
            >
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              aria-label={`第 ${n} 页`}
              aria-current={n === page ? "page" : undefined}
              onClick={() => onChange(n)}
              className="focus-ring"
              style={{
                ...btnStyle(false),
                background: n === page ? "var(--text)" : "var(--surface)",
                color: n === page ? "var(--on-text)" : "var(--text)",
                fontWeight: n === page ? 600 : 400,
              }}
            >
              {n}
            </button>
          ),
        )}
      </span>
      <button
        type="button"
        aria-label="下一页"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
        className="focus-ring"
        style={btnStyle(page >= pageCount)}
      >
        下一页
      </button>
      <span
        aria-live="polite"
        style={{
          width: "100%",
          textAlign: "center",
          fontSize: 13,
          color: "var(--dim)",
          fontVariantNumeric: "tabular-nums",
          marginTop: 4,
        }}
      >
        第 {page} / {pageCount} 页
      </span>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitJump();
        }}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 8,
          marginTop: 4,
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          aria-label={`跳转页码，输入 1 到 ${pageCount} 之间的页码`}
          placeholder={`1–${pageCount}`}
          value={jumpValue}
          onChange={(e) => setJumpValue(e.target.value)}
          className="focus-ring"
          style={{
            width: 84,
            minHeight: 44,
            border: "1px solid var(--border)",
            background: "var(--space-surface-alt)",
            borderRadius: 10,
            padding: "8px 10px",
            fontSize: 14,
            color: "var(--text)",
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        />
        <button
          type="submit"
          className="focus-ring"
          style={{
            minHeight: 44,
            padding: "0 18px",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text)",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          跳转
        </button>
      </form>
      {jumpMsg && (
        <p
          aria-live="polite"
          style={{
            width: "100%",
            textAlign: "center",
            fontSize: 13,
            color: "var(--warn)",
            margin: "2px 0 0",
          }}
        >
          {jumpMsg}
        </p>
      )}
    </nav>
  );
}

type Theme = "dark" | "light";
const THEME_KEY = "yangmao-theme";
let memoryTheme: Theme = "dark"; // localStorage 不可用时的内存兜底

function readStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") {
      memoryTheme = v;
      return v;
    }
  } catch {
    /* localStorage 不可用 → 用内存兜底 */
  }
  return memoryTheme;
}

export function App() {
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    memoryTheme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 写不进 localStorage 时内存兜底已生效 */
    }
  }, [theme]);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [todayOnly, setTodayOnly] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [keyword, setKeyword] = useState<string | null>(null);
  const [gatewayOnly, setGatewayOnly] = useState(false);
  const [sortMode, setSortMode] = useState<"rank" | "deadline" | "score">("rank");
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"catalog" | "all">("catalog");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [zoneCategory, setZoneCategory] = useState<string>("大模型 API");
  const [statusOpen, setStatusOpen] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });

  const refresh = useMutation({
    mutationFn: async () => await api.refresh({ trigger: "manual" }),
    onSuccess: (r) => {
      if (r.status === "already_running") {
        setRefreshMsg("已有刷新正在运行，请稍后再试");
      } else {
        const parts = Object.entries(r.perSource)
          .map(([k, v]) => `${k} 抓取 ${v.fetched}/过滤 ${v.filtered}/收录 ${v.kept}`)
          .join("；");
        setRefreshMsg(`刷新完成：${parts}；过期清理 ${r.expiredRemoved}，下架删除 ${r.delistedRemoved}，裁剪 ${r.trimmed}，核验 ${r.verified}`);
      }
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setRefreshMsg(`刷新失败：${String(e)}`),
  });

  const markRead = useMutation({
    mutationFn: async (id: number) => await api.markRead({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const markUnread = useMutation({
    mutationFn: async (id: number) => await api.markUnread({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const data = state.data;

  // 任一筛选条件变化 → 回到第 1 页（翻页本身不触发，因为 page 不在依赖里）
  useEffect(() => {
    setPage(1);
  }, [sourceFilter, unreadOnly, todayOnly, types, keyword, gatewayOnly, query, searchScope, sortMode, categoryFilter]);

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of data?.posts ?? []) counts.set(p.source, (counts.get(p.source) ?? 0) + 1);
    return counts;
  }, [data]);

  // 顶部统计随来源 Tab 同步：选中某来源时统计只算该来源
  const statsBase = useMemo(() => {
    if (!data) return [];
    return sourceFilter === "all"
      ? data.posts
      : data.posts.filter((p) => p.source === sourceFilter);
  }, [data, sourceFilter]);

  const catalogSet = useMemo(
    () => new Set(data?.catalogSources ?? []),
    [data],
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.posts.filter((p) => {
      if (sourceFilter !== "all" && p.source !== sourceFilter) return false;
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (unreadOnly && p.isRead) return false;
      if (todayOnly && !p.todayPick) return false;
      if (types.length > 0 && !types.some((t) => p.tags.includes(t))) return false;
      if (keyword && !p.keywordIds.includes(keyword)) return false;
      if (gatewayOnly && p.gatewayIds.length === 0) return false;
      if (q) {
        // 搜索范围：默认目录四站，可切换全库（范围只在有关键词时生效）
        if (searchScope === "catalog" && !catalogSet.has(p.source)) return false;
        // 三字段匹配：标题 + 摘要 + 厂商/来源名（不做拼音、不做模糊）
        const hit =
          p.title.toLowerCase().includes(q) ||
          p.summary.toLowerCase().includes(q) ||
          (p.vendor ?? "").toLowerCase().includes(q) ||
          p.sourceLabel.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [data, sourceFilter, categoryFilter, unreadOnly, todayOnly, types, keyword, gatewayOnly, query, searchScope, catalogSet]);

  // 首页三区（只含目录四站条目；论坛/Sliverkiss 留在下方主列表）
  const catalogPosts = useMemo(
    () => (data ? data.posts.filter((p) => catalogSet.has(p.source)) : []),
    [data, catalogSet],
  );
  const DAY_MS = 24 * 3600 * 1000;
  const nowMs = Date.now();
  const newToday = useMemo(
    () =>
      catalogPosts.filter(
        (p) =>
          p.verifiedStatus !== "ended" &&
          (nowMs - Date.parse(p.publishedAt) <= DAY_MS ||
            nowMs - Date.parse(p.firstSeen) <= DAY_MS),
      ),
    [catalogPosts, nowMs, DAY_MS],
  );
  const expiring = useMemo(
    () =>
      catalogPosts
        .filter((p) => {
          if (p.verifiedStatus === "ended") return false;
          if (!p.deadline) return false;
          const diff = Date.parse(p.deadline) - nowMs;
          return diff > 0 && diff <= 30 * DAY_MS;
        })
        .sort((a, b) => Date.parse(a.deadline as string) - Date.parse(b.deadline as string)),
    [catalogPosts, nowMs, DAY_MS],
  );
  const zonePosts = useMemo(
    () => catalogPosts.filter((p) => p.category === zoneCategory).slice(0, 10),
    [catalogPosts, zoneCategory],
  );

  // 列表排序（作用于当前筛选结果全集）：
  // - deadline：有绝对到期日的按到期升序在前，无绝对到期日的沉底
  //   （组内保持综合排名序；只有目录条目带绝对 deadline，其余自然沉底）
  // - score：先按已评维度数 coverage 降序，再按综合分 scoreTotal 降序
  //   （未评分条目 coverage=0、scoreTotal=null 自然沉底），同分按综合排名
  // - rank：默认综合排名（getState 已排序，filtered 保持该顺序）
  const sorted = useMemo(() => {
    if (sortMode === "rank") return filtered;
    if (sortMode === "deadline") {
      const dated = filtered
        .filter((p) => p.deadline)
        .sort(
          (a, b) =>
            Date.parse(a.deadline as string) - Date.parse(b.deadline as string) ||
            b.rank - a.rank,
        );
      const undated = filtered.filter((p) => !p.deadline);
      return [...dated, ...undated];
    }
    return [...filtered].sort(
      (a, b) =>
        b.scoreCoverage - a.scoreCoverage ||
        (b.scoreTotal ?? -1) - (a.scoreTotal ?? -1) ||
        b.rank - a.rank,
    );
  }, [filtered, sortMode]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const goPage = (p: number) => {
    setPage(Math.min(Math.max(1, p), pageCount));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  };

  const toggleIn = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const statCard: CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "14px 16px",
    minWidth: 0,
  };

  return (
    <main
      style={{
        background: "var(--bg)",
        color: "var(--text)",
        minHeight: "100vh",
        padding: "20px 16px 48px",
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        {/* 右上主题切换：默认深色，切换状态存 localStorage */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <button
            type="button"
            role="switch"
            aria-checked={theme === "dark"}
            aria-label={theme === "dark" ? "当前深色主题，切换到浅色主题" : "当前浅色主题，切换到深色主题"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="focus-ring"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              minHeight: 44,
              padding: "6px 14px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: theme === "dark" ? "#16181d" : "#f7f7f5",
                border: "2px solid var(--dim)",
                flexShrink: 0,
              }}
            />
            {theme === "dark" ? "深色主题" : "浅色主题"}
          </button>
        </div>

        {/* 顶部统计：4 格卡片（手机 <640px 自动 2×2） */}
        <section aria-label="统计" className="stats-grid" style={{ marginBottom: 16 }}>
          <div style={statCard}>
            <div className="stat-num">
              {data ? (
                <>
                  {statsBase.length}
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--dim)" }}>
                    {" / "}
                    {data.cap}
                  </span>
                </>
              ) : (
                "—"
              )}
            </div>
            <div className="stat-label">总数 / 上限</div>
          </div>
          <div style={statCard}>
            <div className="stat-num">{data ? statsBase.filter((p) => !p.isRead).length : "—"}</div>
            <div className="stat-label">未读</div>
          </div>
          <div style={statCard}>
            <div className="stat-num">{data ? statsBase.filter((p) => p.todayPick).length : "—"}</div>
            <div className="stat-label">今日精选</div>
          </div>
          <button
            type="button"
            aria-label="立即刷新"
            disabled={refresh.isPending}
            onClick={() => {
              setRefreshMsg(null);
              refresh.mutate();
            }}
            className="focus-ring"
            style={{
              background: "var(--accent)",
              color: "var(--on-accent)",
              border: "none",
              borderRadius: 12,
              fontSize: 16,
              fontWeight: 600,
              cursor: refresh.isPending ? "wait" : "pointer",
              opacity: refresh.isPending ? 0.65 : 1,
              minHeight: 44,
            }}
          >
            {refresh.isPending ? "刷新中…" : "刷新"}
          </button>
        </section>

        {refreshMsg && (
          <p style={{ fontSize: 13, color: "var(--dim)", margin: "0 0 16px", lineHeight: 1.6 }}>
            {refreshMsg}
          </p>
        )}

        {/* 来源 TabList */}
        <div
          role="tablist"
          aria-label="来源筛选"
          className="tab-scroll"
          style={{ display: "flex", flexWrap: "nowrap", gap: 8, marginBottom: 16, paddingBottom: 2 }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={sourceFilter === "all"}
            onClick={() => setSourceFilter("all")}
            className="focus-ring"
            style={{
              borderRadius: 999,
              padding: "6px 14px",
              fontSize: 13.5,
              flexShrink: 0,
              whiteSpace: "nowrap",
              fontWeight: sourceFilter === "all" ? 600 : 400,
              background: sourceFilter === "all" ? "var(--text)" : "var(--surface)",
              color: sourceFilter === "all" ? "var(--on-text)" : "var(--text)",
              border: "1px solid var(--border)",
              cursor: "pointer",
              minHeight: 44,
            }}
          >
            全部
            <span
              style={{
                opacity: 0.75,
                marginLeft: 5,
                fontSize: 12,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {data ? data.total : ""}
            </span>
          </button>
          {(data?.sources ?? []).map((s) => {
            const active = sourceFilter === s.source;
            return (
              <button
                key={s.source}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSourceFilter(s.source)}
                className="focus-ring"
                style={{
                  borderRadius: 999,
                  padding: "6px 14px",
                  fontSize: 13.5,
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  fontWeight: active ? 600 : 400,
                  background: active ? "var(--text)" : "var(--surface)",
                  color: active ? "var(--on-text)" : "var(--text)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  minHeight: 44,
                }}
              >
                {s.label}
                <span
                  style={{
                    opacity: 0.75,
                    marginLeft: 5,
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {sourceCounts.get(s.source) ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        {/* 筛选卡片 */}
        <section
          aria-label="筛选条件"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "16px 18px",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 13, color: "var(--dim)" }}>排序</span>
            <Chip
              label="综合排名"
              active={sortMode === "rank"}
              onClick={() => setSortMode("rank")}
            />
            <Chip
              label="按到期时间"
              active={sortMode === "deadline"}
              onClick={() => setSortMode("deadline")}
            />
            <Chip
              label="按综合分"
              active={sortMode === "score"}
              onClick={() => setSortMode("score")}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "4px 24px",
              marginBottom: 12,
            }}
          >
            <FilterSwitch label="仅看未读" checked={unreadOnly} onChange={setUnreadOnly} />
            <FilterSwitch label="仅看今日精选" checked={todayOnly} onChange={setTodayOnly} />
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 13, color: "var(--dim)" }}>分类</span>
            <Chip
              label="全部"
              active={categoryFilter === "all"}
              onClick={() => setCategoryFilter("all")}
            />
            {(data?.categoryCounts ?? []).map((c) => (
              <Chip
                key={c.category}
                label={c.category}
                count={c.count}
                active={categoryFilter === c.category}
                onClick={() => setCategoryFilter(c.category)}
              />
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {TYPE_FILTERS.map((t) => (
              <Chip
                key={t}
                label={t}
                active={types.includes(t)}
                onClick={() => toggleIn(types, t, setTypes)}
              />
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            {(data?.keywordCounts ?? []).map((k) => (
              <Chip
                key={k.id}
                label={k.label}
                count={k.count}
                active={keyword === k.id}
                onClick={() => setKeyword(keyword === k.id ? null : k.id)}
              />
            ))}
            <Chip
              label="AI网关"
              count={data?.gatewayCount}
              active={gatewayOnly}
              onClick={() => setGatewayOnly(!gatewayOnly)}
            />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="search"
              aria-label="关键词搜索（标题、摘要、厂商）"
              placeholder="搜索标题 / 摘要 / 厂商"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="focus-ring"
              style={{
                flex: "1 1 220px",
                border: "1px solid var(--border)",
                background: "var(--space-surface-alt)",
                borderRadius: 10,
                padding: "10px 14px",
                fontSize: 14,
                color: "var(--text)",
                minHeight: 44,
              }}
            />
            <span style={{ fontSize: 13, color: "var(--dim)" }}>搜索范围</span>
            <Chip
              label="目录四站"
              active={searchScope === "catalog"}
              onClick={() => setSearchScope("catalog")}
            />
            <Chip
              label="全库"
              active={searchScope === "all"}
              onClick={() => setSearchScope("all")}
            />
          </div>
          <button
            type="button"
            aria-expanded={statusOpen}
            onClick={() => setStatusOpen(!statusOpen)}
            className="focus-ring"
            style={{
              background: "none",
              border: "none",
              color: "var(--dim)",
              fontSize: 12.5,
              cursor: "pointer",
              padding: "10px 0 0",
              minHeight: 44,
              borderRadius: 4,
            }}
          >
            {statusOpen ? "收起来源状态" : "来源状态与最后刷新"} {statusOpen ? "▲" : "▼"}
          </button>
          {statusOpen && data && (
            <div style={{ marginTop: 6 }}>
              {(data.sources ?? []).map((s) => (
                <SourceLine key={s.source} s={s} />
              ))}
              <div style={{ fontSize: 12.5, color: "var(--dim)", lineHeight: 1.7 }}>
                最后刷新：
                {data.lastRefreshAt ? dtfFull.format(new Date(data.lastRefreshAt)) : "尚未刷新"}
                {" · "}
                {data.scheduleNote}
              </div>
            </div>
          )}
        </section>

        {/* 首页三区（仅目录四站） */}
        {data && (
          <>
            {newToday.length > 0 && (
              <section aria-label="今日新上" style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 10px" }}>
                  今日新上（{newToday.length} 条）
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {newToday.slice(0, 8).map((p) => (
                    <PostCard
                      key={`new-${p.id}`}
                      post={p}
                      isCatalog
                      onMarkRead={(id) => markRead.mutate(id)}
                      onMarkUnread={(id) => markUnread.mutate(id)}
                    />
                  ))}
                </div>
              </section>
            )}
            <section aria-label="即将到期" style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 10px" }}>
                即将到期 · 30 天内到期（{expiring.length} 条）
              </h2>
              {expiring.length === 0 ? (
                <p style={{ fontSize: 13.5, color: "var(--dim)", margin: 0 }}>
                  暂无 30 天内到期的条目
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {expiring.map((p) => (
                    <PostCard
                      key={`exp-${p.id}`}
                      post={p}
                      isCatalog
                      onMarkRead={(id) => markRead.mutate(id)}
                      onMarkUnread={(id) => markUnread.mutate(id)}
                    />
                  ))}
                </div>
              )}
            </section>
            <section aria-label="分类情报" style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 10px" }}>分类情报</h2>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                {(data.categoryCounts ?? []).map((c) => (
                  <Chip
                    key={c.category}
                    label={c.category}
                    count={c.count}
                    active={zoneCategory === c.category}
                    onClick={() => setZoneCategory(c.category)}
                  />
                ))}
              </div>
              {zonePosts.length === 0 ? (
                <p style={{ fontSize: 13.5, color: "var(--dim)", margin: 0 }}>暂无</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {zonePosts.map((p) => (
                    <PostCard
                      key={`cat-${p.id}`}
                      post={p}
                      isCatalog
                      onMarkRead={(id) => markRead.mutate(id)}
                      onMarkUnread={(id) => markUnread.mutate(id)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* 列表（仅渲染当前页） */}
        {state.isPending && (
          <p style={{ color: "var(--dim)", fontSize: 15, padding: "32px 0" }}>加载中…</p>
        )}
        {state.error && (
          <p style={{ color: "var(--warn)", fontSize: 15, padding: "32px 0" }}>
            加载失败：{String(state.error)}
          </p>
        )}
        {data && sorted.length === 0 && (
          <section
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "36px 24px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
              {data.total === 0
                ? "暂无真实抓取数据"
                : sourceFilter !== "all"
                  ? "该来源在当前筛选下暂无帖子"
                  : "当前筛选下暂无帖子"}
            </div>
            <p
              style={{
                fontSize: 13.5,
                color: "var(--dim)",
                lineHeight: 1.7,
                margin: "0 auto 14px",
                maxWidth: 520,
              }}
            >
              {data.total === 0
                ? "可以点上方刷新重新抓取；各来源状态如下。"
                : "可以放宽筛选条件（关掉「仅看未读 / 仅看今日精选」，或把来源、分类切回「全部」，或清空搜索词）再看。"}
            </p>
            <div style={{ maxWidth: 520, margin: "0 auto", textAlign: "left" }}>
              {data.sources.map((s) => (
                <SourceLine key={s.source} s={s} />
              ))}
            </div>
          </section>
        )}
        {data && sorted.length > 0 && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {pageItems.map((p) => (
                <PostCard
                  key={p.id}
                  post={p}
                  isCatalog={catalogSet.has(p.source)}
                  onMarkRead={(id) => markRead.mutate(id)}
                  onMarkUnread={(id) => markUnread.mutate(id)}
                />
              ))}
            </div>
            <Pager page={currentPage} pageCount={pageCount} onChange={goPage} />
          </>
        )}
      </div>
    </main>
  );
}
