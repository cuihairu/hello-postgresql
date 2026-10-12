# todo

盘点口径：本仓是纯文档站（VitePress），「实现」= 内容页落盘 + 构建绿 + Pages 线上 200。
巡检单点名的 `docs/implementation-plan.md`、`docs/architecture/*.md`、`docs/adr/*.md` 在本仓**不存在**（README.md 当时也不存在，2026-10-13 巡检期间补齐），
规划底稿 = 根目录 [OUTLINE.md](./OUTLINE.md)（136 项知识地图，已全部勾完）。盘点日 2026-10-13。

**巡检收尾（2026-10-13）：20/20 项全部完成，无未完成项。**

## 一、已实现（15 项）

验收口径（通用）：`npm run docs:build` 绿（含死链核查）+ Pages 部署 run success + 线上抽查 200。

- [x] 站点骨架与配置修正（base `/hello-postgresql/`、标题、nav/sidebar 指向真实文件、本地搜索、favicon/logo）——commit `61de11f`
- [x] 构建产物与 node_modules 忽略（曾误提交 6609 个 dist 文件，已清理；`399d8bd` 当时只移除了 dist 跟踪，node_modules 14067 个文件直到本次 `chore: untrack node_modules` 才真正移出索引）——commit `399d8bd` + untrack 提交（hash 见巡检回报）
- [x] 第1部分 基础知识 15 页——commit `f5e25c2`（中间批 `480ef45`/`285b32f`）
- [x] 第2部分 数据库设计 14 页——commit `aa10ead`
- [x] 第3部分 高级 SQL 18 页——commit `82770b4`
- [x] 第4部分 底层原理 20 页——commit `c5c3bc6`
- [x] 第5部分 查询调优 14 页——commit `353d603`
- [x] 第6部分 索引体系 12 页——commit `9d73633`
- [x] 第7部分 架构部署 12 页——commit `d504a13` + `7aac4b1`
- [x] 第8部分 安全 8 页——commit `9f3195b`
- [x] 第9部分 生态与新特性 10 页——commit `409c6cf`
- [x] 第10部分 工具实战 8 页——commit `23656a2`
- [x] 附录 5 页（术语表/SQL 速查/psql 元命令/错误对照/参考索引；错误原文经 postgres:16 容器实测）——commit `58abba0`
- [x] 知识点整理页 knowledge.md（导航挂载的复习主线）——commit `838472b`
- [x] 死链核查固化为构建门禁（`ignoreDeadLinks: false`，全站 136 页零死链）——commit `d8068ae`

## 二、只有设计（1 项）

- [x] mermaid 架构图内容：`vitepress-plugin-mermaid` 已配置，但全站 0 个 ```mermaid 围栏，属于「装了插件没画图」。处置：未使用的插件依赖已随 patrol-20261013 移除（commit `2af267d`），按本条验收口径「维持移除，本条关闭」结项；未来确需画图再按需重装并从第4部分底层原理开始补图。期次 P2。

## 三、完全没有（4 项）

- [x] 移除未使用依赖 `vitepress-plugin-mermaid` + `mermaid` + `playwright`（mermaid 全站 0 使用、playwright 全仓无引用；npm audit 6 条中 katex 原型污染链 GHSA-238p-pmpm-9mq7 随之消除）。验收口径：`npm audit` 中 katex/mermaid/vitepress-plugin-mermaid 行消失；`npm run docs:build` 绿；站点线上抽查 200。期次 P1。**已完成**：本次提交 `chore: remove unused mermaid and playwright deps`（hash 见巡检回报），audit 6→3 条，构建绿。
- [x] vite/esbuild dev-server 告警（原 4 条：GHSA-67mh-4wv8-2f99 esbuild + GHSA-4w7w-66w2-5vf9 / GHSA-v6wh-96g9-6wx3 / GHSA-fx2h-pf6j-xcff vite，npm audit 报「No fix available」）。验收口径：npm audit 无 vite/esbuild 行。期次 P2。**已完成**（2026-10-13）：`overrides` 把 vite 压到修复版 **6.4.4**（vitepress 1.6.4 声明 `vite ^5.4.14`，5.x 线止于 5.4.21 无修复，vitepress 2 至今只有 `2.0.0-alpha.20`），vite 6.4.4 依赖 esbuild 0.25.x 连带清掉 esbuild 告警，**npm audit: found 0 vulnerabilities**；三条代码路径实测全绿：`docs:build`（client + SSR 137 页）、`docs:dev`（`/` 与 `/basics/` 200）、`docs:preview`（首页/落地页/深页 200）。**解除条件**：vitepress 2 stable 发布后升级并删掉 `overrides` 块。曾试只压 esbuild 到 0.25.12（audit 3→2，vite 三条仍在），已回退。
- [x] 仓库根 README.md：项目简介、本地构建（npm ci + npm run docs:build）、写作口径（每页 1-2 个知识点/可复现示例）、与 OUTLINE.md 的对照说明。验收口径：新读者按 README 能在 10 分钟内本地跑起站点。期次 P1。**已完成**（patrol-20261013-A1）：`npm ci` + `npm run docs:build` 按 README 实测一次通过（51s），构建含死链核查。
- [x] part 目录 URL 404（`/basics/` 返回 404 而 `/basics/README` 200：VitePress 把 `part/README.md` 生成 `README.html` 而非 `index.html`；hello-mysql 同病）。验收口径：`curl /basics/` 返回 200。期次 P2。**已完成**（2026-10-13，依据用户「todo 未完成项全部拉起推进」指令视为拍板，与 hello-mysql 结构自此分叉）：11 个 part 落地页 `README.md` → `index.md`，同步更新 nav/侧边栏/首页 hero/part 互链/仓库 README；构建 + 死链门禁绿，dist 产出 `basics/index.html`。姊妹站 hello-mysql 的同款问题未动。
