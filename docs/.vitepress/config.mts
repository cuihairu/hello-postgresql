import { defineConfig } from 'vitepress'
import sidebar from './sidebar.json'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  lang: 'zh-CN',
  title: 'Hello PostgreSQL',
  description: 'PostgreSQL 开发记录——项目实践、选型判断、排障过程与内核观察',
  base: '/hello-postgresql/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/hello-postgresql/favicon.svg' }]
  ],

  // mdbook 遗留的目录文件保留在仓库作映射底稿，不作为页面构建
  srcExclude: ['**/SUMMARY.md'],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Hello PostgreSQL',

    nav: [
      { text: '首页', link: '/' },
      { text: '基础与常用 SQL', link: '/basics/' },
      { text: '数据库设计', link: '/database-design/' },
      { text: '高级SQL', link: '/advanced-sql/' },
      { text: '底层原理', link: '/internals/' },
      { text: '索引体系', link: '/indexing/' },
      { text: '查询调优', link: '/performance/' },
      { text: '架构部署', link: '/operations/' },
      { text: '安全', link: '/security/' },
      { text: '生态与新特性', link: '/ecosystem/' },
      { text: '开发工具', link: '/tools/' },
      { text: '附录', link: '/appendix/' },
      { text: '开发者备忘', link: '/knowledge' }
    ],

    sidebar: sidebar as never,

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cuihairu/hello-postgresql' }
    ],

    footer: {
      message: 'Hello PostgreSQL',
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
})
