// 羊毛空间 — 独立配置（任务 §0.5）：词表、阈值、窗口、权重全部集中在此，
// 规则代码（rules.ts）与刷新流水线（refresh.ts）只引用本文件，不硬编码。

export type SourceId =
  | "linuxdo"
  | "v2ex"
  | "nodeseek"
  | "x"
  | "threads"
  | "sliverkiss"
  | "lanmao"
  | "aihot"
  | "jidan"
  | "baipiaoji";

export const SOURCES: { id: SourceId; label: string }[] = [
  { id: "linuxdo", label: "LINUX DO" },
  { id: "v2ex", label: "V2EX" },
  { id: "nodeseek", label: "NodeSeek" },
  { id: "x", label: "X" },
  { id: "threads", label: "Threads" },
  { id: "sliverkiss", label: "Sliverkiss" },
  { id: "lanmao", label: "懒猫 AI" },
  { id: "aihot", label: "AIHot Token 羊毛" },
  { id: "jidan", label: "赛博鸡蛋" },
  { id: "baipiaoji", label: "白嫖计" },
];

/** 目录类来源：常驻优惠目录，由来源方自己维护时效。不适用普通帖 7 天 /
 * 教程 30 天的过期窗口；改为每轮刷新与来源当前列表对账，列表里消失即删除。 */
export const CATALOG_SOURCES: SourceId[] = ["lanmao", "aihot", "jidan", "baipiaoji"];

// ------------------------------------------------ 主题分类（免费额度雷达 v2）

/** 五个主题分类（分类情报区的展示顺序） */
export const CATEGORIES = [
  "大模型 API",
  "AI 应用试用",
  "云服务",
  "开发工具",
  "免费算力",
] as const;
export type CategoryName = (typeof CATEGORIES)[number];

/** 分类映射 v2 第 1 层（只看标题、不含摘要），按顺序命中即定类：
 * 免费算力 → 云服务 → 大模型 API → 开发工具 → 默认 AI 应用试用。
 * 硬性写法：短英文词（API 等）必须词边界匹配；英文产品名/模型名一律
 * 大小写敏感子串（避免 cli 子串误判 OpusClip、video 含 ide 之类问题——
 * 本层根本不做 cli/ide/git 子串匹配）。厂商名绝不单独作云服务信号
 * （七牛云 Conatus、阿里云百炼都是模型 offer，靠其标题里的模型/Token 词归 API）。
 * 边界：超算平台归免费算力（即使消费单位是 Token）；按 offer 内容分而非
 * 产品类型（Zed 编辑器卖模型额度 → 标题含「模型」→ 大模型 API）。 */
export const CATEGORY_COMPUTE_WORDS = [
  "云电脑", "GPU", "算力", "沙箱", "云服务器", "超算", "虚拟机", "云主机", "云手机",
];
export const CATEGORY_CLOUD_WORDS = [
  "云存储", "对象存储", "CDN", "云数据库", "云函数", "云盘", "云服务",
];
export const CATEGORY_API_WORDS = [
  "模型", "Token", "推理", "大模型", "豆包", "通义", "文心", "混元", "星辰",
  "GLM", "GPT", "Claude", "Gemini", "DeepSeek", "Qwen", "Kimi", "LLM",
  "Embedding", "ERNIE", "Ling", "MaaS", "Whisper",
];
/** API 一词必须词边界命中（前后不得紧跟英文字母） */
export const CATEGORY_API_WORD_RE = /(?<![A-Za-z])API(?![A-Za-z])/;
export const CATEGORY_DEV_WORDS = [
  "编程", "代码", "开发", "编辑器", "插件", "终端",
  // 产品名 gazetteer（含「扣子」——扣子 Coze 按纠正规则归开发工具）
  "Copilot", "Cursor", "Comate", "CodeGeeX", "Qoder", "CodeBuddy", "Cline",
  "Coze", "Dify", "n8n", "扣子",
];
export const CATEGORY_DEFAULT: CategoryName = "AI 应用试用";

/** 不收录名单：标题或原始 id 命中即丢弃（OpenRouter Crouton Alpha 免费预览
 * 已结束——隐身期结束的 Muse Ember 早期版本，不作在售免费额度收录）。 */
export const EXCLUDED_TITLE_RE = /crouton/i;

/** 赛博鸡蛋 RSS 只收录的分类（排除“付费折扣”） */
export const JIDAN_CATEGORIES = ["免费试用额度", "免费模型试用", "新用户免费活动"];

