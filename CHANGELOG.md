# 更新日志 / Changelog

> 中文在前，英文在后。Chinese first, English below.

## 未发布 / Unreleased

- 补齐开源社区文件：`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、`.gitignore`、Issue 模板（Bug 报告 / 数据纠正 / 功能请求）、PR 模板、数据校验 CI（`.github/workflows/validate.yml`）。
- README 顶部增加 Release 与 License 徽章，并增加参与贡献入口。
- Added community files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.gitignore`, issue templates (bug report / data correction / feature request), PR template, and data-validation CI (`.github/workflows/validate.yml`).
- Added Release and License badges to the top of the README, plus a contributing entry point.

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
