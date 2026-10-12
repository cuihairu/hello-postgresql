# hello-postgresql

PostgreSQL 中文知识手册，VitePress 静态站。

**在线阅读**：<https://cuihairu.github.io/hello-postgresql/>

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
docs/
├── index.md            # 首页
├── knowledge.md        # 知识点整理（复习主线）
├── basics/             # 第1部分 基础知识（15 页）
├── database-design/    # 第2部分 数据库设计（14 页）
├── advanced-sql/       # 第3部分 高级 SQL（18 页）
├── internals/          # 第4部分 底层原理（20 页）
├── indexing/           # 第5部分 索引体系（12 页）
├── performance/        # 第6部分 查询调优（14 页）
├── operations/         # 第7部分 架构部署（12 页）
├── security/           # 第8部分 安全（8 页）
├── ecosystem/          # 第9部分 生态与新特性（10 页）
├── tools/              # 第10部分 工具实战（8 页）
├── appendix/           # 附录（5 页）
├── .vitepress/
│   ├── config.mts      # 站点配置（base / 导航 / 搜索 / 死链门禁）
│   └── sidebar.json    # 侧边栏（全站 136 页的唯一 slug 清单）
└── public/             # favicon / logo
OUTLINE.md              # 知识地图，136 项，勾选状态即内容进度
todo.md                 # 巡检台账：未完成项 / 已完成项与 commit 证据
```

每个部分的入口是该目录下的 `README.md`（导览页）。

## 写作口径

- 每页聚焦 **1–2 个核心知识点**，80–200 行，中文正文。
- 命令与 SQL 示例**可复现**：建表给完整 DDL，查询可直接粘贴执行；版本差异显式标注（如「PG 16 起」）。
- 标题层级：每页单一 H1，内文 `##` / `###`，与 hello-mysql 姊妹站同构。
- 页尾固定两段：`## 相关页面`（站内相对链接，不带 `.md` 后缀，slug 以 `sidebar.json` 为准）+ 官方文档链接一行。
- 事实核验：拿不准的语法/参数/版本归属对照 [官方文档](https://www.postgresql.org/docs/current/) 核实后落笔。

## 部署

push 到 `main` 自动触发 GitHub Actions（`.github/workflows/deploy-docs.yml`）构建并发布到 GitHub Pages；也可在 Actions 页手动 `workflow_dispatch`。本仓不发布版本号 release。

## License

[CC BY 4.0](./LICENSE)
