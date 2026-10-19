# hello-postgresql

一个游戏开发者的 PostgreSQL 项目记录：整理实际使用中的取舍、踩坑、排障过程和原理观察，由 VitePress 发布。

**在线阅读**：<https://cuihairu.github.io/hello-postgresql/>

English document: [README.md](README.md)。

## 本地运行

要求 Node.js 18+（建议 20+）。

```bash
npm ci                # 安装依赖
npm run docs:dev      # 开发模式，热更新
npm run docs:build    # 产出静态站到 docs/.vitepress/dist/（含死链核查，死链即失败）
npm run docs:preview  # 本地预览构建产物
```

> 若 npm 配置了禁用 install scripts（安装时出现 `npm warn install-scripts`），构建如报 esbuild 二进制缺失，执行 `npm rebuild esbuild` 后重试。

## 目录结构

```
仓库根目录：
├── OUTLINE.md          # 内容大纲与进度记录
└── todo.md             # 带 commit 证据的维护台账

站点内容（docs/）：
├── index.md            # 首页
├── knowledge.md        # 开发者备忘
├── basics/             # 基础与常用 SQL（15 页）
├── database-design/    # 数据库设计（14 页）
├── advanced-sql/       # 高级 SQL（18 页）
├── internals/          # 内核观察（20 页）
├── indexing/           # 索引与使用（12 页）
├── performance/        # 查询性能（14 页）
├── operations/         # 架构与运维（12 页）
├── security/           # 安全（8 页）
├── ecosystem/          # 生态与新特性（10 页）
├── tools/              # 开发工具与案例（8 页）
├── appendix/           # 附录（5 页）
├── .vitepress/
│   ├── config.mts      # 站点配置（base / 导航 / 搜索 / 死链门禁）
│   └── sidebar.json    # 站点导航与路由的权威来源
└── public/             # favicon / logo
```

上方目录篇数统计正文页，不含各目录的 `index.md`。站点导航以 sidebar 为唯一真源；发布路由变化时更新 sidebar，不另维护手写路由副本。各目录的 `index.md` 是主题总览，`knowledge.md` 是跨主题备忘。

## 内容记录方式

- 每页聚焦 **1–2 个核心知识点**，80–200 行，中文正文。
- 命令与 SQL 示例**可复现**：建表给完整 DDL，查询可直接粘贴执行；版本差异显式标注（如「PG 16 起」）。
- 标题层级：每页单一 H1，内文 `##` / `###`，与 hello-mysql 姊妹站同构。
- 页尾固定两段：`## 相关页面`（站内相对链接，不带 `.md` 后缀，slug 以 `sidebar.json` 为准）+ 官方文档链接一行。
- 事实核验：拿不准的语法/参数/版本归属对照 [官方文档](https://www.postgresql.org/docs/current/) 核实后落笔。

## 部署

push 到 `main` 自动触发 GitHub Actions（`.github/workflows/deploy-docs.yml`）构建并发布到 GitHub Pages；也可在 Actions 页手动 `workflow_dispatch`。本仓不发布版本号 release。

## License

[CC BY 4.0](./LICENSE)
