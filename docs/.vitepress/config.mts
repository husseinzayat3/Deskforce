import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const repo = 'https://github.com/husseinzayat3/Deskforce';

// Served from GitHub Pages at husseinzayat3.github.io/Deskforce/. With a custom domain, set DOCS_BASE=/
export default withMermaid(defineConfig({
  title: 'Deskforce',
  description: 'A virtual office of AI agents: hire a team, give the CEO a goal, and watch it get planned, delegated and built.',
  base: process.env.DOCS_BASE || '/Deskforce/',
  cleanUrls: true,
  // docs/README.md is the index for people browsing the folder on GitHub; the site has its own home page
  srcExclude: ['README.md'],
  head: [
    ['link', { rel: 'icon', href: `${process.env.DOCS_BASE || '/Deskforce/'}robot.png` }],
    ['meta', { property: 'og:image', content: `${repo}/raw/main/docs/social-preview.png` }],
  ],
  themeConfig: {
    logo: '/robot.png',
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Download', link: `${repo}/releases/latest` },
      { text: 'Work with me', link: '/work-with-me' },
    ],
    sidebar: [
      {
        text: 'Start',
        items: [
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Concepts', link: '/concepts' },
          { text: 'Features', link: '/features' },
        ],
      },
      {
        text: 'Using the office',
        items: [
          { text: 'Providers & models', link: '/providers-and-models' },
          { text: 'Costs & budgets', link: '/costs-and-budgets' },
          { text: 'Slack', link: '/slack' },
          { text: 'Checks', link: '/checks' },
          { text: 'Office files', link: '/office-files' },
        ],
      },
      {
        text: 'Running it',
        items: [
          { text: 'Desktop app', link: '/desktop-app' },
          { text: 'Docker', link: '/docker' },
          { text: 'Security model', link: '/security' },
          { text: 'How it works', link: '/how-it-works' },
        ],
      },
      {
        text: 'Help',
        items: [
          { text: 'FAQ', link: '/faq' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Improve this page on GitHub' },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Hussein Zayat',
    },
  },
}));
