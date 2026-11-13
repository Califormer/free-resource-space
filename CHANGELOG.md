# 更新日志 / Changelog

> 中文在前，英文在后。Chinese first, English below.

## 未发布 / Unreleased

- 补齐开源社区文件：`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、`.gitignore`、Issue 模板（Bug 报告 / 数据纠正 / 功能请求）、PR 模板、数据校验 CI（`.github/workflows/validate.yml`）。
- README 顶部增加 Release 与 License 徽章，并增加参与贡献入口。
- Added community files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.gitignore`, issue templates (bug report / data correction / feature request), PR template, and data-validation CI (`.github/workflows/validate.yml`).
- Added Release and License badges to the top of the README, plus a contributing entry point.

## v17 — 2026-11-13

自 v14 以来的变化。Changes since v14.

- v15：筛选区回归顶部 + 分类 chips（来源 TabList 与筛选卡移回统计条之下、三区之上；新增分类 chips 与其它筛选条件 AND 组合）。
- v15: filter panel back to the top, plus category chips (source tabs and the filter card moved back above the three sections; new category chips combine with the other filters with AND).
- v16：翻页与筛选修复——叠加筛选到 0 条时分页控件整体消失、按钮看似无反应；筛选卡与空状态各加「清除全部筛选」按钮，列表上方加「共 N 条 · 第 X / Y 页」计数行。
- v16: pagination and filter fix — when filters matched 0 posts the pager disappeared entirely and buttons looked dead; added a "Clear all filters" button to the filter card and to the empty state, plus a "N results · page X / Y" counter row above the list.
- v17：三区筛选修复——今日新上 / 即将到期 / 分类情报三区改为与主列表共用统一筛选谓词，来源 / 分类 / 开关 / 标签 / 搜索对首屏三区同样生效；筛选卡下方加「当前筛选：共 N 条结果」横幅；搜索匹配范围新增标题 / 简介覆盖文字。
- v17: three-section filter fix — New today / Expiring soon / Browse by category now share one filter predicate with the main list; a "Currently filtered: N results" banner was added under the filter card; search now also matches title/summary override text.
- 数据快照更新：624 条帖子（总数 624/700，未读 620，今日精选 110，已核实 463）。
- Data snapshot updated: 624 posts (624/700 total, 620 unread, 110 Today's Picks, 463 verified).

## v14 — 2026-11-13

首个开源版本。Initial open-source release.

- 完整导出包：前端源码 + 服务端源码 + 数据库迁移（0001–0006）+ 数据快照（612 条帖子，总数 612/700，未读 608，今日精选 102）。
- Complete export package: client source + server source + database migrations (0001–0006) + data snapshot (612 posts; 612/700 total, 608 unread, 102 Today's Picks).
- 10 个公开数据源，每小时自动刷新；确定性规则过滤、分类、打分、去重；已核实覆盖层与三项手动覆盖（标题 / 额度 / 摘要）。
- 10 public sources, hourly auto-refresh; deterministic rules for filtering, classification, scoring, and dedup; verified overlay plus three manual overrides (title / quota / summary).
- 双语 README（中文 + English）与《羊毛空间-复刻提示词.md》。
- Bilingual README (Chinese + English) and the rebuild prompt.
- Release v14 附件：中文版完整包、英文版完整包、GitHub 自动生成的 Source code（zip / tar.gz）。
- Release v14 assets: Chinese full package, English full package, and GitHub-generated Source code (zip / tar.gz).
- 修正：Release 说明里的文件数由 35 更正为 34（drizzle 迁移文件为 7 个）。
- Fixed: file count in the release notes corrected from 35 to 34 (drizzle holds 7 migration files).