// ------------------------------------------------ 七项评分规则表（目录四站）
// 入库/回填时用确定性规则计算（rules.computeScores），定时刷新绝不调大模型。
// 口径统一：七个维度方向一致，5 = 对用户最有利；其中风险维度 5 = 风险最低、
// 最安全，1 = 风险最高。综合分只由已评维度算，未知维度不填 0、不填中值。
// quota / urgency / difficulty / credibility 四项由规则每轮重算；
// risk / usefulness / audience 三项规则恒为 null（未知），只由核实轮次经
// setVerified 写入。核实建议分若按「5=风险最高」的反口径给出，落库前先按
// 6−x 翻转成统一口径再写入（翻转在写入方完成，setVerified 收到的即统一
// 口径分）；一旦写入，刷新重算不得用规则覆盖这三项（规则只能填仍为 null
// 的维度），落库值以核实建议分为准，禁止用规则反推覆盖。

export const SCORE_RULES = {
  /** 额度·Token 类：换算到日均 Token 后按档分（降序首中即定分，其余记最低分） */
  tokenDailyTiers: [
    { min: 100_000_000, score: 5 },
    { min: 10_000_000, score: 4 },
    { min: 1_000_000, score: 3 },
    { min: 100_000, score: 2 },
  ] as { min: number; score: number }[],
  tokenFallbackScore: 1,
  /** 额度·小时类：换算到每月小时后按档分 */
  hoursMonthlyTiers: [
    { min: 20, score: 4 },
    { min: 5, score: 3 },
  ] as { min: number; score: number }[],
  hoursFallbackScore: 2,
  /** 额度·金额类（美元）：按金额分 */
  moneyTiers: [
    { min: 100, score: 4 },
    { min: 20, score: 3 },
  ] as { min: number; score: number }[],
  moneyFallbackScore: 2,
  /** 额度·积分/次数类：按数量分 */
  pointsTiers: [
    { min: 10_000, score: 4 },
    { min: 1_000, score: 3 },
  ] as { min: number; score: number }[],
  pointsFallbackScore: 2,
  /** 周期换算：每月 → 日均除以 30；每天/一次性 → 不除（一次性按总额比日均档） */
  monthlyDivisor: 30,
  /** 紧迫性：绝对到期剩余天数按档分（降序首中即定分，其余记最低分） */
  urgencyDayTiers: [
    { maxDays: 3, score: 5 },
    { maxDays: 7, score: 4 },
    { maxDays: 14, score: 3 },
    { maxDays: 30, score: 2 },
  ] as { maxDays: number; score: number }[],
  urgencyFallbackScore: 1,
  /** 紧迫性：只有相对有效期文本（含 validity=volatile）时的固定分 */
  urgencyRelativeScore: 3,
  /** 紧迫性：无任何到期信息时的固定分（无紧迫性） */
  urgencyNoneScore: 1,
  /** 领取难度：基础分 */
  difficultyBase: 3,
  /** 领取难度：懒猫原始难度标注（conditions 里的「领取难度：X」）→ 基准分 */
  difficultyLanmaoMap: { "低": 5, "中": 3, "高": 1 } as Record<string, number>,
  /** 领取难度：门槛词组，命中一组扣 1 分（条件 + 额度文本扫描；
   * 含「未核实」的分句不计——未核实的要求不算已确认门槛；
   * 充值/付费只认「须/需/后才」的要求式表述，可选充值解锁更高档不算领取门槛） */
  difficultyBarrierGroups: [
    ["实名"], // 须实名认证
    ["邀请码", "受邀", "邀请制", "仅限邀请"], // 须邀请码/受邀
    ["绑卡", "绑定银行卡", "绑定信用卡", "须充值", "需充值", "充值后才", "付费后才"], // 须绑卡或充值
  ] as string[][],
  /** 领取难度：无上述任何门槛时 +1（仅当确有条件/额度文本可判读时） */
  difficultyNoBarrierBonus: 1,
  /** 可信度（来源可追溯程度）：官方直链 + 此天数内核实 → 5 */
  credibilityFreshDays: 30,
  /** 可信度：官方直链或中转 + 此天数内核实 → 4；核实日期超过此天数 → 2 */
  credibilityRecentDays: 90,
  /** 可信度：领取链接为中转的判定标记（URL 含此串或 claimNote 含「中转」） */
  credibilityRelayMarkers: ["lanmao.ai/go"],
} as const;

