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

// Under stackctl (`pnpm dev`) the dev server is reached through the dev reverse proxy, at the
// `PUBLIC_ORIGIN` it is handed: that host must be allowed, and the HMR client told to connect to
// the port the page came from. Unset when the site is built, or run with `pnpm docs:dev`.
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN) : undefined;

export default defineConfig({
  title: 'stackctl',
  description:
    "A terminal UI and CLI for a monorepo's services, infrastructure, tests and CI during development.",
  cleanUrls: true,
  lastUpdated: false,
  // Contributor internals and working notes live in docs/ too, but aren't part of the site.
  srcExclude: ['architecture/**', 'superpowers/**'],
  sitemap: { hostname: site },
  // The icon at its small size (logo/logo-small.svg, linked into docs/public/) in the browser
  // tab, with a PNG for browsers that don't take an SVG one, and the square one iOS rounds for a
  // home-screen bookmark.
  head: [
    ['link', { rel: 'icon', href: versioned('/logo-small.svg'), type: 'image/svg+xml' }],
    [
      'link',
      { rel: 'icon', href: versioned('/favicon-32.png'), type: 'image/png', sizes: '32x32' },
    ],
    ['link', { rel: 'apple-touch-icon', href: versioned('/apple-touch-icon.png') }],
    // A link's preview in Slack, X and the like: the icon, square, as a small card. Absolute,
    // since a preview's fetcher doesn't resolve a path. It has to be a PNG: none of them draws
    // an SVG, and Slack showed an empty tile for the page's own.
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'stackctl' }],
    ['meta', { property: 'og:image', content: `${site}${versioned('/og-image.png')}` }],
    ['meta', { property: 'og:image:width', content: '512' }],
    ['meta', { property: 'og:image:height', content: '512' }],
    ['meta', { property: 'og:image:alt', content: 'stackctl' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],
  // Each page's preview names the page: its title, its description and its URL.
  transformHead({ pageData, title, description }) {
    const path = pageData.relativePath.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1');
    return [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: `${site}/${path}` }],
    ];
  },
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
  // `maintenance/scripts/package-docs.ts` copies them into the npm package for the agent skill to read.
  // The home page's config example (theme/HomeConfig.md) is a snippet, not a page.
  // The index opens by sending a coding agent to the playbook: whatever points an agent at
  // llms.txt (the skill, the rules file, the AGENTS.md block) names this one file.
  vite: {
    ...(publicOrigin && {
      server: {
        allowedHosts: [publicOrigin.hostname],
        hmr: {
          clientPort: Number(publicOrigin.port) || (publicOrigin.protocol === 'https:' ? 443 : 80),
        },
      },
    }),
    plugins: [
      llmstxt({
        ignoreFiles: ['.vitepress/**'],
        customLLMsTxtTemplate: [
          '# {title}',
          '{description}',
          '{details}',
          '{agents}',
          '## Table of Contents',
          '{toc}',
        ].join('\n\n'),
        customTemplateVariables: {
          agents:
            '**Coding agents:** read the [Agent playbook](/ai/playbook.md) first. It has the rules and a recipe for each task, and links to the pages below.',
        },
      }),
    ],
  },

  themeConfig: {
    logo: { src: versioned('/logo-small.svg'), alt: '' },
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
          { text: 'Events', link: '/reference/events' },
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
