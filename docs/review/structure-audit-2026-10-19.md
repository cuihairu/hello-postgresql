# hello-postgresql 目录与内容组织审计（2026-10-19）

## 范围与方法

只读检查仓库目录、Markdown 统计、VitePress 配置、侧边栏和本地 Markdown 链接；本次唯一新增文件为本报告。按 `docs/<一级目录>/*.md` 统计一级子目录中的页面数与 `wc -l` 行数，不含 `docs/` 根页、配置、静态资源和本报告。编号检查覆盖文档文件名前缀及主目录入口标题/侧边栏部分编号；不是正文中的有序列表编号。

## 量化事实

### docs 一级目录页面量

| 一级目录 | .md 数 | 总行数 |
|---|---:|---:|
| advanced-sql | 19 | 2,911 |
| appendix | 6 | 612 |
| basics | 16 | 2,345 |
| database-design | 15 | 1,935 |
| ecosystem | 11 | 1,185 |
| indexing | 13 | 1,805 |
| internals | 21 | 2,537 |
| operations | 13 | 1,826 |
| performance | 15 | 1,952 |
| security | 9 | 1,045 |
| tools | 9 | 1,023 |
| **合计（11 个目录）** | **147** | **19,176** |

另有 `docs/index.md`（首页）和 `docs/knowledge.md`（复习地图），故 `docs/` 当前共 149 个 Markdown 页面（不含本报告）。README 中的“15/14/18…”按正文页排除了各目录的 `index.md`，数量与此口径吻合，见 `README.zh.md:28-38`。

### 并行组织轴

按读者如何找到内容计算有 **4 套并行组织方式**。前三套是互补入口，第四套是维护/复习索引；不是四套互相竞争的完整分类法。

| 目录/入口 | 条目数 | 命名规律 | 有无编号 | 编号是否连续 |
|---|---:|---|---|---|
| 十个主主题目录及附录（`docs/basics/` 至 `docs/appendix/`） | 147 篇，分布 11 目录 | 英文 kebab-case slug；每目录 `index.md` 导览，其余按主题命名 | 目录不编号；入口标题带“第N部分” | 1–10 连续，无缺号/重号；附录不编号属预期 |
| 部分/主题导航（`.vitepress/sidebar.json`） | 12 个顶层组（10 部分+附录+知识点），148 个 link | 中文显示标题映射到主题 slug；组内按教学顺序排列 | 主体前缀“第1–10部分” | 连续；附录与知识点是非章节补充 |
| 指南/速查入口（各目录 `index.md`、首页） | 首页 1 + 11 个目录导览 | `index.md` 固定入口；正文标题描述该部分 | 10 个主部分导览带编号；安全等 | 同主线连续 |
| 复习地图/大纲台账（`docs/knowledge.md`、根 `OUTLINE.md`、`todo.md`） | 1 张站内知识地图 + 1 份 136 项大纲 + 1 份任务台账 | 主题总结、生产清单、审计状态分别组织 | 知识地图有局部序号；大纲有进度条目；todo 按状态 | 不属于章节编号序列；条目编号不作为页面 slug |

API、history 独立目录/页面编组：**未发现**。`history` 只作为 PostgreSQL 概念出现在基础介绍中，不是文档组织轴（`docs/basics/index.md:5`）。

### 编号与文件名

- 页面文件名前缀抽查结果：**没有任何以数字开头的 Markdown 文件**，因此不存在页面级文件编号断档、跳号或重复。
- 主章节编号见 `docs/.vitepress/sidebar.json:3-218` 与各 `index.md` 首行：第 1 至第 10 部分各一次且连续；附录和知识点无编号是合理例外。
- 没有证据支持“编号体系混乱”。编号风险主要是未来若把数字写进文件名，会与当前稳定 slug 约定冲突，不是现存缺陷。

### 侧边栏对账

解析 `docs/.vitepress/sidebar.json` 的 148 个链接，并按 VitePress 目录首页/clean URL 规则匹配：

| 类别 | 数量 | 前 10 条 |
|---|---:|---|
| 配置了但文件不存在 | 0 | 无 |
| 文件存在但未进侧边栏 | 1 | `docs/index.md`（首页，预期由首页路由承载；本报告新增后也未进侧栏，按要求暂不发布） |

`docs/knowledge.md` 已在 sidebar 末尾（`docs/.vitepress/sidebar.json:215-218`）。本报告是审计新增页，当前尚未配置侧边栏，属本次审计产物的预期状态。

### 死链核验

