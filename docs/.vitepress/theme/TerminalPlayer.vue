<script setup>
import 'asciinema-player/dist/bundle/asciinema-player.css';
import { withBase } from 'vitepress';
import { onBeforeUnmount, onMounted, ref } from 'vue';

// A recording of stackctl's terminal (an asciicast, maintenance/scripts/demo/record.sh), played as text by
// asciinema-player: the page's own Menlo, in the colors the cast embeds, looping, with no
// controls. It fits the terminal's columns to its width. The player only runs in a browser, so it
// is loaded once the element is mounted, never during the build. It starts the first time half
// of it is on screen, so a reader scrolling down meets a recording at its beginning.
//
// In a docs page it sits inside `<llm-exclude>`, beside an `<llm-only>` text copy of the screen
// that maintenance/scripts/demo/place.ts keeps in step with the recording, so llms.txt reads text.
const props = defineProps({
  src: { type: String, required: true },
  /** What the recording shows, for a screen reader. */
  label: { type: String, required: true },
  /** A screenshot: a cast of one frame (a `still` scene), shown once rather than looped. */
  still: { type: Boolean, default: false },
});

const element = ref(null);
let player = null;
let observer = null;
let unmounted = false;

onMounted(async () => {
  const { create } = await import('asciinema-player');
  if (unmounted || !element.value) {
    return;
  }
  player = create(withBase(props.src), element.value, {
    autoPlay: false,
    loop: !props.still,
    preload: true,
    fit: 'width',
    controls: false,
    idleTimeLimit: 10,
    terminalFontFamily: "Menlo, 'SF Mono', ui-monospace, monospace",
    terminalLineHeight: 1.2,
  });
  // Played once on the way in; after that it loops on its own, in view or not.
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        observer = null;
        player?.play();
      }
    },
    // half, not more: a player taller than twice the screen could never show more
    { threshold: 0.5 },
  );
  observer.observe(element.value);
});

onBeforeUnmount(() => {
  unmounted = true;
  observer?.disconnect();
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

/* No play button while it waits to be scrolled into view: it starts on its own. */
.terminal-player :deep(.ap-overlay-start) {
  display: none;
}

/* Inside a docs page, the same space a code block takes. */
.vp-doc .terminal-player {
  margin: 16px 0;
}
</style>
