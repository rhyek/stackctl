import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import './custom.css';

// The default theme, with the demo recording under the home page's hero (see Layout.vue) and
// the accent color changed (see custom.css).
export default { extends: DefaultTheme, Layout };