- 本地 Markdown 链接扫描：扫描 149 个现有文档，**未发现缺失的本地目标（0 条）**。脚本检查相对路径、站点根路径及 `.md`/目录首页目标；不覆盖外网可用性和标题锚点语义。
- VitePress 构建死链检查：**未核实**。执行 `npm run docs:build` 未能启动，原因是仓库没有 `node_modules`，shell 报 `vitepress: not found`。配置明确 `ignoreDeadLinks: false`（`docs/.vitepress/config.mts:10`），依赖安装后可用正式构建复核。
- 侧栏文件目标全部存在，与本地链接扫描互相印证，但不替代完整构建。

### 根目录杂散与重复入口

- 根目录有 `README.md` 和 `README.zh.md`，分别为英文/中文说明，是有意双语配对，不是重复 README；二者目录统计同步维护（示例 `README.md:23-44`、`README.zh.md:22-45`）。
- `OUTLINE.md`（136 项知识大纲）和 `todo.md`（巡检台账）是维护材料，不是发布页面；它们放在仓库根目录有利于贡献者查看。
- `docs/` 顶层另有 `index.md`、`knowledge.md` 两个不同用途入口；不是重复文件，但首页、知识复习页和章节导航形成多入口，需明确各自用途。
- 未发现根目录临时文件或备份 Markdown。`package.json`、lockfile、LICENSE、GitHub workflow 等均为项目必要文件。

## 问题清单与判断

严重度：高=影响可访问性/构建或主要任务；中=持续增加迷路/维护成本；低=局部不一致或文案过期。

| ID | 严重度 | 问题与证据 | 判断 |
|---|---|---|---|
| S1 | 中 | 同一套内容有两层命名：sidebar 的“第4部分：内核机制”映射目录 `internals/`，导航用“基础知识/数据库设计”等章节序列，磁盘又按主题分类。证据：`docs/.vitepress/sidebar.json:3-218`、`docs/internals/index.md:1`。 | 这是需要讲清关系的一项，但章节顺序与主题目录本身并不冲突；无需把编号塞入文件名。建议保留“主题目录存储 + 章节导航编排”这对主次关系。 |
| S2 | 中 | 同一概念的不同深度/任务内容分散在多个目录：psql 在 `docs/basics/psql-getting-started.md`、`docs/tools/psql-advanced.md`、`docs/appendix/psql-meta-command-reference.md`；复制分别在 `docs/internals/streaming-replication-and-sync.md`、`docs/operations/streaming-replication-setup.md`、`docs/operations/logical-replication-ops.md`；索引同时在 `docs/indexing/`、性能篇 `docs/performance/`，设计篇另有分区/索引相关页。 | 主题相关不等于重复：入门/运维/速查用途分离合理；问题在缺少显眼的跨篇路线图。先补关联导航，不应直接合并正文。 |
| S3 | 低 | 中英、大小写和缩写出现在 slug/标题中：`docs/tools/schema-migration-tools.md`（schema）、`docs/internals/checkpoint-and-buffer.md`（checkpoint/buffer）、`docs/internals/join-implementations.md`（join）、`docs/advanced-sql/jsonb-operations.md`（jsonb），与 `docs/tools/pgadmin-4.md`、`docs/advanced-sql/cte-and-non-recursive-with.md` 等组合风格并存；README 规则规定 kebab-case，但没有规定术语大小写/中英（`README.zh.md:49-55`）。 | URL slug 实际统一为小写英文 kebab-case；差异主要在显示标题/技术术语，不是目录名乱。形成术语表即可，批量改 slug 会造成外链风险。 |
| S4 | 低 | README 的页面数口径未说明是否包含 `index.md`：README 标注 basics 15 页、database-design 14 页，而目录总数含导览页分别是 16、15；sidebar 所列 148 个 link 中含 12 个目录/知识地图入口，剩余 136 个正文页，故 README 的“136 页”有其口径依据。证据：`README.zh.md:28-44`、`docs/.vitepress/sidebar.json:1-219`。 | 不是计数错误，属于统计口径说明不够显式；建议标为“正文页，不含 index/首页/知识地图”，而非重数。 |
| S5 | 低 | 一些目录导览末尾自动 backlinks 指向相邻篇/同名 index，例 `docs/tools/index.md:18-21` 链接 ecosystem/index，`docs/basics/index.md:25-28` 链接 advanced-sql/index；这会给读者造成“相关页面”误导。 | 链接目标存在，故不是死链；属于导航语义/自动生成关系准确度问题，需批量审阅其余目录页后再定。 |
| S6 | 低 | 顶层首页、knowledge 复习图、十一个目录 index 均是合法入口，但 README 把 `docs/` 页面和根目录计划材料放进同一个树状代码块，读者可能误认为 `OUTLINE.md`/`todo.md` 在 docs 内。证据：`README.md:23-44`、`README.zh.md:22-45`。 | 呈现方式稍含混，不代表实际目录混杂。分开展示仓库根与站点内容即可。 |