export const CONFIG = {
  /** §7 总数上限 */
  maxPosts: 700,
  /** §7 新鲜度满分 */
  freshnessMax: 12,
  /** §7 已读扣分 */
  readPenalty: 8,
  /** §8 estimated 新鲜度扣分 */
  estimatedFreshnessPenalty: 1,
  /** §4 基础羊毛词：每个不同词 +baseWordPoints，累计上限 baseWordCap */
  baseWordPoints: 2,
  baseWordCap: 6,
  baseWords: [
    "免费", "限时免费", "限免", "白嫖", "羊毛", "0元", "零元", "永久免费",
    "试用", "体验金", "优惠", "折扣", "特价", "低价", "福利", "补贴",
  ],
  /** §4 额外词：每个 +2，不受上限约束 */
  bonusWords: ["低成本", "零成本", "省钱"],
  bonusWordPoints: 2,
  /** §4/§5 命中任一重点词或 AI 网关 +keywordBonus（不叠加），并绕过阈值；
   * 论坛来源的绕过另须带羊毛信号词（WOOL_SIGNAL_WORDS），教程豁免 */
  keywordBonus: 6,
  /** §4 质量分阈值（按来源） */
  thresholds: {
    v2ex: 2,
    nodeseek: 2,
    linuxdo: 0,
    x: 0,
    threads: 2,
    // Sliverkiss（Telegram 公开频道）按论坛类来源办，与 V2EX/NodeSeek 同档 ≥2
    sliverkiss: 2,
    // 四个目录本身就是精选羊毛目录，与 LINUX DO / X 同档 ≥0
    lanmao: 0,
    aihot: 0,
    jidan: 0,
    baipiaoji: 0,
  } as Record<SourceId, number>,
  /** §6 保留窗口（天） */
  retentionDays: { normal: 7, tutorial: 30 },
  /** §8 每轮最多核验条数 */
  verifyPerRound: 6,
  /** §8 滞后阈值（小时） */
  lagThresholdHours: 24,
  /** §12 刷新总超时（毫秒）与单请求超时 */
  refreshTimeoutMs: 8 * 60 * 1000,
  fetchTimeoutMs: 20 * 1000,
  /** §12 请求间隔限速（毫秒） */
  requestGapMs: 400,
  /** X snowflake 纪元（§8 公式常量） */
  xEpochMs: 1288834974657,
  /** X 推导时间下限：2010-11-01 UTC 之前丢弃 */
  xMinTimeMs: Date.UTC(2010, 10, 1),
} as const;

/** §3.1 求购过滤：标题含以下任一词即丢弃 */
export const BUY_CONTAINS = ["回收", "求购", "收购"];

/** §3.2 纯求推荐/求助：命中以下模式且未被豁免时丢弃 */
export const SEEK_PATTERNS: RegExp[] = [
  /^求(推荐|个|一款|一个|助|大佬|分享|指点|教)/,
  /求推荐/,
  /有没有推荐/,
  /有无推荐/,
  /求个/,
  /求助/,
  /跪求/,
  /谁有.{0,6}(推荐|链接|邀请码)/,
];

/** §3.2 豁免（优先于求推荐过滤）：how-to / 攻略类一律保留 */
export const SEEK_EXEMPT = /怎么|如何|疑问|用啥|教程|攻略|指南/;

/** §5 羊毛信号词表（独立配置）：六个论坛来源（LINUX DO / V2EX / NodeSeek /
 * X / Threads / Sliverkiss）的帖子命中重点词或 AI 网关时，标题或摘要还必须至少含一个
 * 信号词才收录；不含信号词的重点词帖不收、不得分、不入库。
 * 目录四家是精选目录、走原有目录规则，不受此表影响；教程类帖子豁免。 */
export const WOOL_SIGNAL_EXTRA_WORDS = [
  "低成本", "零成本", "省钱", "领", "送", "额度", "抵扣", "积分",
  "邀请码", "兑换码", "赠送", "不要钱", "白拿", "薅", "抽奖", "返现", "直降",
];
/** 信号词全集 = §4 基础羊毛词 + 扩展词 */
export const WOOL_SIGNAL_WORDS: string[] = [
  ...CONFIG.baseWords,
  ...WOOL_SIGNAL_EXTRA_WORDS,
];

