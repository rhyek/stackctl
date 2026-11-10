<script setup>
import { useData, withBase } from 'vitepress';
import DefaultTheme, { VPButton } from 'vitepress/theme';
import HomeConfig from './HomeConfig.md';

// The home page's frontmatter names the recording, `demo: { src, alt }`, and the words beside
// the config example, `config: { title, details, linkText, link }`. The example itself is
// HomeConfig.md, so it is highlighted like any code block.
const { Layout } = DefaultTheme;
const { frontmatter } = useData();
</script>

<template>
  <Layout>
    <template #home-hero-after>
      <div v-if="frontmatter.demo" class="home-demo">
        <img :src="withBase(frontmatter.demo.src)" :alt="frontmatter.demo.alt" />
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
    </template>
  </Layout>
</template>

<style scoped>
.home-demo,
.home-config {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 48px;
}

.home-demo img {
  display: block;
  width: 100%;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: var(--vp-shadow-3);
}

.home-config {
  display: grid;
  gap: 24px;
  align-items: center;
}

.home-config .pitch h2 {
  font-size: 28px;
  line-height: 36px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.home-config .pitch p {
  margin: 12px 0 20px;
  font-size: 16px;
  line-height: 26px;
  color: var(--vp-c-text-2);
}

/* The code block fills its column, with no margin of its own. */
.home-config .code {
  min-width: 0;
}

.home-config .code :deep(div[class*='language-']) {
  margin: 0;
  border-radius: 12px;
}

@media (min-width: 640px) {
  .home-demo,
  .home-config {
    padding: 0 48px 56px;
  }
}

@media (min-width: 960px) {
  .home-demo,
  .home-config {
    padding: 0 64px 64px;
  }

  .home-config {
    grid-template-columns: 2fr 3fr;
    gap: 48px;
  }
}
</style>
