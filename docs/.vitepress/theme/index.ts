// Linted on its own (pre-commit), this file sees no shim unless it names it: `.vue` imports need it.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./vue-shim.d.ts" />
import type { EnhanceAppContext } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import TerminalPlayer from './TerminalPlayer.vue';
import './custom.css';

// The default theme, with the demo recording under the home page's hero (see Layout.vue), the
// accent color changed (see custom.css), and `<TerminalPlayer>` for recordings in any page.
export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }: EnhanceAppContext) {
    app.component('TerminalPlayer', TerminalPlayer);
  },
};
