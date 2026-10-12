import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import sidebar from './sidebar.json'

// https://vitepress.dev/reference/site-config
export default withMermaid(defineConfig({
  lang: 'zh-CN',
  title: 'Hello MySQL',
  description: 'MySQL 知识手册——基础与 SQL、数据库设计、底层原理、架构部署、性能调优与工具实战',
  base: '/hello-mysql/',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/hello-mysql/favicon.svg' }]
  ],

  // mdbook 遗留的目录文件保留在仓库作映射底稿，不作为页面构建
  srcExclude: ['**/SUMMARY.md'],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Hello MySQL',

    nav: [
      { text: '首页', link: '/' },
      { text: '基础知识', link: '/basics/README' },
      { text: '数据库设计', link: '/database-design/README' },
      { text: '高级SQL', link: '/advanced-sql-data-processing/README' },
      { text: '底层原理', link: '/advanced-features-internals/README' },
      { text: '架构部署', link: '/architecture-deployment/README' },
      { text: '性能调优', link: '/performance-tuning/README' },
      { text: '工具实战', link: '/tools-practice/README' },
      { text: '附录', link: '/appendix/README' },
      { text: '知识点整理', link: '/knowledge' }
    ],

    // 由 mdbook SUMMARY.md 结构映射而来（vitepress-migration/parse_summary.py），
    // 7 个部分 + 未入目录散页归入「附录 · 未入目录」
    sidebar: sidebar as never,

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cuihairu/hello-mysql' }
    ],

    footer: {
      message: 'Hello MySQL',
      copyright: '© 2025 cuihairu'
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索' },
          modal: {
            noResultsText: '没有找到结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
          }
        }
      }
    },

    outline: {
      label: '页面导航',
      level: [2, 3]
    },

    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },

    lastUpdated: {
      text: '最后更新'
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式'
  },

  markdown: {
    lineNumbers: false
  }
}))
