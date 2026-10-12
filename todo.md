# todo

盘点口径：本仓是纯文档站（VitePress），「实现」= 内容页落盘 + 构建绿 + Pages 线上 200。
巡检单点名的 `docs/implementation-plan.md`、`docs/architecture/*.md`、`docs/adr/*.md` 在本仓**不存在**（也没有 README.md），
规划底稿 = 根目录 [OUTLINE.md](./OUTLINE.md)（136 项知识地图，已全部勾完）。盘点日 2026-10-13。

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

- [ ] mermaid 架构图内容：`vitepress-plugin-mermaid` 已配置，但全站 0 个 ```mermaid 围栏，属于「装了插件没画图」。处置：未使用的插件依赖本次直接移除（见三.1），未来确需画图再按需重装并从第4部分底层原理开始补图。验收口径：如恢复，至少 1 张图在站点正常渲染；如维持移除，本条关闭。期次 P2。

## 三、完全没有（4 项）

- [x] 移除未使用依赖 `vitepress-plugin-mermaid` + `mermaid` + `playwright`（mermaid 全站 0 使用、playwright 全仓无引用；npm audit 6 条中 katex 原型污染链 GHSA-238p-pmpm-9mq7 随之消除）。验收口径：`npm audit` 中 katex/mermaid/vitepress-plugin-mermaid 行消失；`npm run docs:build` 绿；站点线上抽查 200。期次 P1。**已完成**：本次提交 `chore: remove unused mermaid and playwright deps`（hash 见巡检回报），audit 6→3 条，构建绿。
- [ ] vite/esbuild dev-server 告警（GHSA-67mh-4wv8-2f99，npm audit「No fix available」：修复版 vite 需要 vitepress 2，目前只有 `2.0.0-alpha.20`）。验收口径：npm audit 无 vite/esbuild 行。期次 P2（**被上游阻塞**，vitepress 2 stable 发布后升级）。
- [ ] 仓库根 README.md：项目简介、本地构建（npm ci + npm run docs:build）、写作口径（每页 1-2 个知识点/可复现示例）、与 OUTLINE.md 的对照说明。验收口径：新读者按 README 能在 10 分钟内本地跑起站点。期次 P1。
- [ ] part 目录 URL 404（`/basics/` 返回 404 而 `/basics/README` 200：VitePress 把 `part/README.md` 生成 `README.html` 而非 `index.html`；hello-mysql 同病）。验收口径：`curl /basics/` 返回 200。期次 P2（涉及 11 个文件改名 + 全站链接替换，且需与姊妹站同步决策，等用户拍板）。
