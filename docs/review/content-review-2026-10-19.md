# 结构改动内容复核（2026-10-19）

## 复核范围

同步前执行 `git fetch origin && git pull --rebase origin main`，结果为 `Already up to date`，工作区干净。按实际历史复核最近 4 个提交（`git log --oneline -4`）：

| Commit | 内容 |
|---|---|
| `6cb7eea` | Align README with current documentation |
| `235a1fb` | Record cross-topic content review |
| `3588c13` | Clarify sidebar navigation ownership |
| `ac67a7e` | docs: audit content structure |

范围差异：上述 4 个提交的合并 diff 为 4 个文件、146 行新增、12 行删除；12 行删除全部是 README 目录树旧写法。B 阶段审计记录称“真重复 0 组”（见 `docs/review/structure-audit-2026-10-19.md:119-129`），但这 4 个提交没有合并正文或删除正文的变更，故不能把该段记录等同于对 B 合并变更的逐段复核。更早的 `51f1bd5` 不在本次 `HEAD~4..HEAD` 范围内。

## 四项核查

### 1. 内容丢失

**结论：本次范围内未发现正文内容丢失；B 阶段实际合并差异未核实。**

- `3588c13` 前的 `README.md:25-45`、`README.zh.md:24-44` 把 `OUTLINE.md`、`todo.md` 放在 `docs/` 树同一代码块之后；提交后对应旧行删除，改为独立的“Repository root / 仓库根目录”部分，并保留两个文件及其说明（当前 `README.md:24-29`、`README.zh.md:24-29`）。这是目录归属呈现的移动，不是内容删除。
- `git diff HEAD~4..HEAD` 未删除任何正文页，也未改动 `SUMMARY.md`；仓库中没有 `SUMMARY.md`。`README` 的旧目录页数说明被新统计口径解释替代，计数本身仍保留（当前 `README.md:32-42`、`README.zh.md:32-42`）。
- **未核实**：若“B 步合并真重复”指 `51f1bd5` 之前或其他提交中的合并，该实际删除块不在上述 4 个提交 diff，无法依照逐条删除→权威页的办法确认搬迁完整性。现有 B 阶段记录列出 3 组不同角度保留、0 组真重复（`docs/review/structure-audit-2026-10-19.md:123-129`），不是被删正文的完整对照表。

### 2. 表述被改错

**结论：数字一致；定位改写没有反转技术含义。**

- 旧版 `README.md:26-41` 与 `README.zh.md:26-41` 中各目录页数在新版 `README.md:32-42`、`README.zh.md:32-42` 原样保留，并明确“不含各目录 `index.md`”（`README.md:49`、`README.zh.md:49`）。逐目录数得正文页：basics 15、database-design 14、advanced-sql 18、internals 20、indexing 12、performance 14、operations 12、security 8、ecosystem 10、tools 8、appendix 5，合计 136。`OUTLINE.md` 声明的 136 项与 sidebar 中的 136 个正文链接相符；sidebar 总计 148 个唯一目标，另含 11 个目录入口和 `/knowledge`。
- README 第一段由 `PostgreSQL knowledge handbook (Chinese)` 改为 `Personal notes, lessons, and experience from a game developer...`；中文由“PostgreSQL 中文知识手册”改为“个人学习笔记、心得与经验……”。这是作者/内容定位调整，不表达 PostgreSQL 功能支持或限制，未发现技术含义反转（当前 `README.md:3`、`README.zh.md:3`）。
- `6cb7eea` 新增索引选型链接：`docs/performance/explain-basics.md:164` 指向 `../indexing/index-selection-decision-tree`，与目标页面主题相符；同段原有链接未由本次提交改动。

### 3. 链接与导航

**结论：本次变更涉及的侧栏权威来源说明正确；侧栏目标存在。构建器级校验未核实。**

- `3588c13` 前 README 称 sidebar 是“全站 136 页的唯一 slug 清单”（旧版 `README.md:39`、`README.zh.md:39`）；提交后改为“authoritative site navigation and route list / 站点导航与路由的权威来源”（当前 `README.md:45`、`README.zh.md:45`）。同时当前统计口径排除目录 index，目录总数 136；sidebar 实有 148 项，包含目录入口、正文路由和知识地图，所以新表述避免了把 136 误当 sidebar 全部链接数。
- 对当前 `docs/.vitepress/sidebar.json` 逐项检查：148 个链接、148 个唯一目标，缺失目标 0。抽查新增的 `explain-basics`→`index-selection-decision-tree` 是查询计划诊断与索引选择的相关主题；B 阶段记录的 psql、复制主题也分别描述上手/进阶/速查、原理/搭建/逻辑复制运维的不同任务（`docs/review/structure-audit-2026-10-19.md:125-127`）。
- **未核实**：VitePress 构建和构建器死链门禁未运行；`docs/review/structure-audit-2026-10-19.md:117` 记录依赖未安装、构建未能启动。文件存在性检查不能代替构建器解析或外链可用性检查。

### 4. 其他问题 / 范围限制

**结论：未发现本次改动引入的其他确定问题。**

- `SUMMARY.md` 大幅精简检查不适用：仓库无此文件，范围内也无此类变更。
- 侧栏 JSON 本身在这 4 个提交中未变；本次核对了当前配置的文件目标及新增的正文链接。B 实际合并的内容保留情况仍受范围限制，见第 1 项。

## 问题清单

| 严重度 | 问题 | 是否已修 | 修复 commit |
|---|---|---|---|
| — | 未发现可由本次 4 个提交 diff 证实的内容丢失、数字错误或指向错误页面。 | 不适用 | 不适用 |
| 未核实 | B 阶段真实合并若发生在本次范围之外，删除段落是否完整搬至权威页无法据当前 diff 判定；需提供/纳入实际合并 commit 才能逐段核查。 | 否（范围限制，不推定为错误） | — |
| 未核实 | VitePress 正式构建及其死链门禁未运行，依赖未安装。 | 否 | — |

## 结论：验收判断

本次所选 4 个提交中，README 目录计数与实际文件数相符，定位文案未改反技术含义，sidebar 目标文件均存在，未发现需直接修复的确定错误。**这 4 个提交可就已检查内容视为通过；整批结构改动暂不能无条件视为已验收**：B 实际合并删除的逐段保留情况与 VitePress 构建仍未核实。未发现需要用户拍板的争议性合并取舍。
