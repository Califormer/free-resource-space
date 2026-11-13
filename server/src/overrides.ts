// 人工核实回填（GLOBAL DEAL HUNTER 第一版指定三条线索）。
// 只回填结构化字段，绝不改 published_at 与 time_quality。
// 每轮刷新在 upsert + 重分类之后按 (source, externalId) 重新套用，保证不被
// 抓取到的通用字段覆盖；带覆盖的条目同时豁免目录下架同步删除——赛博鸡蛋
// RSS 只是最近 40 条的滚动窗口，条目滚出窗口不等于来源方下架，人工已核实
// 并回填的条目按已核实状态保留（其余条目对账规则不变）。

import type { SourceId } from "./config";

export interface PostOverride {
  source: SourceId;
  externalId: string;
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
}

export const POST_OVERRIDES: PostOverride[] = [
  {
    // ZCode（AIHot 记录 zcode-trial-5day，2026-11-13 核实；额度以官方配置页为准）
    source: "aihot",
    externalId: "zcode-trial-5day",
    quota:
      "每天 800 万 Token（GLM-5.3 每天 300 万 + GLM-5.3-Flash 每天 500 万，两模型独立分额、每日刷新）",
    conditions:
      "连接 BigModel 账号；首次使用起算；仅限 ZCode 客户端内使用；桌面端限定；是否须绑卡：未核实",
    deadlineMs: null,
    deadlineText: "首次使用起 5 天",
    claimUrl: "https://zcode.z.ai/cn/docs/configuration",
    claimNote: null,
    region: "未核实",
    lastVerified: "2026-11-13",
    costNote: "免费（AIHot 标注「免费」，新用户体验）",
    riskNote:
      "官方欢迎页数字与配置页不一致（欢迎页写 GLM-5-turbo 200 万/日、合计 500 万/日），本卡以配置页数字为准；额度与规则以供应商页面实时展示为准",
  },
  {
    // ZCode（赛博鸡蛋 RSS 条目；只能从 RSS 回填额度与部分条件，
    // 官方入口/地区/成本/风险无官方依据，填「未核实」）
    source: "jidan",
    externalId: "https://jidan.si/free/252-zcode-new-user-5day-trial-8m-tokens-daily",
    quota: "GLM-5.3 每天 300 万 Token（新用户 5 天免费体验）",
    conditions: "新用户；连接 BigModel 账号后自动获得体验套餐；首次使用起 5 天内有效",
    deadlineText: "首次使用起 5 天",
    claimUrl: null,
    region: "未核实",
    costNote: "未核实",
    riskNote: "未核实",
    rawRef: "https://jidan.si/free/252-zcode-new-user-5day-trial-8m-tokens-daily",
  },
  {
    // 七牛云 Conatus（懒猫条目 qiniu-conatus-free-daily-100m-tokens；
    // 官方页 2026-11-13 打开复核与 2026-11-02 记录内容一致；
    // published_at 与 estimated 时间质量保持现状，不升级）
    source: "lanmao",
    externalId: "qiniu-conatus-free-daily-100m-tokens",
    quota:
      "已实名用户每日 1 亿 Token；任意一笔大于 100 元且已到账的充值后每日 10 亿 Token；未登录/未认证 0 Token；每日 00:00（北京时间）重置，不结转",
    conditions: "实名认证 → 控制台创建 API Key → 调用；模型 ID：qiniu/conatus-free",
    deadlineMs: Date.parse("2026-11-30T23:59:00+08:00"),
    deadlineText: null,
    claimUrl: "https://www.qiniu.com/ai/free-models/conatus-2026",
    claimNote: "懒猫 AI 条目链接为站方中转（lanmao.ai/go），此为官方领取页",
    region: "未核实（懒猫标注中国大陆，官方页未写）",
    lastVerified: "2026-11-02",
    costNote:
      "免费额度本身不收费；更高档（每日 10 亿 Token）需任意一笔大于 100 元且已到账的充值",
    riskNote: "额度用尽直接拒绝请求，不扣余额、不自动切换付费；本期不提供按量付费",
  },
];

/** 覆盖条目的键集合（下架同步豁免用） */
export const OVERRIDE_KEYS: ReadonlySet<string> = new Set(
  POST_OVERRIDES.map((o) => `${o.source}:${o.externalId}`),
);