/** §5.1 重点词。matcher 在 rules.ts 中按 kind 实现：
 *  - "gpt"：仅 ChatGPT / GPT-5（见 GPT_PATTERNS）
 *  - "word"：严格词边界（muse 不得命中 museum/music）
 *  - "plain"：不区分大小写子串
 *  - "residential"：家宽 IP 的空格/大小写变体 */
export interface KeywordDef {
  id: string;
  label: string;
  kind: "gpt" | "word" | "plain" | "residential";
  term?: string;
}
export const KEYWORDS: KeywordDef[] = [
  { id: "gpt", label: "GPT", kind: "gpt" },
  { id: "claude", label: "Claude", kind: "plain", term: "claude" },
  { id: "muse", label: "Muse", kind: "word", term: "muse" },
  { id: "gemini", label: "Gemini", kind: "plain", term: "gemini" },
  { id: "vps", label: "VPS", kind: "plain", term: "vps" },
  { id: "jiakuan", label: "家宽IP", kind: "residential" },
];
export const GPT_PATTERNS: RegExp[] = [/chat\s?gpt/i, /gpt\s?-\s?5/i];
export const RESIDENTIAL_PATTERNS: RegExp[] = [
  /家宽\s*ip/i,
  /住宅\s*ip/i,
  /residential\s*ip/i,
];

/** §5.2 AI 网关工具（匹配时把文本归一化为小写、去空格/连字符后比对 GATEWAY_NORMALIZED） */
export const GATEWAY_TOOLS: { id: string; label: string }[] = [
  { id: "magpie", label: "Magpie" },
  { id: "ccswitch", label: "CC Switch" },
  { id: "ccr", label: "Claude Code Router" },
  { id: "cliproxyapi", label: "CLIProxyAPI" },
  { id: "omniroute", label: "OmniRoute" },
  { id: "9router", label: "9router" },
];
/** 工具名归一化目标（小写、去空格与连字符） */
export const GATEWAY_NORMALIZED: Record<string, string> = {
  magpie: "magpie",
  ccswitch: "ccswitch",
  ccr: "claudecoderouter",
  cliproxyapi: "cliproxyapi",
  omniroute: "omniroute",
  "9router": "9router",
};
/** magpie 命中所需的网关语境词（须同时出现） */
export const MAGPIE_CONTEXT = [
  "网关", "路由", "claude code", "codex", "agent", "yetone", "模型切换", "订阅切换",
];
/** magpie 排除词（出现任一即排除，优先于一切） */
export const MAGPIE_EXCLUDE = ["emby", "喜鹊", "影视", "媒体库"];

/** §10 自动标签规则 */
export const TAG_RULES = {
  free: ["免费", "白嫖", "0元", "零元"],
  freeEn: /free/i,
  limited: ["限时免费", "限免"],
  lowPrice: ["低价", "特价", "白菜价", "折扣", "优惠"],
  lowPriceCnyMax: 30,
  lowPriceUsdMax: 5,
};

/** §6 教程类判定词 */
export const TUTORIAL_WORDS = ["教程", "攻略", "指南"];
export const TUTORIAL_HOW = ["如何", "怎么"];
export const TUTORIAL_DO = ["注册", "配置", "搭建", "申请"];

/** 各来源的通用羊毛抓取查询（公开搜索/列表过滤用） */
export const WOOL_QUERIES = ["免费", "限免", "白嫖", "羊毛", "低价", "福利"];

/** X 来源的公开搜索查询（§5 重点词专门搜索 + 羊毛词） */
export const X_SEARCH_QUERIES = [
  "site:x.com 免费 白嫖",
  "site:x.com 限免 优惠",
  "site:x.com ChatGPT 免费",
  "site:x.com Claude 免费",
  "site:x.com VPS 免费",
  "site:x.com Gemini 免费",
];

/** LINUX DO search.json 需登录才能用（实测返回“您需要登录才能执行此操作”），
 * 用户未批准登录，刷新流水线不调用它；以下词表仅保留备用。 */
export const LINUXDO_SEARCH_TERMS = [
  "免费", "限免", "白嫖", "chatgpt", "claude", "gemini", "vps", "家宽",
];

/** Threads 公开搜索页查询词（公开页面尝试抓取；官方连接器实测可搜到真实帖，
 * 但后端跑不了连接器 CLI，抓不到就标失败/空，不编造） */
export const THREADS_SEARCH_QUERIES = [
  "免费 GPT",
  "Claude 免费",
  "免费",
  "限免 白嫖",
  "VPS 免费",
];
