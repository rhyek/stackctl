<script setup>
import 'asciinema-player/dist/bundle/asciinema-player.css';
import { withBase } from 'vitepress';
import { onBeforeUnmount, onMounted, ref } from 'vue';

// A recording of stackctl's terminal (an asciicast, scripts/demo/record.sh), played as text by
// asciinema-player: the page's own Menlo, in the colors the cast embeds, looping, with no
// controls. It fits the terminal's columns to its width. The player only runs in a browser, so it
// is loaded once the element is mounted, never during the build.
//
// In a docs page it sits inside `<llm-exclude>`, beside an `<llm-only>` text copy of the screen
// that scripts/demo/place.ts keeps in step with the recording, so llms.txt reads text.
const props = defineProps({
  src: { type: String, required: true },
  /** What the recording shows, for a screen reader. */
  label: { type: String, required: true },
});

const element = ref(null);
let player = null;
let unmounted = false;

onMounted(async () => {
  const { create } = await import('asciinema-player');
  if (unmounted || !element.value) {
    return;
  }
  player = create(withBase(props.src), element.value, {
    autoPlay: true,
    loop: true,
    preload: true,
    fit: 'width',
    controls: false,
    idleTimeLimit: 10,
    terminalFontFamily: "Menlo, 'SF Mono', ui-monospace, monospace",
    terminalLineHeight: 1.2,
  });
});

onBeforeUnmount(() => {
  unmounted = true;
  player?.dispose();
});
</script>

<template>
  <div ref="element" class="terminal-player" role="img" :aria-label="label" />
</template>

<style scoped>
.terminal-player {
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: var(--vp-shadow-3);
}

/* Inside a docs page, the same space a code block takes. */
.vp-doc .terminal-player {
  margin: 16px 0;
}
</style>