### 其实不乱、不用动的部分

- 11 个主题目录用小写英文 kebab-case，页面 slug 没数字前缀；稳定、可预测，适合 URL 和站点生成。
- 十个教学部分 1–10 连续，侧边栏配置的 148 个目标全部存在；没有编号断档、重复章节或侧栏缺页。
- 每个主题目录有 `index.md` 导览，正文文件按知识主题命名；README 也明确“每个部分入口是 index.md”（`README.zh.md:47`）。
- `appendix` 独立放术语、命令速查、排错和参考材料，符合查阅型内容与循序学习正文分开；安全/ecosystem 等主题也有清楚边界。
- 英文/中文 README 是语言版本，不是重复；`OUTLINE.md` 与 `todo.md` 是贡献者维护资料，不应并入发布站点目录。
- `knowledge.md` 是横跨主题的复习视图，其内容链接回正文（`docs/knowledge.md:3-20`）；它是索引而非第二份正文，不建议删除。

## 判断与推荐

当前是 **4 套组织轴**，建议收口为 **2 套读者侧组织 + 1 套维护台账**：

1. 主组织只保留“主题目录 + 连续章节导航”：目录负责内容归属和稳定路径，sidebar/目录 `index.md` 负责学习顺序。
2. 横向入口保留首页、知识地图和附录，但把它们明确命名为“开始阅读 / 复习地图 / 参考工具”，避免被当作竞争的目录体系。
3. `OUTLINE.md`、`todo.md` 保持在仓库根作为维护索引，不与站点页面混排。

现阶段不建议大规模重命名或搬目录：没有结构性断链证据；主要收益来自导航说明、数据口径和交叉链接语义。若要真正“合并成一套”，会牺牲复习/速查用途，收益小于链接和发现成本。

## 三期收口方案

| 阶段 | 动作清单 | 影响范围 | 风险（链接/搜索/外链） | 用户拍板 |
|---|---|---|---|---|
| 一期：机械整理（1 小时内） | 校正中英 README 目录页计数/总数；将仓库根文件与 `docs/` 树分开呈现；在 README 增加“主题目录是存储结构、sidebar 是学习顺序、knowledge 是复习入口”的一句说明；统一术语大小写规则说明而不改 slug。 | `README.md`、`README.zh.md`；不碰章节正文和配置。 | 低；只改说明，不改变页面路径、搜索索引或外链。 | **需拍板**：README 是否应维持同步双语更新；建议两份一起维护。 |
| 二期：导航整理 | 修复导览页“相关页面”误导链接；给 psql/复制/索引等多位置主题增加明确的入门→进阶→运维/速查路径；把本审计及后续维护页纳入 sidebar 或明确不发布。若调整 slug，配置 VitePress redirects/兼容页并验证旧链接。 | 多个目录 `index.md`、`docs/.vitepress/sidebar.json`、可能的 VitePress redirect 配置。 | 中；sidebar 顺序影响发现与站内搜索权重；slug/重定向改动会影响外链与搜索收录。 | **必须拍板**：是否发布审计报告、sidebar 的横向专题入口放置方式、是否允许新增旧 URL 重定向。 |
| 三期：深度重构 | 按真实重复度逐篇比对，把重复正文合并到唯一权威页；保留其他用途页为摘要/链接；必要时重分章节归属、调整 sidebar；为每个迁移旧 slug 建重定向并检查外链。 | `docs/` 正文多篇、sidebar、可能的 redirects；大纲与双语 README 同步。 | 高；搜索结果、引用和外链易变，正文合并可能丢失读者熟悉路径，必须做链接映射及构建检查。 | **必须拍板**：是否接受章节迁移/正文合并、权威页归属、旧 URL 保留期限与搜索迁移策略。 |

## 结论：最该先做的三件事

1. 在两份 README 标清“136 篇正文页不含各目录 index”，并分开标示仓库根维护文件与站点目录。
2. 修正目录页自动 backlinks 中语义不相关的链接；先审阅全部 11 个 index，再只改证据明确的项。
3. 为 psql、复制、索引等跨篇主题补一条清晰的学习/运维/速查路径；维持 slug 不变，先用链接解决发现问题。

**限制**：本次未安装依赖，因此正式 VitePress 构建及构建器级死链校验未核实；本地 Markdown 路径扫描结果为 0 缺失。
