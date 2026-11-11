import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';

const repo = 'https://github.com/rhyek/stackctl';
const site = 'https://stackctl.dev';

/**
 * A file in docs/public/ by its URL, with a hash of its content as the query (`/logo.svg?v=…`).
 * VitePress serves public files under their own names, so without it a changed icon would keep
 * its URL, and browsers and the CDN would keep the old file.
 */
function versioned(url: string): string {
  // The dev server can hand the same frontmatter in again: hash the path, not a hashed URL.
  const path = url.split('?')[0]!;
  const file = new URL(`../public${path}`, import.meta.url);
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8);
  return `${path}?v=${hash}`;
}

export default defineConfig({
  title: 'stackctl',
  description:
    "A terminal UI and CLI for a monorepo's services, infrastructure, tests and CI during development.",
  cleanUrls: true,
  lastUpdated: false,
  // Contributor internals and working notes live in docs/ too, but aren't part of the site.
  srcExclude: ['architecture/**', 'superpowers/**'],
  sitemap: { hostname: site },
  // The icon (docs/public/logo.svg) in the browser tab, with a PNG for browsers that don't take
  // an SVG one, and the square one iOS rounds for a home-screen bookmark.
  head: [
    ['link', { rel: 'icon', href: versioned('/logo.svg'), type: 'image/svg+xml' }],
    [
      'link',
      { rel: 'icon', href: versioned('/favicon-32.png'), type: 'image/png', sizes: '32x32' },
    ],
    ['link', { rel: 'apple-touch-icon', href: versioned('/apple-touch-icon.png') }],
  ],
  // The home page's images, named in its frontmatter by their plain path, get the same hash.
  transformPageData(page) {
    const hero = page.frontmatter.hero as { image?: { src: string } } | undefined;
    const demo = page.frontmatter.demo as { src: string } | undefined;
    if (hero?.image) {
      hero.image.src = versioned(hero.image.src);
    }
    if (demo) {
      demo.src = versioned(demo.src);
    }
  },

  // llms.txt, llms-full.txt and a Markdown copy of every page, generated from the same files.
  // `scripts/package-docs.ts` copies them into the npm package for the agent skill to read.
  // The home page's config example (theme/HomeConfig.md) is a snippet, not a page.
  vite: { plugins: [llmstxt({ ignoreFiles: ['.vitepress/**'] })] },

  themeConfig: {
    logo: { src: versioned('/logo.svg'), alt: '' },
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
