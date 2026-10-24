import { defineConfig } from 'vitepress'
import { pages, sections, titles } from './i18n-map.mjs'

const base = '/hello-postgresql/'
const locale = { root: 'en', zh: 'zh' } as const
type LocaleKey = keyof typeof locale

/** Navigation for one locale; the language dropdown is rendered by the theme from `locales`. */
function buildNav(key: LocaleKey) {
  const prefix = key === 'root' ? '' : '/zh'
  const t = titles[locale[key]]
  return [
    { text: key === 'root' ? 'Home' : '首页', link: key === 'root' ? '/' : '/zh/' },
    ...Object.entries(sections).map(([dir, [en, zh]]) => ({
      text: key === 'root' ? en : zh,
      link: `${prefix}/${dir}/`
    })),
    { text: t.knowledge, link: `${prefix}/knowledge` }
  ]
}

/** Sidebar for one locale: section index as a titled group, pages underneath. */
function buildSidebar(key: LocaleKey) {
  const prefix = key === 'root' ? '' : '/zh'
  const t = titles[locale[key]]
  const sidebar: Record<string, unknown> = { default: [] }
  for (const [dir, [en, zh]] of Object.entries(sections)) {
    sidebar[`${prefix}/${dir}/`] = [
      {
        text: key === 'root' ? en : zh,
        link: `${prefix}/${dir}/`,
        collapsed: true,
        items: pages[dir].map(([slug, enTitle, zhTitle]) => ({
          text: key === 'root' ? enTitle : zhTitle,
          link: `${prefix}/${dir}/${slug}`
        }))
      }
    ]
  }
  return sidebar as never
}

// https://vitepress.dev/reference/site-config
export default defineConfig({
  lang: 'en-US',
  title: 'Hello PostgreSQL',
  description:
    'Field notes on PostgreSQL: the tradeoffs, pitfalls, troubleshooting sessions and internals observations from real projects.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/hello-postgresql/favicon.svg' }]
  ],

  // mdbook leftovers kept in the repo as mapping drafts; never built as pages
  srcExclude: ['**/SUMMARY.md'],

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      title: 'Hello PostgreSQL',
      description:
        'Field notes on PostgreSQL: the tradeoffs, pitfalls, troubleshooting sessions and internals observations from real projects.'
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'Hello PostgreSQL',
      description: 'PostgreSQL 开发记录——项目实践、选型判断、排障过程与内核观察'
    }
  },

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Hello PostgreSQL',

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cuihairu/hello-postgresql' }
    ],

    footer: {
      message: 'Hello PostgreSQL',
      copyright: '© 2025 cuihairu'
    },

    outline: { level: [2, 3] },

    locales: {
      root: {
        nav: buildNav('root'),
        sidebar: buildSidebar('root'),
        outline: { label: 'On this page' },
        docFooter: { prev: 'Previous', next: 'Next' },
        lastUpdated: { text: 'Last updated' },
        returnToTopLabel: 'Return to top',
        sidebarMenuLabel: 'Menu',
        darkModeSwitchLabel: 'Toggle theme',
        lightModeSwitchTitle: 'Switch to light mode',
        darkModeSwitchTitle: 'Switch to dark mode',
        search: { provider: 'local' }
      },
      zh: {
        nav: buildNav('zh'),
        sidebar: buildSidebar('zh'),
        outline: { label: '页面导航' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        lastUpdated: { text: '最后更新' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
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
        }
      }
    }
  },

  markdown: {
    lineNumbers: false
  }
})
