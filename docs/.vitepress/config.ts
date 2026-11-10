import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';

const repo = 'https://github.com/rhyek/stackctl';
const site = 'https://stackctl.dev';

export default defineConfig({
  title: 'stackctl',
  description:
    "A terminal UI and CLI for a monorepo's services, infrastructure, tests and CI during development.",
  cleanUrls: true,
  lastUpdated: false,
  // Contributor internals and working notes live in docs/ too, but aren't part of the site.
  srcExclude: ['architecture/**', 'superpowers/**'],
  sitemap: { hostname: site },

  // llms.txt, llms-full.txt and a Markdown copy of every page, generated from the same files.
  // `scripts/package-docs.ts` copies them into the npm package for the agent skill to read.
  // The home page's config example (theme/HomeConfig.md) is a snippet, not a page.
  vite: { plugins: [llmstxt({ ignoreFiles: ['.vitepress/**'] })] },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/guide/' },
      { text: 'Config', link: '/config/config-file', activeMatch: '^/config/' },
      { text: 'Reference', link: '/reference/cli', activeMatch: '^/reference/' },
      { text: 'AI agents', link: '/ai/overview', activeMatch: '^/ai/' },
      { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Why stackctl', link: '/guide/why' },
        ],
      },
      {
        text: 'Guide',
        items: [
          { text: 'Services', link: '/guide/services' },
          { text: 'Terminal UI', link: '/guide/terminal-ui' },
          { text: 'Environment and modes', link: '/guide/env' },
          { text: 'One-off commands', link: '/guide/commands' },
          { text: 'Logs', link: '/guide/logs' },
          { text: 'Tests and CI', link: '/guide/testing' },
        ],
      },
      {
        text: 'Config',
        items: [
          { text: 'The config file', link: '/config/config-file' },
          { text: 'Services', link: '/config/services' },
          { text: 'Environment', link: '/config/env' },
          { text: 'Logs', link: '/config/logs' },
          { text: 'Infra', link: '/config/infra' },
          { text: 'Reverse proxy', link: '/config/reverse-proxy' },
          { text: 'URLs and origins', link: '/config/urls' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Control API', link: '/reference/control-api' },
          { text: 'SDK', link: '/reference/sdk' },
        ],
      },
      {
        text: 'AI agents',
        items: [
          { text: 'Built for agents', link: '/ai/overview' },
          { text: 'Agent playbook', link: '/ai/playbook' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    outline: [2, 3],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: { message: 'Released under the MIT License.' },
  },

  markdown: {
    // GitHub's heading ids, so a `#anchor` link means the same on the site, on GitHub and in the
    // Markdown copies an agent reads: lowercased, punctuation dropped, each space a hyphen
    // (`stackctl start --detach` → `stackctl-start---detach`).
    anchor: {
      slugify: (heading) =>
        heading
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
          .replace(/ /g, '-'),
    },
  },
});
