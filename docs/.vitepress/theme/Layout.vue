<script setup>
import { useData, withBase } from 'vitepress';
import DefaultTheme, { VPButton } from 'vitepress/theme';
import HomeCli from './HomeCli.md';
import HomeConfig from './HomeConfig.md';
import HomeSdk from './HomeSdk.md';
import TerminalPlayer from './TerminalPlayer.vue';

// The home page's frontmatter names the recording, `demo: { src, alt }`, the words beside
// the config example, `config: { title, details, linkText, link }`, the words beside the test
// run on the command line and from the SDK, `cli: { … }` and `sdk: { … }` the same, and the agent
// conversation with its words, `agents: { title, details, linkText, link, src, alt }`. Each
// example is a Markdown file (HomeConfig.md, HomeCli.md, HomeSdk.md), so it is highlighted like
// any code block.
const { Layout } = DefaultTheme;
const { frontmatter } = useData();
</script>

<template>
  <Layout>
    <template #home-hero-after>
      <div v-if="frontmatter.demo" class="home-demo">
        <TerminalPlayer :src="frontmatter.demo.src" :label="frontmatter.demo.alt" />
      </div>
      <section v-if="frontmatter.config" class="home-config">
        <div class="pitch">
          <h2>{{ frontmatter.config.title }}</h2>
          <p>{{ frontmatter.config.details }}</p>
          <VPButton
            theme="alt"
            :text="frontmatter.config.linkText"
            :href="withBase(frontmatter.config.link)"
          />
        </div>
        <div class="code vp-doc">
          <HomeConfig />
        </div>
      </section>
      <!-- Text first, so a phone reads the heading before the commands; wide screens swap them. -->
      <section v-if="frontmatter.cli" class="home-cli">
        <div class="pitch">
          <h2>{{ frontmatter.cli.title }}</h2>
          <p>{{ frontmatter.cli.details }}</p>
          <VPButton
            theme="alt"
            :text="frontmatter.cli.linkText"
            :href="withBase(frontmatter.cli.link)"
          />
        </div>
        <div class="code vp-doc">
          <HomeCli />
        </div>
      </section>
      <section v-if="frontmatter.sdk" class="home-sdk">
        <div class="pitch">
          <h2>{{ frontmatter.sdk.title }}</h2>
          <p>{{ frontmatter.sdk.details }}</p>
          <VPButton
            theme="alt"
            :text="frontmatter.sdk.linkText"
            :href="withBase(frontmatter.sdk.link)"
          />
        </div>
        <div class="code vp-doc">
          <HomeSdk />
        </div>
      </section>
      <!-- Text first, so a phone reads the heading before the recording; wide screens swap them. -->
      <section v-if="frontmatter.agents" class="home-agents">
        <div class="pitch">
          <h2>{{ frontmatter.agents.title }}</h2>
          <p>{{ frontmatter.agents.details }}</p>
          <VPButton
            theme="alt"
            :text="frontmatter.agents.linkText"
            :href="withBase(frontmatter.agents.link)"
          />
        </div>
        <div class="player">
          <TerminalPlayer :src="frontmatter.agents.src" :label="frontmatter.agents.alt" />
        </div>
      </section>
    </template>
  </Layout>
</template>

<style scoped>
.home-demo,
.home-config,
.home-cli,
.home-sdk,
.home-agents {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 48px;
}

/*
 * The player fits the terminal's columns to its width: at 800px that is a terminal's text size;
 * narrower screens scale it down.
 */
.home-demo :deep(.terminal-player) {
  max-width: 800px;
  margin: 0 auto;
}

.home-config,
.home-cli,
.home-sdk,
.home-agents {
  display: grid;
  gap: 24px;
  align-items: center;
}

/* Stacked, the conversation is no wider than the demo above it. */
.home-agents .player {
  width: 100%;
  max-width: 800px;
  min-width: 0;
  margin: 0 auto;
}

.pitch h2 {
  font-size: 28px;
  line-height: 36px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.pitch p {
  margin: 12px 0 20px;
  font-size: 16px;
  line-height: 26px;
  color: var(--vp-c-text-2);
}

/* The code block fills its column, with no margin of its own. */
.home-config .code,
.home-cli .code,
.home-sdk .code {
  min-width: 0;
}

.home-config .code :deep(div[class*='language-']),
.home-cli .code :deep(div[class*='language-']),
.home-sdk .code :deep(div[class*='language-']) {
  margin: 0;
  border-radius: 12px;
}

/* A whole config is long: a little denser than a docs page's code, at the same size. */
.home-config .code :deep(pre) {
  padding: 16px 0;
}

.home-config .code :deep(code) {
  line-height: 1.5;
}

@media (min-width: 640px) {
  .home-demo,
  .home-config,
  .home-cli,
  .home-sdk,
  .home-agents {
    padding: 0 48px 56px;
  }
}

@media (min-width: 960px) {
  .home-demo,
  .home-config,
  .home-cli,
  .home-sdk,
  .home-agents {
    padding: 0 64px 64px;
  }

  /* The mirror of the config section: the conversation on the left, its words on the right. */
  .home-agents {
    grid-template-columns: 3fr 2fr;
    gap: 48px;
  }

  .home-agents .player {
    order: -1;
  }

  /* After the config's words-then-code, the commands on the left and their words on the right. */
  .home-cli {
    grid-template-columns: 3fr 2fr;
    gap: 48px;
  }

  .home-cli .code {
    order: -1;
  }

  /* Then the words on the left again, the setup on the right. */
  .home-sdk {
    grid-template-columns: 2fr 3fr;
    gap: 48px;
  }

  .home-config {
    grid-template-columns: 2fr 3fr;
    gap: 48px;
    align-items: start;
  }

  /* Beside a config longer than itself, the pitch stays in view under the nav while it scrolls. */
  .home-config .pitch {
    position: sticky;
    top: calc(var(--vp-nav-height) + 48px);
  }
}
</style>
