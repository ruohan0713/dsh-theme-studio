/**
 * Theme Studio - Client half. v1.3.4
 *
 * Registers no theme definitions on purpose: a third-party theme id would not
 * persist through the built-in Appearance schema. Instead it stacks one token
 * override layer (`ctx.theme.overrideTokens`) carrying a complete light/dark
 * pair, so the user keeps the normal Light / Dark / System switch while the
 * theme's own palette follows the scheme automatically.
 *
 * Background clarity: every scrim / glow / sheen alpha carries a
 * `calc(alpha * var(--ts-veil))` factor, and the window-canvas wash token is
 * scaled when the layer is stacked, so one three-level control (soft / standard
 * / clear) tunes how much wallpaper shows without duplicating gradients.
 *
 * Visual model:
 *   body::before  the wallpaper (user image when present, generated CSS art
 *                 otherwise) under a directional scrim, slowly panning.
 *   body::after   the living light: glow fields, a travelling sheen and fine
 *                 grain, drifting at a different period.
 *   #root         lifted above both so the whole app stays on top and the
 *                 host's translucent surface tokens reveal the wallpaper.
 *
 * The theme gallery lives in Settings → Theme Studio, contributed through the
 * `settings.section` and `settings.section.icon` slots.
 */
window.__ModuleLoader__.load({
  id: 'dsh-theme-studio',
  factory(require) {
    /**
     * Report one activation failure instead of throwing. A single throwing
     * client entry aborts the whole Web UI boot, so a broken theme must never
     * escape as an exception: it is reported to the Host diagnostics sink (when
     * enabled) and leaves the rest of the app untouched.
     */
    function reportFailure(scope, error) {
      let payload;
      try {
        payload = {
          kind: 'client-activation',
          scope,
          at: new Date().toISOString(),
          href: typeof location === 'undefined' ? '' : String(location.href),
          userAgent: typeof navigator === 'undefined' ? '' : String(navigator.userAgent),
          error: {
            name: error && error.name ? String(error.name) : 'Error',
            message: error && error.message ? String(error.message) : String(error),
            stack: error && error.stack ? String(error.stack).slice(0, 4000) : '',
          },
        };
      } catch {
        payload = { kind: 'client-activation', scope, error: { message: 'unserialisable failure' } };
      }
      try {
        console.error('[theme-studio] activation failed in ' + scope, error);
      } catch {
        /* ignore */
      }
      const json = JSON.stringify(payload);
      try {
        void fetch('/theme-studio/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
          keepalive: true,
        });
      } catch {
        /* ignore */
      }
      try {
        const encoded = btoa(unescape(encodeURIComponent(json)));
        void fetch('/theme-studio/diag?data=' + encodeURIComponent(encoded), { method: 'GET', keepalive: true });
      } catch {
        /* ignore */
      }
    }

    try {
      const React = require('react');
      const h = React.createElement;

      const NS = 'theme-studio';
      const SOURCE = 'dsh-theme-studio';
      const ROUTE = '/theme-studio';
      const STORAGE_KEY = 'dsh-theme-studio/v5';
      const WALLPAPER_THEMES = 6;
      /** Reported by the diagnostics UI probe so a loaded build is identifiable. */
      const BUILD = '1.3.8+sidebar-wash';

    /* ------------------------------------------------------------------ *
     * Colour helpers
     * ------------------------------------------------------------------ */

    function parseColor(value) {
      if (typeof value !== 'string') return { r: 0, g: 0, b: 0, a: 1 };
      const text = value.trim();
      if (text.charAt(0) === '#') {
        let hex = text.slice(1);
        if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
        const n = Number.parseInt(hex, 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
      }
      const match = text.match(/rgba?\(([^)]+)\)/i);
      if (match) {
        const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
        return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
      }
      return { r: 0, g: 0, b: 0, a: 1 };
    }

    function rgbText(color) {
      return `${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}`;
    }

    function hexOf(color) {
      const channel = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
      return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
    }

    function mixIntoTint(base, tint, amount) {
      const a = parseColor(base);
      const b = parseColor(tint);
      return hexOf({
        r: a.r + (b.r - a.r) * amount,
        g: a.g + (b.g - a.g) * amount,
        b: a.b + (b.b - a.b) * amount,
      });
    }

    const lighten = (color, amount) => mixIntoTint(color, '#ffffff', amount);
    const darken = (color, amount) => mixIntoTint(color, '#000000', amount);

    function rgba(color, alpha) {
      return `rgba(${rgbText(parseColor(color))}, ${Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000})`;
    }

    /** Read the alpha channel of a CSS colour (1 for opaque values). */
    function alphaOf(color) {
      const parsed = parseColor(color);
      return typeof parsed.a === 'number' ? parsed.a : 1;
    }

    /** Re-emit a colour with its alpha scaled by `factor`. */
    function scaleAlpha(color, factor) {
      return rgba(color, alphaOf(color) * factor);
    }

    function luminance(color) {
      const c = parseColor(color);
      const channel = (value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    }

    const onColor = (color) => (luminance(color) > 0.52 ? '#101418' : '#ffffff');

    /** Nudge a colour until it reaches a minimum luminance (dark-scheme text). */
    function ensureMinLuma(color, minimum) {
      let value = color;
      for (let step = 0; step < 24 && luminance(value) < minimum; step += 1) value = lighten(value, 0.08);
      return value;
    }

    /** Nudge a colour until it drops under a maximum luminance (light-scheme text). */
    function ensureMaxLuma(color, maximum) {
      let value = color;
      for (let step = 0; step < 24 && luminance(value) > maximum; step += 1) value = darken(value, 0.08);
      return value;
    }

    /* ------------------------------------------------------------------ *
     * Theme families — palettes come from design/theme-design-spec.md
     * ------------------------------------------------------------------ */

    const FAMILIES = [
      {
        id: 'ink-mist',
        native: 'light',
        order: 1,
        name: { zh: '水墨远山', en: 'Ink Mist' },
        tag: { zh: '宣纸留白 · 淡墨远山', en: 'Rice paper · distant ink mountains' },
        motion: { pan: 42, drift: 36 },
        palette: {
          base: '#F1EEE7',
          layer1: 'rgba(255, 255, 255, 0.60)',
          layer2: 'rgba(243, 240, 232, 0.42)',
          overlay: 'rgba(249, 247, 241, 0.74)',
          sidebar: 'rgba(246, 243, 236, 0.52)',
          border1: 'rgba(38, 44, 48, 0.18)',
          border2: 'rgba(255, 255, 255, 0.60)',
          brand: '#3D4A45',
          brandHover: '#2E3A35',
          label1: '#22272B',
          label2: '#525B5E',
          success: '#4A6B4F',
          warn: '#8A6828',
          error: '#9C4A3E',
          neutral: '#8D9A94',
        },
        art: [
          'radial-gradient(120% 60% at 70% 88%, rgba(34, 39, 43, 0.32) 0%, rgba(34, 39, 43, 0) 62%)',
          'linear-gradient(178deg, rgba(34, 39, 43, 0) 50%, rgba(34, 39, 43, 0.10) 57%, rgba(34, 39, 43, 0) 63%)',
          'radial-gradient(70% 50% at 30% 72%, rgba(80, 95, 90, 0.20) 0%, rgba(80, 95, 90, 0) 70%)',
          'linear-gradient(180deg, #F8F5EF 0%, #F1EEE7 45%, #E4E1DA 100%)',
        ],
      },
      {
        id: 'celadon',
        native: 'light',
        order: 2,
        name: { zh: '宋瓷天青', en: 'Celadon' },
        tag: { zh: '雨过天青 · 冰裂纹理', en: 'Ru-ware blue · crackle glaze' },
        motion: { pan: 38, drift: 34 },
        palette: {
          base: '#E2EBE7',
          layer1: 'rgba(255, 255, 255, 0.62)',
          layer2: 'rgba(226, 236, 232, 0.46)',
          overlay: 'rgba(246, 251, 249, 0.74)',
          sidebar: 'rgba(242, 249, 246, 0.54)',
          border1: 'rgba(46, 72, 64, 0.18)',
          border2: 'rgba(255, 255, 255, 0.58)',
          brand: '#4E7F72',
          brandHover: '#3D6A5E',
          label1: '#1F2E29',
          label2: '#4A605A',
          success: '#4C7558',
          warn: '#8A6A2A',
          error: '#9E4F43',
          neutral: '#9CB8AE',
        },
        art: [
          'radial-gradient(90% 70% at 68% 38%, rgba(126, 167, 154, 0.40) 0%, rgba(126, 167, 154, 0) 62%)',
          'repeating-linear-gradient(102deg, rgba(255, 255, 255, 0) 0 46px, rgba(58, 92, 84, 0.05) 47px, rgba(255, 255, 255, 0) 48px 92px)',
          'radial-gradient(70% 55% at 24% 30%, rgba(214, 229, 223, 0.55) 0%, rgba(214, 229, 223, 0) 70%)',
          'linear-gradient(160deg, #EEF4F1 0%, #E2EBE7 55%, #CFDDD7 100%)',
        ],
      },
      {
        id: 'parchment',
        native: 'light',
        order: 3,
        name: { zh: '羊皮手稿', en: 'Parchment' },
        tag: { zh: '羊皮纸暖 · 旧墨书香', en: 'Warm parchment · old ink' },
        motion: { pan: 40, drift: 36 },
        palette: {
          base: '#EFE3CB',
          layer1: 'rgba(255, 252, 244, 0.62)',
          layer2: 'rgba(244, 234, 216, 0.46)',
          overlay: 'rgba(252, 247, 238, 0.76)',
          sidebar: 'rgba(248, 242, 231, 0.56)',
          border1: 'rgba(110, 80, 48, 0.20)',
          border2: 'rgba(255, 255, 255, 0.55)',
          brand: '#7B4A2C',
          brandHover: '#633A20',
          label1: '#2E2317',
          label2: '#5E4C39',
          success: '#566B3F',
          warn: '#8F5F1F',
          error: '#9A4436',
          neutral: '#B79B72',
        },
        art: [
          'radial-gradient(90% 70% at 74% 34%, rgba(183, 155, 114, 0.30) 0%, rgba(183, 155, 114, 0) 64%)',
          'repeating-linear-gradient(94deg, rgba(110, 80, 48, 0) 0 34px, rgba(110, 80, 48, 0.035) 35px, rgba(110, 80, 48, 0) 36px 96px)',
          'radial-gradient(70% 50% at 22% 74%, rgba(154, 68, 54, 0.10) 0%, rgba(154, 68, 54, 0) 70%)',
          'linear-gradient(150deg, #F7EEDC 0%, #EFE3CB 50%, #DDCBAB 100%)',
        ],
      },
      {
        id: 'moonlit',
        native: 'dark',
        order: 4,
        name: { zh: '月白幽蓝', en: 'Moonlit' },
        tag: { zh: '月白夜蓝 · 静水微光', en: 'Moonlit blue · still water' },
        motion: { pan: 44, drift: 38 },
        palette: {
          base: '#0C1320',
          layer1: 'rgba(22, 34, 54, 0.62)',
          layer2: 'rgba(14, 23, 38, 0.54)',
          overlay: 'rgba(6, 10, 18, 0.76)',
          sidebar: 'rgba(10, 16, 28, 0.58)',
          border1: 'rgba(159, 182, 218, 0.18)',
          border2: 'rgba(140, 170, 215, 0.30)',
          brand: '#9FB6DA',
          brandHover: '#B9CBEA',
          label1: '#ECF0F7',
          label2: '#A9B6C9',
          success: '#6FC2A0',
          warn: '#DDB271',
          error: '#EE8A84',
          neutral: '#8FA9D6',
        },
        art: [
          'radial-gradient(34% 30% at 70% 30%, rgba(236, 240, 247, 0.32) 0%, rgba(236, 240, 247, 0) 66%)',
          'radial-gradient(70% 60% at 78% 58%, rgba(143, 169, 214, 0.22) 0%, rgba(143, 169, 214, 0) 68%)',
          'linear-gradient(180deg, rgba(12, 19, 32, 0) 54%, rgba(12, 19, 32, 0.55) 66%, rgba(12, 19, 32, 0.80) 100%)',
          'linear-gradient(160deg, #0A101C 0%, #0C1320 50%, #131C2C 100%)',
        ],
      },
      {
        id: 'watercolor-bloom',
        native: 'light',
        order: 5,
        name: { zh: '水彩花影', en: 'Watercolor Bloom' },
        tag: { zh: '柔和水彩 · 花瓣晕染', en: 'Soft watercolor · bleeding petals' },
        motion: { pan: 38, drift: 32 },
        palette: {
          base: '#F7F4EF',
          layer1: 'rgba(255, 255, 255, 0.60)',
          layer2: 'rgba(245, 240, 234, 0.44)',
          overlay: 'rgba(252, 249, 244, 0.74)',
          sidebar: 'rgba(250, 246, 240, 0.54)',
          border1: 'rgba(120, 90, 96, 0.18)',
          border2: 'rgba(255, 255, 255, 0.58)',
          brand: '#A05A66',
          brandHover: '#8A4A55',
          label1: '#2A2224',
          label2: '#6A565A',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#D8B7B7',
        },
        art: [
          'radial-gradient(70% 55% at 72% 34%, rgba(201, 124, 134, 0.34) 0%, rgba(201, 124, 134, 0) 62%)',
          'radial-gradient(55% 45% at 42% 60%, rgba(143, 169, 141, 0.28) 0%, rgba(143, 169, 141, 0) 66%)',
          'radial-gradient(45% 38% at 18% 76%, rgba(216, 183, 183, 0.30) 0%, rgba(216, 183, 183, 0) 70%)',
          'linear-gradient(160deg, #FBF8F3 0%, #F7F4EF 50%, #EDE6DE 100%)',
        ],
      },
      {
        id: 'color-field',
        native: 'light',
        order: 6,
        name: { zh: '色域抒情', en: 'Color Field' },
        tag: { zh: '抽象色块 · 颜料肌理', en: 'Abstract color fields · paint skin' },
        motion: { pan: 40, drift: 34 },
        palette: {
          base: '#F1EDE6',
          layer1: 'rgba(255, 255, 255, 0.58)',
          layer2: 'rgba(240, 235, 226, 0.44)',
          overlay: 'rgba(250, 246, 239, 0.74)',
          sidebar: 'rgba(247, 242, 234, 0.54)',
          border1: 'rgba(90, 70, 60, 0.18)',
          border2: 'rgba(255, 255, 255, 0.55)',
          brand: '#B05B4A',
          brandHover: '#954637',
          label1: '#241E1A',
          label2: '#5E4E45',
          success: '#5B7452',
          warn: '#A0702B',
          error: '#A8473E',
          neutral: '#C9A48E',
        },
        art: [
          'linear-gradient(112deg, rgba(176, 91, 74, 0.20) 0%, rgba(176, 91, 74, 0) 42%)',
          'linear-gradient(112deg, rgba(79, 124, 130, 0) 55%, rgba(79, 124, 130, 0.22) 78%, rgba(79, 124, 130, 0.05) 100%)',
          'radial-gradient(70% 60% at 30% 40%, rgba(201, 164, 142, 0.24) 0%, rgba(201, 164, 142, 0) 70%)',
          'linear-gradient(150deg, #F6F1EA 0%, #F1EDE6 55%, #E4DDD2 100%)',
        ],
      },
      {
        id: 'oil-dusk',
        native: 'dark',
        order: 7,
        name: { zh: '暮色油画', en: 'Oil Dusk' },
        tag: { zh: '旋转笔触 · 暮色油画', en: 'Swirling brushwork · oil dusk' },
        motion: { pan: 44, drift: 38 },
        palette: {
          base: '#171221',
          layer1: 'rgba(35, 26, 48, 0.64)',
          layer2: 'rgba(24, 17, 34, 0.56)',
          overlay: 'rgba(10, 7, 16, 0.78)',
          sidebar: 'rgba(20, 14, 30, 0.60)',
          border1: 'rgba(200, 150, 255, 0.16)',
          border2: 'rgba(224, 161, 92, 0.26)',
          brand: '#E0A15C',
          brandHover: '#EDB77A',
          label1: '#F3EDF5',
          label2: '#B9A9C4',
          success: '#7FC0A2',
          warn: '#E8B26A',
          error: '#EE8078',
          neutral: '#4F7C82',
        },
        art: [
          'radial-gradient(60% 50% at 72% 38%, rgba(224, 161, 92, 0.32) 0%, rgba(224, 161, 92, 0) 64%)',
          'radial-gradient(55% 45% at 30% 66%, rgba(79, 124, 130, 0.28) 0%, rgba(79, 124, 130, 0) 70%)',
          'repeating-conic-gradient(from 210deg at 70% 40%, rgba(255, 255, 255, 0) 0deg 8deg, rgba(150, 120, 220, 0.05) 10deg 14deg, rgba(255, 255, 255, 0) 16deg 28deg)',
          'linear-gradient(160deg, #1E1730 0%, #171221 55%, #0C0916 100%)',
        ],
      },
      {
        id: 'silver-film',
        native: 'dark',
        order: 8,
        name: { zh: '银盐光影', en: 'Silver Film' },
        tag: { zh: '银盐胶片 · 黑白光影', en: 'Silver gelatin · monochrome light' },
        motion: { pan: 46, drift: 40 },
        palette: {
          base: '#121314',
          layer1: 'rgba(30, 32, 34, 0.64)',
          layer2: 'rgba(20, 22, 24, 0.56)',
          overlay: 'rgba(8, 9, 10, 0.78)',
          sidebar: 'rgba(16, 17, 18, 0.60)',
          border1: 'rgba(200, 205, 210, 0.16)',
          border2: 'rgba(220, 225, 230, 0.24)',
          brand: '#C9CDD0',
          brandHover: '#DDE1E4',
          label1: '#F0F1F2',
          label2: '#A9ADB2',
          success: '#8FBFA4',
          warn: '#D6B073',
          error: '#E08585',
          neutral: '#8B8F94',
        },
        art: [
          'radial-gradient(70% 55% at 70% 30%, rgba(235, 238, 240, 0.18) 0%, rgba(235, 238, 240, 0) 66%)',
          'linear-gradient(180deg, rgba(200, 205, 210, 0) 42%, rgba(200, 205, 210, 0.10) 58%, rgba(0, 0, 0, 0.35) 100%)',
          'radial-gradient(60% 50% at 24% 70%, rgba(150, 155, 160, 0.12) 0%, rgba(150, 155, 160, 0) 70%)',
          'linear-gradient(155deg, #2A2C2E 0%, #1A1C1E 48%, #0B0C0D 100%)',
        ],
      },
      /* ------------------------------------------------------------------ *
       * Batch 2 (v1.2.0): 古风 · 人间温暖 · 远方星河
       * Prompts: design/deepseek-harness-theme-prompts-v2.md
       * Drop `<id>.jpg` into wallpapers/ to replace the generated art layer.
       * ------------------------------------------------------------------ */
      {
        id: 'spring-river',
        native: 'light',
        order: 9,
        name: { zh: '春江水暖', en: 'Spring River' },
        tag: { zh: '梅枝春水 · 回暖希望', en: 'Plum branch · spring warmth' },
        motion: { pan: 38, drift: 34 },
        palette: {
          base: '#F6F1E9',
          layer1: 'rgba(255, 255, 255, 0.60)',
          layer2: 'rgba(243, 236, 226, 0.46)',
          overlay: 'rgba(250, 246, 238, 0.76)',
          sidebar: 'rgba(248, 243, 234, 0.56)',
          border1: 'rgba(120, 90, 80, 0.16)',
          border2: 'rgba(255, 255, 255, 0.58)',
          brand: '#A9616A',
          brandHover: '#8F4F58',
          label1: '#2F2523',
          label2: '#6B5852',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#D8B7B7',
        },
        art: [
          'radial-gradient(72% 58% at 72% 32%, rgba(201, 124, 134, 0.30) 0%, rgba(201, 124, 134, 0) 64%)',
          'radial-gradient(58% 46% at 40% 66%, rgba(143, 169, 141, 0.22) 0%, rgba(143, 169, 141, 0) 68%)',
          'repeating-linear-gradient(96deg, rgba(120, 90, 80, 0) 0 52px, rgba(120, 90, 80, 0.04) 53px, rgba(120, 90, 80, 0) 54px 118px)',
          'linear-gradient(160deg, #FBF8F2 0%, #F6F1E9 50%, #EDE4D6 100%)',
        ],
      },
      {
        id: 'bamboo-wind',
        native: 'light',
        order: 10,
        name: { zh: '竹影清风', en: 'Bamboo Wind' },
        tag: { zh: '竹影疏密 · 清正从容', en: 'Bamboo shadows · quiet poise' },
        motion: { pan: 40, drift: 36 },
        palette: {
          base: '#F5F2EA',
          layer1: 'rgba(255, 255, 255, 0.60)',
          layer2: 'rgba(238, 236, 228, 0.46)',
          overlay: 'rgba(249, 247, 240, 0.76)',
          sidebar: 'rgba(246, 243, 235, 0.56)',
          border1: 'rgba(60, 80, 66, 0.18)',
          border2: 'rgba(255, 255, 255, 0.56)',
          brand: '#3F5249',
          brandHover: '#2F4038',
          label1: '#222B26',
          label2: '#55645B',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#B9C6B4',
        },
        art: [
          'repeating-linear-gradient(94deg, rgba(47, 58, 51, 0) 0 44px, rgba(47, 58, 51, 0.08) 46px 52px, rgba(47, 58, 51, 0) 54px 128px)',
          'repeating-linear-gradient(88deg, rgba(47, 58, 51, 0) 0 96px, rgba(82, 100, 90, 0.06) 98px 104px, rgba(47, 58, 51, 0) 106px 210px)',
          'radial-gradient(70% 56% at 72% 30%, rgba(110, 133, 116, 0.28) 0%, rgba(110, 133, 116, 0) 66%)',
          'linear-gradient(158deg, #F9F7F0 0%, #F5F2EA 52%, #E9E5DA 100%)',
        ],
      },
      {
        id: 'morning-page',
        native: 'light',
        order: 11,
        name: { zh: '晨光书页', en: 'Morning Page' },
        tag: { zh: '晨光书桌 · 温柔希望', en: 'Morning desk · gentle hope' },
        motion: { pan: 36, drift: 32 },
        palette: {
          base: '#F7F1E6',
          layer1: 'rgba(255, 253, 247, 0.62)',
          layer2: 'rgba(245, 236, 222, 0.48)',
          overlay: 'rgba(252, 246, 236, 0.78)',
          sidebar: 'rgba(250, 244, 234, 0.58)',
          border1: 'rgba(140, 98, 57, 0.18)',
          border2: 'rgba(255, 255, 255, 0.60)',
          brand: '#9A6A42',
          brandHover: '#7E5433',
          label1: '#2E241B',
          label2: '#6B5642',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#D9C2A8',
        },
        art: [
          'radial-gradient(78% 62% at 76% 26%, rgba(242, 201, 138, 0.42) 0%, rgba(242, 201, 138, 0) 66%)',
          'linear-gradient(118deg, rgba(255, 246, 232, 0) 30%, rgba(255, 246, 232, 0.5) 58%, rgba(255, 246, 232, 0) 82%)',
          'radial-gradient(52% 44% at 30% 74%, rgba(185, 138, 94, 0.14) 0%, rgba(185, 138, 94, 0) 70%)',
          'linear-gradient(160deg, #FBF6EC 0%, #F7F1E6 50%, #EDE2D2 100%)',
        ],
      },
      {
        id: 'sea-horizon',
        native: 'light',
        order: 12,
        name: { zh: '海阔天空', en: 'Sea Horizon' },
        tag: { zh: '日出海平线 · 重新出发', en: 'Sunrise horizon · set out again' },
        motion: { pan: 42, drift: 38 },
        palette: {
          base: '#F4EEE4',
          layer1: 'rgba(255, 255, 255, 0.60)',
          layer2: 'rgba(237, 231, 220, 0.46)',
          overlay: 'rgba(249, 246, 239, 0.78)',
          sidebar: 'rgba(246, 241, 232, 0.56)',
          border1: 'rgba(88, 112, 108, 0.18)',
          border2: 'rgba(255, 255, 255, 0.56)',
          brand: '#5C7C78',
          brandHover: '#47615E',
          label1: '#23302E',
          label2: '#5A6C68',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#BFD0CE',
        },
        art: [
          'radial-gradient(72% 58% at 74% 30%, rgba(242, 201, 138, 0.44) 0%, rgba(242, 201, 138, 0) 64%)',
          'linear-gradient(180deg, rgba(191, 208, 206, 0) 46%, rgba(147, 173, 169, 0.26) 74%, rgba(110, 133, 128, 0.34) 100%)',
          'linear-gradient(112deg, rgba(247, 243, 234, 0) 42%, rgba(255, 250, 240, 0.32) 62%, rgba(247, 243, 234, 0) 86%)',
          'linear-gradient(160deg, #F9F4EB 0%, #F4EEE4 50%, #E7DAC7 100%)',
        ],
      },
      {
        id: 'lantern-night',
        native: 'dark',
        order: 13,
        name: { zh: '灯下夜读', en: 'Lantern Night' },
        tag: { zh: '一灯夜读 · 温暖陪伴', en: 'One warm lamp · night reading' },
        motion: { pan: 44, drift: 38 },
        palette: {
          base: '#12141C',
          layer1: 'rgba(32, 30, 32, 0.64)',
          layer2: 'rgba(24, 22, 26, 0.56)',
          overlay: 'rgba(10, 10, 16, 0.80)',
          sidebar: 'rgba(18, 17, 22, 0.62)',
          border1: 'rgba(224, 161, 92, 0.18)',
          border2: 'rgba(242, 201, 138, 0.24)',
          brand: '#E0A15C',
          brandHover: '#EDB77A',
          label1: '#F4EDE2',
          label2: '#B3A78F',
          success: '#7FC0A2',
          warn: '#E8B26A',
          error: '#EE8078',
          neutral: '#C9B08A',
        },
        art: [
          'radial-gradient(46% 38% at 74% 40%, rgba(242, 201, 138, 0.46) 0%, rgba(242, 201, 138, 0) 68%)',
          'radial-gradient(70% 60% at 26% 72%, rgba(58, 44, 34, 0.46) 0%, rgba(58, 44, 34, 0) 72%)',
          'linear-gradient(180deg, rgba(18, 20, 28, 0) 38%, rgba(9, 11, 16, 0.55) 78%, rgba(9, 11, 16, 0.88) 100%)',
          'linear-gradient(155deg, #1B2130 0%, #12141C 52%, #090B10 100%)',
        ],
      },
      {
        id: 'starry-journey',
        native: 'dark',
        order: 14,
        name: { zh: '星河长夜', en: 'Starry Journey' },
        tag: { zh: '银河远山 · 旅途辽阔', en: 'Milky Way · the long journey' },
        motion: { pan: 48, drift: 42 },
        palette: {
          base: '#0B1220',
          layer1: 'rgba(26, 36, 54, 0.66)',
          layer2: 'rgba(16, 26, 44, 0.58)',
          overlay: 'rgba(6, 10, 20, 0.82)',
          sidebar: 'rgba(10, 16, 28, 0.62)',
          border1: 'rgba(159, 182, 218, 0.16)',
          border2: 'rgba(199, 214, 238, 0.24)',
          brand: '#9FB6DA',
          brandHover: '#C0CFEA',
          label1: '#EEF2FA',
          label2: '#A9B6C9',
          success: '#6FC2A0',
          warn: '#DDB271',
          error: '#EE8A84',
          neutral: '#8FA9D6',
        },
        art: [
          'radial-gradient(24% 16% at 66% 30%, rgba(234, 240, 250, 0.55) 0%, rgba(234, 240, 250, 0) 70%)',
          'radial-gradient(1.5px 1.5px at 22% 34%, rgba(234, 240, 250, 0.8) 0%, rgba(234, 240, 250, 0) 100%)',
          'radial-gradient(1px 1px at 41% 22%, rgba(234, 240, 250, 0.7) 0%, rgba(234, 240, 250, 0) 100%)',
          'radial-gradient(1px 1px at 57% 48%, rgba(234, 240, 250, 0.6) 0%, rgba(234, 240, 250, 0) 100%)',
          'radial-gradient(1px 1px at 78% 18%, rgba(234, 240, 250, 0.65) 0%, rgba(234, 240, 250, 0) 100%)',
          'linear-gradient(160deg, #101A2C 0%, #0B1220 52%, #131C2C 100%)',
        ],
      },
      {
        id: 'ancient-path',
        native: 'light',
        order: 15,
        name: { zh: '古道远行', en: 'Ancient Path' },
        tag: { zh: '山道雾峰 · 人生旅途', en: 'Mountain path · the journey' },
        motion: { pan: 42, drift: 36 },
        palette: {
          base: '#F1EEE7',
          layer1: 'rgba(255, 255, 255, 0.6)',
          layer2: 'rgba(240, 237, 231, 0.46)',
          overlay: 'rgba(248, 246, 241, 0.76)',
          sidebar: 'rgba(245, 242, 236, 0.56)',
          border1: 'rgba(58, 67, 72, 0.18)',
          border2: 'rgba(255, 255, 255, 0.56)',
          brand: '#4A5B52',
          brandHover: '#37463E',
          label1: '#22272B',
          label2: '#566166',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#B9C2BE',
        },
        art: [
          'radial-gradient(72% 60% at 70% 26%, rgba(86, 97, 102, 0.26) 0%, rgba(86, 97, 102, 0) 66%)',
          'linear-gradient(180deg, rgba(216, 220, 214, 0.18) 0%, rgba(216, 220, 214, 0) 46%)',
          'radial-gradient(48% 40% at 28% 72%, rgba(185, 138, 94, 0.12) 0%, rgba(185, 138, 94, 0) 70%)',
          'linear-gradient(160deg, #F7F4EE 0%, #F1EEE7 52%, #E4E1DA 100%)',
        ],
      },
      {
        id: 'lotus-dawn',
        native: 'light',
        order: 16,
        name: { zh: '荷塘晨露', en: 'Lotus Dawn' },
        tag: { zh: '晨雾荷塘 · 清白新生', en: 'Dawn lotus pond · fresh hope' },
        motion: { pan: 38, drift: 34 },
        palette: {
          base: '#F7F4EE',
          layer1: 'rgba(255, 255, 255, 0.62)',
          layer2: 'rgba(243, 241, 233, 0.46)',
          overlay: 'rgba(250, 248, 243, 0.78)',
          sidebar: 'rgba(247, 244, 238, 0.56)',
          border1: 'rgba(92, 122, 90, 0.16)',
          border2: 'rgba(255, 255, 255, 0.56)',
          brand: '#A9676F',
          brandHover: '#8E525A',
          label1: '#26302B',
          label2: '#5F6D64',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#C9D6CB',
        },
        art: [
          'radial-gradient(66% 52% at 68% 34%, rgba(143, 169, 141, 0.30) 0%, rgba(143, 169, 141, 0) 66%)',
          'radial-gradient(44% 36% at 34% 66%, rgba(201, 141, 150, 0.18) 0%, rgba(201, 141, 150, 0) 70%)',
          'linear-gradient(180deg, rgba(220, 231, 230, 0.22) 0%, rgba(220, 231, 230, 0) 50%)',
          'linear-gradient(160deg, #FBFAF5 0%, #F7F4EE 52%, #EDE7DC 100%)',
        ],
      },
      {
        id: 'home-smoke',
        native: 'light',
        order: 17,
        name: { zh: '炊烟归处', en: 'Home Smoke' },
        tag: { zh: '黄昏炊烟 · 归家温暖', en: 'Dusk smoke · coming home' },
        motion: { pan: 40, drift: 36 },
        palette: {
          base: '#F6EDE0',
          layer1: 'rgba(255, 252, 246, 0.62)',
          layer2: 'rgba(243, 233, 220, 0.48)',
          overlay: 'rgba(251, 245, 235, 0.78)',
          sidebar: 'rgba(249, 241, 231, 0.58)',
          border1: 'rgba(140, 98, 57, 0.18)',
          border2: 'rgba(255, 255, 255, 0.58)',
          brand: '#B05B4A',
          brandHover: '#954637',
          label1: '#2E241C',
          label2: '#6B5642',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#D9BE9C',
        },
        art: [
          'radial-gradient(74% 60% at 74% 28%, rgba(242, 201, 138, 0.42) 0%, rgba(242, 201, 138, 0) 66%)',
          'linear-gradient(180deg, rgba(246, 231, 210, 0) 40%, rgba(201, 164, 106, 0.22) 72%, rgba(107, 86, 66, 0.28) 100%)',
          'radial-gradient(46% 38% at 26% 70%, rgba(176, 91, 74, 0.12) 0%, rgba(176, 91, 74, 0) 70%)',
          'linear-gradient(160deg, #FBF2E4 0%, #F6EDE0 52%, #EFD3AF 100%)',
        ],
      },
      {
        id: 'rain-tea',
        native: 'light',
        order: 18,
        name: { zh: '雨窗煮茶', en: 'Rain Tea' },
        tag: { zh: '雨打窗格 · 慢煮时光', en: 'Rain on the lattice · slow time' },
        motion: { pan: 36, drift: 32 },
        palette: {
          base: '#E9EDE8',
          layer1: 'rgba(255, 255, 255, 0.6)',
          layer2: 'rgba(232, 237, 232, 0.46)',
          overlay: 'rgba(244, 248, 244, 0.78)',
          sidebar: 'rgba(238, 242, 238, 0.56)',
          border1: 'rgba(92, 122, 120, 0.16)',
          border2: 'rgba(255, 255, 255, 0.56)',
          brand: '#6B8578',
          brandHover: '#557064',
          label1: '#22302C',
          label2: '#566A62',
          success: '#5C7A5A',
          warn: '#8F6F2F',
          error: '#A94B45',
          neutral: '#B9C7C4',
        },
        art: [
          'repeating-linear-gradient(100deg, rgba(185, 199, 201, 0) 0 26px, rgba(185, 199, 201, 0.16) 27px, rgba(185, 199, 201, 0) 29px 64px)',
          'linear-gradient(180deg, rgba(233, 237, 232, 0) 46%, rgba(155, 179, 172, 0.18) 78%, rgba(107, 133, 120, 0.24) 100%)',
          'radial-gradient(52% 42% at 70% 40%, rgba(201, 164, 106, 0.16) 0%, rgba(201, 164, 106, 0) 70%)',
          'linear-gradient(160deg, #F1F5F0 0%, #E9EDE8 52%, #D5DDD8 100%)',
        ],
      },
      {
        id: 'summit-dawn',
        native: 'light',
        order: 19,
        name: { zh: '云海日出', en: 'Summit Dawn' },
        tag: { zh: '登顶云海 · 豁然开朗', en: 'Above the clouds · clarity' },
        motion: { pan: 44, drift: 38 },
        palette: {
          base: '#F4EFE6',
          layer1: 'rgba(255, 255, 255, 0.62)',
          layer2: 'rgba(241, 236, 226, 0.46)',
          overlay: 'rgba(250, 246, 240, 0.78)',
          sidebar: 'rgba(246, 241, 232, 0.56)',
          border1: 'rgba(93, 107, 106, 0.18)',
          border2: 'rgba(255, 255, 255, 0.56)',
          brand: '#5D6B6A',
          brandHover: '#475654',
          label1: '#24302F',
          label2: '#5A6A68',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#C6D0CC',
        },
        art: [
          'radial-gradient(66% 54% at 76% 28%, rgba(242, 201, 138, 0.4) 0%, rgba(242, 201, 138, 0) 64%)',
          'linear-gradient(180deg, rgba(239, 231, 218, 0) 44%, rgba(214, 220, 212, 0.22) 74%, rgba(93, 107, 106, 0.24) 100%)',
          'radial-gradient(52% 44% at 30% 66%, rgba(255, 250, 240, 0.34) 0%, rgba(255, 250, 240, 0) 72%)',
          'linear-gradient(160deg, #F9F5EC 0%, #F4EFE6 52%, #E8DCC8 100%)',
        ],
      },
      {
        id: 'paper-wish',
        native: 'light',
        order: 20,
        name: { zh: '纸鹤寄愿', en: 'Paper Wish' },
        tag: { zh: '纸鹤纸船 · 祝愿心意', en: 'Paper cranes · a wish' },
        motion: { pan: 38, drift: 34 },
        palette: {
          base: '#F7F2E8',
          layer1: 'rgba(255, 253, 247, 0.62)',
          layer2: 'rgba(244, 236, 224, 0.48)',
          overlay: 'rgba(251, 247, 239, 0.78)',
          sidebar: 'rgba(249, 244, 235, 0.58)',
          border1: 'rgba(140, 110, 80, 0.18)',
          border2: 'rgba(255, 255, 255, 0.58)',
          brand: '#96683D',
          brandHover: '#7C5430',
          label1: '#2E241B',
          label2: '#6B5B48',
          success: '#5C7A5A',
          warn: '#A2762F',
          error: '#A94B45',
          neutral: '#E0CDB2',
        },
        art: [
          'radial-gradient(72% 58% at 72% 34%, rgba(242, 230, 214, 0.5) 0%, rgba(242, 230, 214, 0) 66%)',
          'radial-gradient(42% 34% at 34% 68%, rgba(201, 141, 150, 0.16) 0%, rgba(201, 141, 150, 0) 70%)',
          'linear-gradient(118deg, rgba(255, 252, 246, 0) 40%, rgba(255, 252, 246, 0.4) 60%, rgba(255, 252, 246, 0) 82%)',
          'linear-gradient(160deg, #FBF7EF 0%, #F7F2E8 52%, #EDE4D6 100%)',
        ],
      },
    ];

    /* ------------------------------------------------------------------ *
     * Companion palettes: every family reads well in both schemes.
     * ------------------------------------------------------------------ */

    function companionPalette(palette, native) {
      if (native === 'light') {
        const base = mixIntoTint(palette.brand, '#07080A', 0.88);
        const brand = ensureMinLuma(luminance(palette.brand) < 0.34 ? lighten(palette.brand, 0.46) : palette.brand, 0.34);
        const label1 = mixIntoTint('#FFFFFF', palette.brand, 0.05);
        return {
          base,
          layer1: rgba(mixIntoTint(base, '#FFFFFF', 0.07), 0.6),
          layer2: rgba(mixIntoTint(base, '#FFFFFF', 0.035), 0.52),
          overlay: rgba(mixIntoTint(base, '#000000', 0.28), 0.78),
          sidebar: rgba(base, 0.56),
          border1: rgba(mixIntoTint(palette.brand, '#FFFFFF', 0.55), 0.18),
          border2: rgba(mixIntoTint(palette.brand, '#FFFFFF', 0.35), 0.28),
          brand,
          brandHover: lighten(brand, 0.1),
          label1,
          label2: ensureMinLuma(mixIntoTint(label1, base, 0.38), 0.3),
          success: ensureMinLuma(lighten(palette.success, 0.18), 0.26),
          warn: ensureMinLuma(lighten(palette.warn, 0.2), 0.26),
          error: ensureMinLuma(lighten(palette.error, 0.16), 0.26),
          neutral: palette.brand,
        };
      }
      const base = mixIntoTint(palette.brand, '#F7F5F1', 0.93);
      const brand = ensureMaxLuma(luminance(palette.brand) > 0.34 ? darken(palette.brand, 0.58) : palette.brand, 0.12);
      const label1 = ensureMaxLuma(mixIntoTint(darken(palette.brand, 0.84), '#0B0F14', 0.72), 0.02);
      return {
        base,
        layer1: rgba('#FFFFFF', 0.64),
        layer2: rgba(mixIntoTint(base, '#FFFFFF', 0.4), 0.48),
        overlay: rgba(mixIntoTint('#FFFFFF', base, 0.35), 0.76),
        sidebar: rgba(mixIntoTint('#FFFFFF', base, 0.45), 0.6),
        border1: rgba(darken(palette.brand, 0.5), 0.18),
        border2: rgba('#FFFFFF', 0.6),
        brand,
        brandHover: darken(brand, 0.1),
        label1,
        label2: ensureMaxLuma(mixIntoTint(label1, base, 0.34), 0.1),
        success: ensureMaxLuma(darken(palette.success, 0.38), 0.09),
        warn: ensureMaxLuma(darken(palette.warn, 0.36), 0.09),
        error: ensureMaxLuma(darken(palette.error, 0.32), 0.09),
        neutral: palette.brand,
      };
    }

    /* ------------------------------------------------------------------ *
     * Token expansion — a complete alias layer per scheme
     * ------------------------------------------------------------------ */

    function expandTokens(palette, scheme) {
      const dark = scheme === 'dark';
      const base = palette.base;
      const brand = palette.brand;
      const ink = palette.label1;
      const ink2 = palette.label2;
      const positive = palette.success;
      const warning = palette.warn;
      const negative = palette.error;
      /* Opaque surfaces. The host treats layers 1–3 and the overlay as solid
       * surfaces (its native tokens are opaque). Keeping them translucent let
       * chat text and tool output show through cards, diffs and the composer, so
       * the theme now reveals the wallpaper only on the window canvas (bg-base)
       * and renders every raised, text-bearing surface solid. */
      const codeBlock = mixIntoTint(base, '#000000', dark ? 0.18 : 0.035);
      const codeBanner = mixIntoTint(base, '#000000', dark ? 0.24 : 0.06);
      const menuFill = mixIntoTint(base, '#FFFFFF', dark ? 0.07 : 0.1);
      const floatingFill = mixIntoTint(base, '#FFFFFF', dark ? 0.09 : 0.3);
      const toastFill = dark ? mixIntoTint(base, '#000000', 0.06) : mixIntoTint(ink, '#000000', 0.18);
      const tooltipFill = dark ? mixIntoTint(base, '#000000', 0.06) : mixIntoTint(ink, '#000000', 0.18);
      /* Muted labels still have to read over a photographic wallpaper: derive the
       * whole secondary ladder from the primary ink, so trajectory/tool rows and
       * captions keep a measurable contrast floor instead of washing out on busy
       * artwork (previous values were mixed toward the paper base, i.e. faded). */
      const secondary = mixIntoTint(ink, base, dark ? 0.06 : 0.03);
      const tertiary = mixIntoTint(ink, base, dark ? 0.12 : 0.07);
      const caption = mixIntoTint(ink, base, dark ? 0.18 : 0.12);
      const dimmed = mixIntoTint(ink, base, dark ? 0.26 : 0.18);
      const surface1 = mixIntoTint(base, '#FFFFFF', dark ? 0.07 : 0.22);
      const surface2 = mixIntoTint(base, '#FFFFFF', dark ? 0.1 : 0.3);
      const surface3 = mixIntoTint(base, '#FFFFFF', dark ? 0.13 : 0.38);
      const overlay = mixIntoTint(base, '#FFFFFF', dark ? 0.09 : 0.28);
      /* The sidebar is a canvas surface too: keep it on the same clarity
       * ladder as the content column, otherwise clear mode leaves a pale
       * rectangle on the left that reads as a different, unthemed panel. */
      const sidebarFill = rgba(mixIntoTint(palette.sidebar, base, 0.6), dark ? 0.35 : 0.4);
      const hover = rgba(ink, dark ? 0.075 : 0.065);
      const active = rgba(ink, dark ? 0.12 : 0.105);
      return {
        '--dsw-alias-bg-base': rgba(base, dark ? 0.35 : 0.4),
        '--dsw-alias-bg-layer-1': surface1,
        '--dsw-alias-bg-layer-2': surface2,
        '--dsw-alias-bg-layer-3': surface3,
        '--dsw-alias-bg-overlay': overlay,
        '--dsw-alias-bg-module-platform': surface2,
        '--dsw-alias-bg-document-preview': surface2,
        '--dsw-alias-bg-document-selection': rgba(brand, 0.3),
        '--dsw-alias-bg-skeleton': rgba(ink, 0.06),
        '--dsw-alias-bg-multi-select': rgba(brand, 0.14),
        '--dsw-alias-bg-mask-drop': dark ? 'rgba(39, 39, 48, 0.7)' : 'rgba(255, 255, 255, 0.7)',
        '--dsw-alias-border-l1': palette.border1,
        '--dsw-alias-border-l2': palette.border2,
        '--dsw-alias-border-l3': rgba(ink, dark ? 0.14 : 0.15),
        '--dsw-alias-border-l4': rgba(ink, dark ? 0.2 : 0.2),
        '--dsw-alias-border-l2-darkmode-thin': palette.border2,
        '--dsw-alias-border-inverted': rgba('#FFFFFF', dark ? 0.08 : 0.3),
        '--dsw-alias-border-inverted2': rgba('#FFFFFF', dark ? 0.12 : 0.42),
        '--dsw-alias-brand-primary': brand,
        '--dsw-alias-brand-primary-invert': ink,
        '--dsw-alias-brand-primary-new-colorprimary-new-color': brand,
        '--dsw-alias-brand-text': brand,
        '--dsw-alias-label-primary': ink,
        '--dsw-alias-label-primary-bluish': ink,
        '--dsw-alias-label-primary-dimmed': mixIntoTint(ink, base, 0.22),
        '--dsw-alias-label-primary-foreground': dark ? mixIntoTint(base, '#000000', 0.5) : '#FFFFFF',
        '--dsw-alias-label-primary-inverted': dark ? mixIntoTint(base, '#FFFFFF', 0.12) : '#FFFFFF',
        '--dsw-alias-label-secondary': secondary,
        '--dsw-alias-label-tertiary': tertiary,
        '--dsw-alias-label-caption': caption,
        '--dsw-alias-label-dimmed': dimmed,
        '--dsw-alias-label-document-preview': ink2,
        '--dsw-alias-label-deep-diving': brand,
        '--dsw-alias-label-deep-diving-shimmer': lighten(brand, dark ? 0.24 : 0.14),
        '--dsw-alias-link': brand,
        '--dsw-alias-state-business-primary': brand,
        '--dsw-alias-state-business-tertiary': rgba(brand, 0.15),
        '--dsw-alias-state-done-primary': brand,
        '--dsw-alias-state-idle-primary': mixIntoTint(ink2, base, 0.5),
        '--dsw-alias-state-success-primary': positive,
        '--dsw-alias-state-success-secondary': positive,
        '--dsw-alias-state-success-tertiary': rgba(positive, 0.15),
        '--dsw-alias-state-warn-primary': warning,
        '--dsw-alias-state-warn-secondary': warning,
        '--dsw-alias-state-warn-tertiary': rgba(warning, 0.15),
        '--dsw-alias-state-warn-label': warning,
        '--dsw-alias-state-error-primary': negative,
        '--dsw-alias-state-error-secondary': negative,
        '--dsw-alias-state-error-tertiary': rgba(negative, 0.15),
        '--dsw-alias-interactive-bg-hover': hover,
        '--dsw-alias-interactive-bg-active': active,
        '--dsw-alias-interactive-bg-hover-accent': rgba(brand, 0.12),
        '--dsw-alias-interactive-bg-hover-danger': rgba(negative, 0.09),
        '--dsw-alias-interactive-bg-hover-solid': dark ? rgba(mixIntoTint(base, '#FFFFFF', 0.07), 0.9) : rgba(mixIntoTint(base, '#000000', 0.05), 0.9),
        '--dsw-alias-button-primary-fill': brand,
        '--dsw-alias-button-primary-hover': palette.brandHover,
        '--dsw-alias-button-primary-dimmed': rgba(brand, 0.18),
        '--dsw-alias-button-contrast-fill': ink,
        '--dsw-alias-button-elevated-fill': floatingFill,
        '--dsw-alias-button-floating-fill': floatingFill,
        '--dsw-alias-button-floating-hover': dark ? rgba(mixIntoTint(base, '#FFFFFF', 0.1), 0.9) : rgba('#FFFFFF', 0.86),
        '--dsw-alias-button-ghost-active-fill': rgba(ink, 0.09),
        '--dsw-alias-button-ghost-active-hover': rgba(ink, 0.13),
        '--dsw-alias-button-ghost-active-border': rgba(ink, 0.22),
        '--dsw-alias-button-info-fill': brand,
        '--dsw-alias-button-info-hover': palette.brandHover,
        '--dsw-alias-button-tool-bar-fill': rgba(mixIntoTint(ink, '#000000', 0.25), 0.36),
        '--dsw-alias-button-tool-bar-fill-invisible': rgba(mixIntoTint(ink, '#000000', 0.25), 0.24),
        '--dsw-alias-button-tool-bar-hover': rgba(mixIntoTint(ink, '#000000', 0.25), 0.48),
        '--dsw-alias-markdown-code-block': codeBlock,
        '--dsw-alias-markdown-code-block-banner': codeBanner,
        '--dsw-alias-markdown-code-segment-selected': surface1,
        '--dsw-alias-markdown-code-segment-unselected': mixIntoTint(base, '#000000', dark ? 0.22 : 0.02),
        '--dsw-alias-markdown-inline-code': rgba(ink, 0.07),
        '--dsw-alias-markdown-placeholder': rgba(ink, 0.08),
        '--dsw-alias-markdown-tag': surface1,
        '--dsw-alias-markdown-citation': mixIntoTint(base, '#FFFFFF', dark ? 0.12 : 0.3),
        '--dsw-alias-menu-surface-fill': menuFill,
        '--dsw-alias-menu-group-header-fill': menuFill,
        '--dsw-alias-menu-icon': ink2,
        '--dsw-alias-scrollbar-bg-l1': rgba(ink, dark ? 0.16 : 0.16),
        '--dsw-alias-scrollbar-bg-l2': rgba(ink, dark ? 0.22 : 0.22),
        '--dsw-alias-scrollbar-hover-l1': rgba(ink, dark ? 0.28 : 0.28),
        '--dsw-alias-scrollbar-hover-l2': rgba(ink, dark ? 0.34 : 0.34),
        '--dsw-alias-switch-thumb': dark ? mixIntoTint(base, '#FFFFFF', 0.62) : '#FFFFFF',
        '--dsw-alias-toast-bg': toastFill,
        '--dsw-alias-toast-label': '#FFFFFF',
        '--dsw-alias-tooltip-bg': tooltipFill,
        '--dsw-alias-tooltip-key-bg': `color-mix(in srgb, ${tooltipFill} 82%, white)`,
        '--dsw-alias-turn-trigger-bg': codeBlock,
        '--dsw-alias-turn-trigger-bg-hover': hover,
        '--dsw-alias-illustration-background': rgba(base, 0.5),
        '--dsw-alias-illustration-surface': surface2,
        '--dsw-alias-illustration-backing': rgba(ink, 0.18),
        '--dsw-alias-illustration-detail': rgba(ink, 0.3),
        '--dsw-alias-illustration-inset': rgba(base, 0.6),
        '--dsw-alias-illustration-shadow': rgba(base, 0.6),
        '--dsw-alias-code-diff-added': rgba(positive, 0.11),
        '--dsw-alias-code-diff-deleted': rgba(negative, 0.11),
        '--dsw-alias-file-diff-added-bg': rgba(positive, 0.13),
        '--dsw-alias-file-diff-added-gutter': rgba(positive, 0.08),
        '--dsw-alias-file-diff-added-marker': positive,
        '--dsw-alias-file-diff-deleted-bg': rgba(negative, 0.13),
        '--dsw-alias-file-diff-deleted-gutter': rgba(negative, 0.08),
        '--dsw-alias-file-diff-deleted-marker': negative,
        '--dsw-specific-sidebar-fill': sidebarFill,
        '--dsw-specific-menu': menuFill,
        '--dsw-menu-surface-fill': menuFill,
        /* Text-bearing surfaces (composer card, approval cards, file cards, notices)
         * must never let the conversation behind show through: the native token is
         * opaque, so the theme keeps it opaque paper instead of a translucent tint. */
        '--dsw-specific-input-major': mixIntoTint(base, '#FFFFFF', dark ? 0.07 : 0.24),
        '--dsw-specific-login-input': rgba(base, 0.55),
        '--dsw-specific-selector': mixIntoTint(base, '#FFFFFF', dark ? 0.12 : 0.36),
        '--dsw-specific-tip': mixIntoTint(base, '#FFFFFF', dark ? 0.1 : 0.3),
        '--dsw-specific-bubble': rgba(brand, dark ? 0.12 : 0.1),
        '--dsw-specific-bubble-highlight': rgba(brand, 0.18),
        '--dsw-specific-sidebar-nav-item-active': rgba(ink, 0.07),
        '--dsw-specific-sidebar-nav-item-active-accent': rgba(brand, 0.16),
      };
    }

    /* ------------------------------------------------------------------ *
     * Generated wallpaper layers
     * ------------------------------------------------------------------ */

    function autoArt(palette, scheme) {
      const dark = scheme === 'dark';
      return [
        `radial-gradient(92% 76% at 74% 40%, ${rgba(palette.brand, dark ? 0.3 : 0.4)} 0%, ${rgba(palette.brand, 0)} 62%)`,
        `radial-gradient(64% 54% at 60% 58%, ${rgba(palette.neutral || palette.label2, dark ? 0.22 : 0.32)} 0%, ${rgba(palette.neutral || palette.label2, 0)} 66%)`,
        `radial-gradient(52% 42% at 18% 72%, ${rgba(palette.brand, dark ? 0.12 : 0.1)} 0%, ${rgba(palette.brand, 0)} 70%)`,
        `linear-gradient(112deg, ${lighten(palette.base, 0.03)} 0%, ${palette.base} 55%, ${darken(palette.base, 0.06)} 100%)`,
      ];
    }

    /**
     * An overlay colour whose alpha is scaled by `--ts-veil`, the user's
     * background-clarity setting (soft 1 / standard 0.7 / clear 0.45 in light).
     * Keeping the scale inside calc() means one scrim definition per family can
     * serve every clarity level instead of three duplicated gradients.
     */
    function veil(color, alpha) {
      const parsed = parseColor(color);
      return `rgb(${Math.round(parsed.r)} ${Math.round(parsed.g)} ${Math.round(parsed.b)} / calc(${alpha} * var(--ts-veil, 1)))`;
    }

    function scrimFor(palette, scheme) {
      const dark = scheme === 'dark';
      const base = palette.base;
      return [
        dark
          ? `linear-gradient(90deg, ${veil(base, 0.78)} 0%, ${veil(base, 0.5)} 24%, ${veil(base, 0.16)} 55%, ${veil(base, 0.12)} 78%, ${veil(base, 0.34)} 100%)`
          : `linear-gradient(90deg, ${veil(base, 0.88)} 0%, ${veil(base, 0.52)} 24%, ${veil(base, 0.12)} 55%, ${veil(base, 0.1)} 78%, ${veil(base, 0.3)} 100%)`,
        dark
          ? `linear-gradient(180deg, ${veil(base, 0.55)} 0%, transparent 24%, transparent 62%, ${veil(base, 0.42)} 100%)`
          : `linear-gradient(180deg, ${veil(base, 0.42)} 0%, transparent 24%, transparent 62%, ${veil(base, 0.38)} 100%)`,
      ].join(', ');
    }

    /**
     * Paper fill for modal sheets (dialogs, panels).
     *
     * The host paints its dialog panels with the raised-surface token
     * (`--dsw-alias-bg-layer-2`), which this theme keeps translucent for the
     * in-page cards that reveal the wallpaper. Inside a dialog that token lets
     * the conversation behind ghost through the panel, so sheets carry their own
     * opaque paper colour. The value is deliberately fully opaque: at 3% alpha
     * the leftover text of a dense transcript is still legible in flat areas,
     * and a modal is read, not looked through.
     */
    function sheetFor(palette, scheme) {
      const dark = scheme === 'dark';
      return mixIntoTint(palette.base, '#FFFFFF', dark ? 0.06 : 0.2);
    }

    function glowFor(palette, scheme) {
      const dark = scheme === 'dark';
      return [
        `radial-gradient(52% 42% at 72% 38%, ${veil('#FFFFFF', dark ? 0.05 : 0.07)} 0%, transparent 70%)`,
        `radial-gradient(42% 38% at 24% 24%, ${veil(palette.brand, dark ? 0.09 : 0.05)} 0%, transparent 72%)`,
      ].join(', ');
    }

    function sheenFor(scheme) {
      return `linear-gradient(118deg, transparent 34%, ${veil('#FFFFFF', scheme === 'dark' ? 0.035 : 0.06)} 48%, transparent 62%)`;
    }

    const NOISE_DATA_URI =
      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='140' height='140' filter='url(%23n)' opacity='0.34'/></svg>\")";

    /* Focal point (horizontal background-position) per theme. `cover` on a 16:9
     * window crops ~12% of a 3840-wide image; themes whose subject sits on the
     * right get a higher value so the subject (flower, lamp, cranes …) is not
     * cut off, while the paper-like left side still holds the text column. */
    const WALLPAPER_FOCUS = {
      'ink-mist': 50, celadon: 72, parchment: 50, moonlit: 72, 'watercolor-bloom': 88,
      'color-field': 50, 'oil-dusk': 55, 'silver-film': 50, 'spring-river': 58,
      'bamboo-wind': 62, 'morning-page': 60, 'sea-horizon': 66, 'lantern-night': 82,
      'starry-journey': 64, 'ancient-path': 72, 'lotus-dawn': 66, 'home-smoke': 66,
      'rain-tea': 86, 'summit-dawn': 58, 'paper-wish': 86,
    };
    /* Compose derived data once. */
    for (const family of FAMILIES) {
      family.palettes = {
        light: family.native === 'light' ? family.palette : companionPalette(family.palette, 'dark'),
        dark: family.native === 'dark' ? family.palette : companionPalette(family.palette, 'light'),
      };
      family.artByScheme = {
        light: family.native === 'light' ? family.art : autoArt(family.palettes.light, 'light'),
        dark: family.native === 'dark' ? family.art : autoArt(family.palettes.dark, 'dark'),
      };
      family.layer = {
        light: expandTokens(family.palettes.light, 'light'),
        dark: expandTokens(family.palettes.dark, 'dark'),
      };
      family.preview = [
        'linear-gradient(180deg, rgba(0, 0, 0, 0) 42%, rgba(0, 0, 0, 0.36) 100%)',
        `linear-gradient(90deg, ${rgba(family.palettes[family.native].base, 0.32)} 0%, rgba(0, 0, 0, 0) 52%)`,
        ...family.artByScheme[family.native],
      ].join(', ');
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    function familyCss(family) {
      const light = family.palettes.light;
      const dark = family.palettes.dark;
      const pan = family.motion.pan;
      const drift = family.motion.drift;
      return `
html[data-theme-studio="${family.id}"] {
  --ts-canvas: ${light.base};
  --ts-art: ${family.artByScheme.light.join(',\n    ')};
  --ts-scrim: ${scrimFor(light, 'light')};
  --ts-focus: ${WALLPAPER_FOCUS[family.id] ?? 50}%;
  --ts-glow: ${glowFor(light, 'light')};
  --ts-sheen: ${sheenFor('light')};
  --ts-sheet: ${sheetFor(light, 'light')};
  --ts-pan-dur: ${pan}s;
  --ts-drift-dur: ${drift}s;
}
html[data-theme-studio="${family.id}"] body[data-ds-dark-theme] {
  --ts-canvas: ${dark.base};
  --ts-art: ${family.artByScheme.dark.join(',\n    ')};
  --ts-scrim: ${scrimFor(dark, 'dark')};
  --ts-focus: ${WALLPAPER_FOCUS[family.id] ?? 50}%;
  --ts-glow: ${glowFor(dark, 'dark')};
  --ts-sheen: ${sheenFor('dark')};
  --ts-sheet: ${sheetFor(dark, 'dark')};
  --ts-pan-dur: ${pan + 4}s;
  --ts-drift-dur: ${drift + 2}s;
}`;
    }

    const PAGE_CSS = `
.ts-page { display: flex; flex-direction: column; gap: 18px; padding: 4px 0 28px; color: var(--dsw-alias-label-primary); }
.ts-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ts-eyebrow { font-size: 11px; line-height: 16px; letter-spacing: 0.16em; color: var(--dsw-alias-label-tertiary); text-transform: uppercase; }
.ts-title { margin: 4px 0 6px; font-size: 22px; line-height: 30px; font-weight: 600; }
.ts-sub { margin: 0; max-width: 660px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.ts-scheme { display: inline-flex; align-items: center; gap: 7px; flex: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 4px 11px; background: var(--dsw-alias-bg-layer-2); }
.ts-schemeDot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.ts-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-layer-2); backdrop-filter: blur(20px) saturate(1.3); }
.ts-switch { display: inline-flex; align-items: center; gap: 10px; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; padding: 6px 8px; border-radius: 10px; }
.ts-switch:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ts-switchTrack { position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l3); transition: background 0.16s ease, border-color 0.16s ease; }
.ts-switch[aria-checked="true"] .ts-switchTrack { background: var(--dsw-alias-brand-primary); border-color: transparent; }
.ts-switchThumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.24); transition: transform 0.16s ease; }
.ts-switch[aria-checked="true"] .ts-switchThumb { transform: translateX(14px); }
.ts-switchLabel { font-size: 13px; line-height: 20px; }
.ts-switchHint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.ts-reset { margin-left: auto; border: 0.5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; padding: 6px 12px; border-radius: 999px; cursor: pointer; }
.ts-reset:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(224px, 1fr)); gap: 14px; }
.ts-card { position: relative; display: flex; flex-direction: column; text-align: left; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 18px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; padding: 0; cursor: pointer; transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease; }
.ts-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); border-color: var(--dsw-alias-border-l3); }
.ts-card[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.ts-thumb { position: relative; display: block; aspect-ratio: 16 / 9; background-size: cover; background-position: center; }
.ts-thumbScrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0, 0, 0, 0) 46%, rgba(0, 0, 0, 0.34) 100%); }
.ts-thumbUi { position: absolute; left: 10px; right: 10px; bottom: 9px; display: flex; align-items: center; gap: 5px; }
.ts-thumbBar { display: block; height: 5px; width: 36%; border-radius: 99px; background: rgba(255, 255, 255, 0.62); }
.ts-thumbBarShort { width: 16%; background: rgba(255, 255, 255, 0.36); }
.ts-thumbChip { position: absolute; top: 8px; right: 8px; font-size: 10px; line-height: 14px; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 999px; background: rgba(8, 10, 14, 0.42); color: rgba(255, 255, 255, 0.88); backdrop-filter: blur(8px); }
.ts-cardBody { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px 12px; }
.ts-cardName { font-size: 13px; line-height: 20px; font-weight: 500; }
.ts-cardTag { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.ts-check { position: absolute; top: 8px; left: 8px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); font-size: 11px; line-height: 18px; text-align: center; }
.ts-offThumb { display: grid; place-items: center; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 20px; }
.ts-foot { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l1); font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
.ts-path { display: block; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; word-break: break-all; }
.ts-footRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ts-linkBtn { border: 0; background: transparent; padding: 0; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.ts-badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 16px; }
.ts-quick { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.ts-quickHead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ts-quickTitle { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.ts-quickHint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.ts-quickChips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
.ts-chip { flex: none; display: flex; flex-direction: column; align-items: stretch; gap: 5px; width: 92px; padding: 4px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; transition: border-color 0.16s ease, transform 0.16s ease; }
.ts-chip:hover { border-color: var(--dsw-alias-border-l3); transform: translateY(-1px); }
.ts-chip.is-active { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.ts-chipSwatch { display: block; height: 38px; border-radius: 8px; background-size: cover; background-position: center; border: 0.5px solid var(--dsw-alias-border-l1); }
.ts-chipSwatchDefault { display: grid; place-items: center; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-tertiary); font-size: 10px; letter-spacing: 0.06em; }
.ts-chipName { font-size: 11px; line-height: 15px; text-align: center; padding: 0 2px 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-headWrap { position: relative; display: inline-flex; align-items: center; }
.ts-headBtn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; transition: background .15s ease, color .15s ease, border-color .15s ease; }
.ts-headBtn:hover, .ts-headBtn[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ts-headLabel { font-size: 11px; line-height: 16px; }
.ts-fabPanel { position: fixed; box-sizing: border-box; width: 276px; max-height: min(78vh, 560px); overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); backdrop-filter: blur(28px) saturate(1.4); box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.2)); color: var(--dsw-alias-label-primary); }
.ts-fabHead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ts-fabTitle { font-size: 13px; line-height: 20px; font-weight: 500; }
.ts-fabNow { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.ts-fabModes { display: flex; gap: 6px; padding: 3px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.ts-fabMode { flex: 1; border: 0; border-radius: 8px; padding: 5px 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; }
.ts-fabMode.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l2); }
.ts-fabGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.ts-fabItem { display: flex; align-items: center; gap: 7px; padding: 5px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; text-align: left; }
.ts-fabItem:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.ts-fabItem.is-active { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.ts-fabSwatch { flex: none; width: 40px; height: 24px; border-radius: 6px; border: 0.5px solid var(--dsw-alias-border-l1); background-size: cover; background-position: center; }
.ts-fabName { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-fabHint { font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.ts-fabClarity { display: flex; align-items: center; gap: 8px; }
.ts-fabClarity > .ts-fabModes { flex: 1; }
.ts-fabClarityLabel { flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.ts-clarity { display: flex; flex-direction: column; gap: 8px; }
.ts-clarityHead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ts-clarityTitle { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.ts-clarityHint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.ts-clarityGroup { display: inline-flex; gap: 4px; padding: 3px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); align-self: flex-start; border: 0.5px solid var(--dsw-alias-border-l1); }
.ts-clarityBtn { border: 0; border-radius: 8px; padding: 5px 14px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
.ts-clarityBtn:hover { color: var(--dsw-alias-label-primary); }
.ts-clarityBtn.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l2); }
@media (max-width: 767px) { .ts-head { align-items: flex-start; } .ts-title { font-size: 19px; line-height: 27px; } }
.ts-footWrap { position: relative; display: flex; align-items: center; }
.ts-footWrap.is-wide { width: 100%; }
.ts-footBtn { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13.5px; line-height: 20px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
.ts-footWrap.is-wide .ts-footBtn { width: 100%; }
.ts-footBtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ts-footLabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-homeEntry { position: fixed; top: calc(var(--dsh-frame-overlay-top, 20px) + 2px); right: 56px; z-index: 900; display: flex; align-items: center; pointer-events: auto; }
/* Plugin-owned floating switch: present in every state, and hidden only where a
 * better seat already exists (session header switch / new-session Hero chip). */
.ts-fabRoot { position: fixed; top: calc(var(--dsh-frame-overlay-top, 20px) + 46px); right: 56px; z-index: 901; display: flex; align-items: center; pointer-events: auto; }
html[data-theme-studio] body:has(.ts-headWrap.is-header) .ts-fabRoot { display: none; }
/* Settings / plugins pages and any modal overlay have their own header actions
 * in the top-right corner; the floating switch would sit on top of them. */
html[data-theme-studio] body:has([data-shortcut-modal="settings"]) .ts-fabRoot,
html[data-theme-studio] body:has([role="presentation"] > [role="dialog"][aria-modal="true"]) .ts-fabRoot { display: none; }
/* Outside a conversation/home surface there is no theme context to switch. */
html[data-theme-studio] body:not(:has([data-conversation-header-leading], [data-conversation-root], [data-conversation-composer-overlay], [data-slot="conversation.session"], [class*="heroWorkspaceRow"], [class*="heroOptions"])) .ts-fabRoot { display: none; }
.ts-fabBtn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
.ts-fabBtn:hover, .ts-fabBtn[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ts-fabBtnLabel { white-space: nowrap; }
.ts-fabPanel2 { position: absolute; top: 36px; right: 0; box-sizing: border-box; width: 276px; max-height: min(78vh, 560px); overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); backdrop-filter: blur(28px) saturate(1.4); box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.2)); color: var(--dsw-alias-label-primary); }
.ts-fabPanel2[hidden] { display: none; }
.ts-fabMore { font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); border-top: 0.5px solid var(--dsw-alias-border-l1); padding-top: 8px; }
`;

    function buildCss() {
      return `
html[data-theme-studio] { background-color: #0b0d10; }
/* Scheme-level fallback for the sheet fill, in case a family block has not
 * applied yet: a missing var() would leave dialogs fully transparent. */
html[data-theme-studio] { --ts-sheet: #f8f6f2; }
html[data-theme-studio] body[data-ds-dark-theme] { --ts-sheet: #16171b; }
/* Background clarity: one number scales every scrim / glow / sheen alpha.
 * 'standard' is the default (clearer than the original veil); 'soft' restores
 * the old look, 'clear' lets the artwork read almost unfiltered. Lower alpha =
 * more wallpaper detail, less text contrast reserve. */
html[data-theme-studio] { --ts-veil: 0.22; }
html[data-theme-studio] body[data-ds-dark-theme] { --ts-veil: 0.26; }
html[data-theme-studio][data-theme-clarity="soft"] { --ts-veil: 0.34; }
html[data-theme-studio][data-theme-clarity="soft"] body[data-ds-dark-theme] { --ts-veil: 0.38; }
html[data-theme-studio][data-theme-clarity="clear"] { --ts-veil: 0.10; }
html[data-theme-studio][data-theme-clarity="clear"] body[data-ds-dark-theme] { --ts-veil: 0.14; }
/* Clear mode is a promise: keep the artwork itself crisp.
 * - no zoom/scale animation (the 1.05–1.12 upscale resamples the wallpaper)
 * - the living-light glow layer is nearly removed (it veils detail)
 * - a small unsharp pass restores the high-frequency edges that a lifted
 *   dark companion image (or a soft watercolour source) lacks.
 */
html[data-theme-studio][data-theme-clarity="clear"] body::before {
  filter: saturate(1.14) contrast(1.09) url(#ts-clarity-sharpen);\n  image-rendering: -webkit-optimize-contrast;
  transform: translate3d(0, 0, 0);
  animation: none;
  /* No compositor layer promotion: an animated/upscaled fixed layer can be
   * rasterised at a lower resolution on hi-dpi displays, which reads as blur. */
  will-change: auto;
  backface-visibility: visible;
}
html[data-theme-studio][data-theme-clarity="clear"] body::after { opacity: 0.16; }
html[data-theme-studio][data-theme-clarity="clear"] body[data-ds-dark-theme]::after { opacity: 0.1; }
html[data-theme-studio] body { background-color: var(--ts-canvas) !important; background-image: none !important; }
html[data-theme-studio] #root { position: relative; z-index: 1; }
html[data-theme-studio] body::before,
html[data-theme-studio] body::after {
  content: "";
  position: fixed;
  inset: -5%;
  z-index: 0;
  pointer-events: none;
  backface-visibility: hidden;
}
html[data-theme-studio] body::before {
  background-image: var(--ts-scrim), var(--ts-art-current, var(--ts-art));
  background-size: cover;
  background-position: var(--ts-focus, 50%) center;
  background-repeat: no-repeat;
  /* A whisper of local contrast keeps the artwork from reading as flat haze
   * once the scrim is thinned; the layer is static apart from the GPU pan. */
  filter: saturate(1.12) contrast(1.08);
  transform: translate3d(-1.2%, 0.8%, 0) scale(1.05);
  animation: ts-pan var(--ts-pan-dur, 36s) ease-in-out infinite alternate;
  will-change: transform;
}
html[data-theme-studio] body::after {
  background-image: var(--ts-glow), var(--ts-sheen);
  background-size: 150% 150%, 200% 200%;
  background-position: 60% 40%, 0 0;
  background-repeat: no-repeat, no-repeat;
  opacity: 0.4;
  mix-blend-mode: normal;
  transform: translate3d(-1.8%, 1.2%, 0) scale(1.08);
  animation: ts-drift var(--ts-drift-dur, 44s) ease-in-out infinite alternate;
  will-change: transform;
}
html[data-theme-studio] body[data-ds-dark-theme]::after { opacity: 0.28; }
@keyframes ts-pan {
  from { transform: translate3d(-1.2%, 0.8%, 0) scale(1.05); }
  to { transform: translate3d(1.2%, -0.8%, 0) scale(1.09); }
}
@keyframes ts-drift {
  from { transform: translate3d(-1.8%, 1.2%, 0) scale(1.08); }
  to { transform: translate3d(1.8%, -1.2%, 0) scale(1.12); }
}
@media (prefers-reduced-motion: reduce) {
  html[data-theme-studio] body::before,
  html[data-theme-studio] body::after { animation: none !important; }
}
html[data-theme-studio][data-theme-motion="off"] body::before,
html[data-theme-studio][data-theme-motion="off"] body::after { animation: none !important; }
html[data-theme-studio][data-theme-wallpaper="off"] body::before {
  background-image: var(--ts-scrim), var(--ts-art) !important;
}
/* Modal sheets ------------------------------------------------------------
 * The host paints its dialog panels with --dsw-alias-bg-layer-2, a raised
 * surface this theme keeps translucent so in-page cards reveal the wallpaper.
 * Inside a modal that same token lets the conversation behind ghost through
 * the panel, so sheets take an almost-opaque paper fill of their own.
 *
 * The selector is structural on purpose: the host's Modal and the settings
 * shell both portal a role=presentation positioning root whose children are
 * the mask and the dialog itself. That catches exactly those sheets while
 * leaving alone the image lightbox (its root is itself the aria-modal dialog,
 * with no background), the narrow-window sidebar drawer, and the anchored
 * role="dialog" popovers that stay glassy by design. The settings shell id is
 * repeated so a future shell rewrite keeps the fix. */
html[data-theme-studio] [role="presentation"] > [role="dialog"][aria-modal="true"],
html[data-theme-studio] [data-shortcut-modal="settings"],
html[data-theme-studio] [data-shortcut-modal="shortcuts"] {
  /* Only the fill: dialogs that paint their own background image keep it. */
  background-color: var(--ts-sheet) !important;
}
/* Windows window controls --------------------------------------------------
 * The Desktop shell paints the native Window Controls Overlay from a hidden
 * probe that resolves --dsw-specific-sidebar-fill and reports it over the
 * windowsAppearance IPC (lib/preload-app.cjs). This theme keeps that fill
 * translucent, so the overlay lays a pale veil over the themed titlebar and the
 * minimise/maximise/close block reads as a lighter rectangle. Scoping the token
 * on the probe itself makes the overlay transparent, so the themed titlebar
 * shows through unchanged while the buttons keep their themed glyph colour.
 * The probe carries the token name in its inline style; if the host ever stops
 * doing that, this rule simply stops matching and nothing regresses. */
html[data-theme-studio] body > span[style*="--dsw-specific-sidebar-fill"] {
  --dsw-specific-sidebar-fill: transparent !important;
}
${FAMILIES.map(familyCss).join('\n')}
${PAGE_CSS}`;
    }

    /* ------------------------------------------------------------------ *
     * Locale dictionaries
     * ------------------------------------------------------------------ */

    const DICT = {
      zh: {
        nav: '主题工作室',
        quickTitle: '主题',
        quickHint: '20 套原创主题 · 点击即切换，更多设置在「主题工作室」',
        fab: '切换主题',
        panelTitle: '主题',
        modeFixed: '固定',
        modeRotate: '轮播',
        fixedHint: '固定模式：只有你手动选择时才会切换',
        rotateHint: '轮播模式：每 2 天自动切换到下一套（手动选择会重新计时）',
        clarity: '背景清晰度',
        clarityHint: '越高越能看清壁纸纹理，文字对比度会相应降低；浅色外观默认「标准」',
        claritySoft: '淡雅',
        clarityStandard: '标准',
        clarityClear: '清晰',
        panelMoreHint: '完整设置：左下角头像 → 设置 → 主题工作室',
        title: '主题工作室',
        subtitle: '二十套原创主题：水墨远山、宋瓷天青、羊皮手稿、月白幽蓝、水彩花影、色域抒情、暮色油画、银盐光影，以及第二批的春江水暖、竹影清风、晨光书页、海阔天空、灯下夜读、星河长夜、古道远行、荷塘晨露、炊烟归处、雨窗煮茶、云海日出、纸鹤寄愿。自动适配浅色 / 深色外观；壁纸层缓慢推拉、光晕呼吸，只动 GPU 合成层，顺滑不卡顿。',
        motion: '动态壁纸',
        motionHint: '缓慢平移与光晕呼吸（尊重系统的减少动态效果设置）',
        wallpaper: '壁纸图层',
        wallpaperHint: '关闭后仅保留主题的渐变艺术层',
        reset: '恢复默认外观',
        offTitle: '默认外观',
        offTag: 'DeepSeek 原生配色',
        nativeLight: '浅色',
        nativeDark: '深色',
        on: '开',
        off: '关',
        schemeLight: '当前：浅色',
        schemeDark: '当前：深色',
        wallpaperFound: '已检测到 {n} 张壁纸',
        wallpaperNone: '尚未放入壁纸，正在使用内置渐变艺术',
        pathTitle: '壁纸目录',
        pathHint: '把 GPT 生成的图片命名为 <主题 id>.jpg（或 .png / .webp）放入该目录，刷新后即可生效。',
        refresh: '重新检测',
        footerNote: '主题只覆盖颜色与材质令牌，不改动任何功能；关闭本页或恢复默认即可回到原生外观。',
      },
      en: {
        nav: 'Theme Studio',
        quickTitle: 'Theme',
        quickHint: '20 original themes — click to switch; more in Theme Studio',
        fab: 'Switch theme',
        panelTitle: 'Theme',
        modeFixed: 'Fixed',
        modeRotate: 'Rotate',
        fixedHint: 'Fixed: only changes when you pick a theme',
        rotateHint: 'Rotate: advances every 2 days (picking a theme restarts the timer)',
        clarity: 'Background clarity',
        clarityHint: 'Higher reveals more wallpaper texture; text contrast drops a little. Light appearance defaults to Standard',
        claritySoft: 'Soft',
        clarityStandard: 'Standard',
        clarityClear: 'Clear',
        panelMoreHint: 'Full settings: bottom-left avatar → Settings → Theme Studio',
        title: 'Theme Studio',
        subtitle: 'Twenty original themes: Ink Mist, Celadon, Parchment, Moonlit, Watercolor Bloom, Color Field, Oil Dusk, Silver Film, plus a second batch — Spring River, Bamboo Wind, Morning Page, Sea Horizon, Lantern Night, Starry Journey, Ancient Path, Lotus Dawn, Home Smoke, Rain Tea, Summit Dawn and Paper Wish. They follow light / dark automatically; the wallpaper layer drifts and breathes on the GPU compositor only, so it stays smooth.',
        motion: 'Animated wallpaper',
        motionHint: 'Slow pan and glow breathing (respects reduced-motion)',
        wallpaper: 'Wallpaper layer',
        wallpaperHint: 'Turn off to keep only the generated gradient art',
        reset: 'Restore default look',
        offTitle: 'Default look',
        offTag: 'Native DeepSeek palette',
        nativeLight: 'Light',
        nativeDark: 'Dark',
        on: 'On',
        off: 'Off',
        schemeLight: 'Now: light',
        schemeDark: 'Now: dark',
        wallpaperFound: '{n} wallpaper(s) detected',
        wallpaperNone: 'No wallpaper yet — using the built-in gradient art',
        pathTitle: 'Wallpaper folder',
        pathHint: 'Name GPT output <theme-id>.jpg (or .png / .webp), drop it in this folder, then refresh.',
        refresh: 'Rescan',
        footerNote: 'Themes only override color and material tokens; every feature stays untouched. Restore the default look to go back.',
      },
    };

    /* ------------------------------------------------------------------ *
     * Shared UI state (one plugin instance per page)
     * ------------------------------------------------------------------ */

    let UI = null;

    function useStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(UI.subscribe, UI.getSnapshot);
      }
      const [, force] = React.useState(0);
      React.useEffect(() => UI.subscribe(() => force((value) => value + 1)), []);
      return UI.getSnapshot();
    }

    function Toggle(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ts-switch',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          onClick: props.onChange,
        },
        h('span', { className: 'ts-switchTrack', 'aria-hidden': 'true' }, h('span', { className: 'ts-switchThumb' })),
        h('span', null, h('span', { className: 'ts-switchLabel', style: { display: 'block' } }, props.label), h('span', { className: 'ts-switchHint' }, props.hint)),
      );
    }

    function ThemeCard(props) {
      const { family, active, t } = props;
      return h(
        'button',
        {
          type: 'button',
          className: 'ts-card',
          'aria-pressed': active ? 'true' : 'false',
          title: family.name.zh + ' / ' + family.name.en,
          onClick: () => UI.actions.applyFamily(family.id),
        },
        h(
          'span',
          { className: 'ts-thumb', style: { backgroundImage: family.preview } },
          h('span', { className: 'ts-thumbScrim' }),
          h('span', { className: 'ts-thumbChip' }, family.native === 'dark' ? t('nativeDark') : t('nativeLight')),
          h('span', { className: 'ts-thumbUi' }, h('span', { className: 'ts-thumbBar' }), h('span', { className: 'ts-thumbBar ts-thumbBarShort' })),
        ),
        h(
          'span',
          { className: 'ts-cardBody' },
          h('span', { className: 'ts-cardName' }, UI.name(family)),
          h('span', { className: 'ts-cardTag' }, UI.tag(family)),
        ),
        active ? h('span', { className: 'ts-check', 'aria-hidden': 'true' }, '✓') : null,
      );
    }

    function DefaultCard(props) {
      const { active, t } = props;
      return h(
        'button',
        {
          type: 'button',
          className: 'ts-card',
          'aria-pressed': active ? 'true' : 'false',
          onClick: () => UI.actions.applyFamily('off'),
        },
        h(
          'span',
          { className: 'ts-thumb ts-offThumb' },
          h('span', { className: 'ts-thumbScrim' }),
          h('span', { className: 'ts-thumbChip' }, 'DSH'),
          h('span', { className: 'ts-thumbUi' }, h('span', { className: 'ts-thumbBar' }), h('span', { className: 'ts-thumbBar ts-thumbBarShort' })),
        ),
        h(
          'span',
          { className: 'ts-cardBody' },
          h('span', { className: 'ts-cardName' }, t('offTitle')),
          h('span', { className: 'ts-cardTag' }, t('offTag')),
        ),
        active ? h('span', { className: 'ts-check', 'aria-hidden': 'true' }, '✓') : null,
      );
    }

    /**
     * Compact gallery row inside Settings → General, so the eight themes are
     * visible at a glance instead of only through the dedicated section.
     */
    function QuickThemeRow() {
      const state = useStore();
      const t = (key) => UI.t(key);
      return h(
        'div',
        { className: 'ts-quick' },
        h(
          'div',
          { className: 'ts-quickHead' },
          h('span', { className: 'ts-quickTitle' }, t('quickTitle')),
          h('span', { className: 'ts-quickHint' }, t('quickHint')),
        ),
        h(
          'div',
          { className: 'ts-quickChips' },
          state.families.map((family) =>
            h(
              'button',
              {
                key: family.id,
                type: 'button',
                className: 'ts-chip' + (state.family === family.id ? ' is-active' : ''),
                'aria-pressed': state.family === family.id ? 'true' : 'false',
                title: family.name.zh + ' / ' + family.name.en,
                onClick: () => UI.actions.applyFamily(family.id),
              },
              h('span', { className: 'ts-chipSwatch', style: { backgroundImage: family.preview } }),
              h('span', { className: 'ts-chipName' }, UI.name(family)),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ts-chip ts-chipDefault' + (state.family === 'off' ? ' is-active' : ''),
              'aria-pressed': state.family === 'off' ? 'true' : 'false',
              onClick: () => UI.actions.applyFamily('off'),
            },
            h('span', { className: 'ts-chipSwatch ts-chipSwatchDefault', 'aria-hidden': 'true' }, 'DSH'),
            h('span', { className: 'ts-chipName' }, t('offTitle')),
          ),
        ),
      );
    }

    /** Background-clarity levels, softest first. Shared by panel and page. */
    const CLARITY_LEVELS = ['soft', 'standard', 'clear'];

    /**
     * The theme popover body, shared by the Session-header button and the
     * sidebar-foot action. Position is supplied by the caller so the same panel
     * can hang under the header control or above the sidebar foot.
     */
    function ThemePanel(props) {
      const { anchorStyle, state, current, t, onEnter, onLeave } = props;
      return h(
        'div',
        {
          className: 'ts-fabPanel',
          role: 'dialog',
          'aria-label': t('panelTitle'),
          style: Object.assign({ position: 'fixed', zIndex: 950 }, anchorStyle),
          onMouseEnter: onEnter,
          onMouseLeave: onLeave,
        },
        h(
          'div',
          { className: 'ts-fabHead' },
          h('span', { className: 'ts-fabTitle' }, t('panelTitle')),
          h('span', { className: 'ts-fabNow' }, current ? UI.name(current) : ''),
        ),
        h(
          'div',
          { className: 'ts-fabModes' },
          h(
            'button',
            { type: 'button', className: 'ts-fabMode' + (state.mode === 'fixed' ? ' is-active' : ''), onClick: () => UI.actions.setMode('fixed') },
            t('modeFixed'),
          ),
          h(
            'button',
            { type: 'button', className: 'ts-fabMode' + (state.mode === 'rotate' ? ' is-active' : ''), onClick: () => UI.actions.setMode('rotate') },
            t('modeRotate'),
          ),
        ),
        h(
          'div',
          { className: 'ts-fabClarity' },
          h('span', { className: 'ts-fabClarityLabel' }, t('clarity')),
          h(
            'div',
            { className: 'ts-fabModes' },
            ...CLARITY_LEVELS.map((level) =>
              h(
                'button',
                {
                  key: level,
                  type: 'button',
                  className: 'ts-fabMode' + (state.clarity === level ? ' is-active' : ''),
                  title: t('clarityHint'),
                  onClick: () => UI.actions.setClarity(level),
                },
                t('clarity' + level.charAt(0).toUpperCase() + level.slice(1)),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ts-fabGrid' },
          state.families.map((family) =>
            h(
              'button',
              {
                key: family.id,
                type: 'button',
                className: 'ts-fabItem' + (state.family === family.id ? ' is-active' : ''),
                title: family.name.zh + ' / ' + family.name.en,
                onClick: () => UI.actions.applyFamily(family.id),
              },
              h('span', { className: 'ts-fabSwatch', style: { backgroundImage: family.preview } }),
              h('span', { className: 'ts-fabName' }, UI.name(family)),
            ),
          ),
        ),
        h('div', { className: 'ts-fabHint' }, state.mode === 'rotate' ? t('rotateHint') : t('fixedHint')),
        h('div', { className: 'ts-fabMore' }, t('panelMoreHint')),
      );
    }

    /** Session-header theme button, placed left of the open-in-app control. */
    function ThemeSwitcher(props) {
      const state = useStore();
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);
      const t = (key) => UI.t(key);
      const current = state.families.find((family) => family.id === state.family);
      const variant = props && props.variant;
      const wrapClass = 'ts-headWrap' + (variant === 'header' ? ' is-header' : '');
      // Hovering between the trigger and the popover crosses a few pixels that
      // belong to neither box; without a grace period that gap reads as "left
      // the control" and the panel closes before the pointer arrives.
      const [hideTimer, setHideTimer] = React.useState(() => ({ id: null }));
      const cancelHide = () => {
        if (hideTimer.id !== null) {
          window.clearTimeout(hideTimer.id);
          hideTimer.id = null;
        }
      };
      const scheduleHide = () => {
        cancelHide();
        hideTimer.id = window.setTimeout(() => {
          hideTimer.id = null;
          setOpen(false);
        }, 350);
      };
      React.useEffect(() => () => cancelHide(), []);
      const show = (event) => {
        cancelHide();
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor({ top: Math.round(rect.bottom + 6) + 'px', right: Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px', left: 'auto', bottom: 'auto' });
        setOpen(true);
      };
      const hide = () => {
        cancelHide();
        setOpen(false);
      };
      return h(
        'div',
        { className: wrapClass, onMouseEnter: cancelHide, onMouseLeave: scheduleHide },
        h(
          'button',
          {
            type: 'button',
            className: 'ts-headBtn',
            'aria-label': t('fab'),
            'aria-expanded': open ? 'true' : 'false',
            title: t('fab') + (current ? ' · ' + UI.name(current) : ''),
            onMouseEnter: show,
            onFocus: show,
            onClick: (event) => (open ? hide() : show(event)),
          },
          h(PaletteIcon),
          h('span', { className: 'ts-headLabel' }, t('panelTitle')),
        ),
        open && anchor && anchor.top !== undefined
          ? h(ThemePanel, {
              anchorStyle: { top: anchor.top, right: anchor.right, left: anchor.left, bottom: anchor.bottom },
              state,
              current,
              t,
              onEnter: () => {
                cancelHide();
                setOpen(true);
              },
              onLeave: scheduleHide,
            })
          : null,
      );
    }

    /**
     * Sidebar-foot theme action.
     *
     * The Session-header switch only exists while a Session header is mounted,
     * so the blank-session home (new session Hero) had no way to change the
     * theme. This seat sits beside Settings at the sidebar foot, which is
     * mounted for every main-panel state, and reuses the same popover.
     */
    function SidebarThemeAction(props) {
      const state = useStore();
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);
      const t = (key) => UI.t(key);
      const current = state.families.find((family) => family.id === state.family);
      const wide = Boolean(props && props.wide);
      // Same hover grace as the header switch: the gap between the row and the
      // popover must not count as leaving the control.
      const [hideTimer, setHideTimer] = React.useState(() => ({ id: null }));
      const cancelHide = () => {
        if (hideTimer.id !== null) {
          window.clearTimeout(hideTimer.id);
          hideTimer.id = null;
        }
      };
      const scheduleHide = () => {
        cancelHide();
        hideTimer.id = window.setTimeout(() => {
          hideTimer.id = null;
          setOpen(false);
        }, 350);
      };
      React.useEffect(() => () => cancelHide(), []);
      const show = (event) => {
        cancelHide();
        const rect = event.currentTarget.getBoundingClientRect();
        // Reset the panel's class-level top/right defaults: a fixed box with
        // both top and bottom set stretches to the viewport edge instead of
        // hanging above the button.
        setAnchor({
          left: Math.max(8, Math.round(rect.left)) + 'px',
          bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8)) + 'px',
          top: 'auto',
          right: 'auto',
        });
        setOpen(true);
      };
      const hide = () => {
        cancelHide();
        setOpen(false);
      };
      return h(
        'div',
        { className: 'ts-footWrap' + (wide ? ' is-wide' : ''), onMouseEnter: cancelHide, onMouseLeave: scheduleHide },
        h(
          'button',
          {
            type: 'button',
            className: 'ts-footBtn',
            'aria-label': t('fab'),
            'aria-expanded': open ? 'true' : 'false',
            title: t('fab') + (current ? ' · ' + UI.name(current) : ''),
            onMouseEnter: show,
            onFocus: show,
            onClick: (event) => (open ? hide() : show(event)),
          },
          h(PaletteIcon),
          wide ? h('span', { className: 'ts-footLabel' }, t('panelTitle')) : null,
        ),
        open && anchor && anchor.bottom !== undefined
          ? h(ThemePanel, {
              anchorStyle: { left: anchor.left, bottom: anchor.bottom, top: anchor.top, right: anchor.right },
              state,
              current,
              t,
              onEnter: () => {
                cancelHide();
                setOpen(true);
              },
              onLeave: scheduleHide,
            })
          : null,
      );
    }

    /** Session-header switch variant: marked so CSS can hide the fallback pill. */
    function HeaderThemeSwitch() {
      return h(ThemeSwitcher, { variant: 'header' });
    }

    /** A paint-palette glyph: reads as "theme / colour" rather than "more". */
    function PaletteIcon() {      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block', flex: 'none' } },
        h('path', {
          d: 'M8 2.2c3.2 0 5.8 2.3 5.8 5.2 0 1.4-.9 2.4-2.2 2.4h-1.1c-.7 0-1.2.5-1.2 1.1 0 .3.1.5.3.8.2.2.3.5.3.8 0 .7-.6 1.2-1.4 1.2C5.1 13.7 2.2 11.2 2.2 8c0-3.2 2.6-5.8 5.8-5.8z',
          stroke: 'currentColor',
          strokeWidth: '1.1',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 5.2, cy: 7.2, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 7.4, cy: 5.4, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 9.7, cy: 6.2, r: 0.9, fill: 'currentColor' }),
      );
    }

    function ThemeStudioPage() {      const state = useStore();
      const t = (key) => UI.t(key);
      const families = state.families;
      const count = state.wallpaperCount;
      return h(
        'div',
        { className: 'ts-page' },
        h(
          'div',
          { className: 'ts-head' },
          h(
            'div',
            null,
            h('div', { className: 'ts-eyebrow' }, 'Theme Studio'),
            h('h1', { className: 'ts-title' }, t('title')),
            h('p', { className: 'ts-sub' }, t('subtitle')),
          ),
          h(
            'span',
            { className: 'ts-scheme' },
            h('span', { className: 'ts-schemeDot' }),
            state.scheme === 'dark' ? t('schemeDark') : t('schemeLight'),
          ),
        ),
        h(
          'div',
          { className: 'ts-toolbar' },
          h(Toggle, { checked: state.motion, label: t('motion'), hint: t('motionHint'), onChange: () => UI.actions.setMotion(!state.motion) }),
          h(Toggle, { checked: state.wallpaper, label: t('wallpaper'), hint: t('wallpaperHint'), onChange: () => UI.actions.setWallpaper(!state.wallpaper) }),
          h('button', { type: 'button', className: 'ts-reset', onClick: () => UI.actions.applyFamily('off') }, t('reset')),
        ),
        h(
          'div',
          { className: 'ts-clarity' },
          h(
            'div',
            { className: 'ts-clarityHead' },
            h('span', { className: 'ts-clarityTitle' }, t('clarity')),
            h('span', { className: 'ts-clarityHint' }, t('clarityHint')),
          ),
          h(
            'div',
            { className: 'ts-clarityGroup', role: 'group', 'aria-label': t('clarity') },
            ...CLARITY_LEVELS.map((level) =>
              h(
                'button',
                {
                  key: level,
                  type: 'button',
                  className: 'ts-clarityBtn' + (state.clarity === level ? ' is-active' : ''),
                  'aria-pressed': state.clarity === level ? 'true' : 'false',
                  onClick: () => UI.actions.setClarity(level),
                },
                t('clarity' + level.charAt(0).toUpperCase() + level.slice(1)),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ts-grid' },
          families.map((family) => h(ThemeCard, { key: family.id, family, active: state.family === family.id, t })),
          h(DefaultCard, { key: 'off', active: state.family === 'off', t }),
        ),
        h(
          'div',
          { className: 'ts-foot' },
          h(
            'div',
            { className: 'ts-footRow' },
            h('span', { className: 'ts-badge' }, count > 0 ? t('wallpaperFound').replace('{n}', String(count)) : t('wallpaperNone')),
            state.manifest && state.manifest.directory ? h('button', { type: 'button', className: 'ts-linkBtn', onClick: () => UI.actions.refreshWallpapers() }, t('refresh')) : null,
          ),
          state.manifest && state.manifest.directory ? h('span', { className: 'ts-path' }, state.manifest.directory) : null,
          h('div', null, t('pathHint')),
          h('div', null, t('footerNote')),
        ),
      );
    }

    function NavIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M2.5 4.2c1.6-1.5 3.9-1.7 5.6-.5 1.7 1.2 2 3.4 1 5.1-.9 1.6-2.9 2.1-4.5 1.2S2 7.2 2.5 5.8',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M8.3 2.8c2-.6 4.2.4 5 2.3.8 1.9.1 4.1-1.6 5.1-1.6 1-3.7.6-4.8-1',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
          opacity: '0.65',
        }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    function activate(ctx, trace) {
      trace.step = 'setup';
      const theme = ctx.theme;
      const locale = ctx.get('locale');

      const root = document.documentElement;
      const listeners = new Set();
      let layerDispose = null;
      let cachedSnapshot = null;
      let manifest = null;
      let wallpaperMap = {};
      let diagTimer = null;
      let diagSent = false;
      const timers = new Set();
      const intervals = new Set();
      const later = (callback, delay) => {
        const id = window.setTimeout(() => {
          timers.delete(id);
          callback();
        }, delay);
        timers.add(id);
        return id;
      };
      const every = (callback, delay) => {
        const id = window.setInterval(callback, delay);
        intervals.add(id);
        return id;
      };
      const clearTimers = () => {
        for (const id of timers) window.clearTimeout(id);
        timers.clear();
        for (const id of intervals) window.clearInterval(id);
        intervals.clear();
        if (diagTimer !== null) window.clearTimeout(diagTimer);
        diagTimer = null;
        if (probeTimer !== null) window.clearInterval(probeTimer);
        probeTimer = null;
      };

      const state = {
        family: 'ink-mist',
        motion: true,
        wallpaper: true,
        mode: 'fixed',
        clarity: 'standard',
        rotateDays: 2,
        lastRotation: 0,
      };

      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && typeof saved === 'object') {
          // `chosen` marks a real user selection. Older/unset values keep the
          // curated first-run theme instead of freezing the plugin at "off".
          if (saved.chosen === true && typeof saved.family === 'string' && (saved.family === 'off' || FAMILIES.some((f) => f.id === saved.family))) {
            state.family = saved.family;
          }
          if (typeof saved.motion === 'boolean') state.motion = saved.motion;
          if (typeof saved.wallpaper === 'boolean') state.wallpaper = saved.wallpaper;
          if (saved.clarity === 'soft' || saved.clarity === 'standard' || saved.clarity === 'clear') state.clarity = saved.clarity;
          if (saved.mode === 'rotate' || saved.mode === 'fixed') state.mode = saved.mode;
          if (Number.isFinite(saved.lastRotation)) state.lastRotation = saved.lastRotation;
        }
      } catch {
        /* private mode / corrupt value: defaults are fine */
      }

      const persist = () => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, chosen: true }));
        } catch {
          /* ignore */
        }
      };

      const invalidate = () => {
        cachedSnapshot = null;
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[theme-studio] subscriber failed', error);
          }
        }
      };

      const localeId = () => {
        try {
          if (locale && typeof locale.getSnapshot === 'function') return String(locale.getSnapshot().active || 'en');
        } catch {
          /* ignore */
        }
        return 'en';
      };

      const texts = () => (String(localeId()).toLowerCase().startsWith('zh') ? DICT.zh : DICT.en);

      const UI_API = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        t(key) {
          return texts()[key] || DICT.en[key] || key;
        },
        name(family) {
          return String(localeId()).toLowerCase().startsWith('zh') ? family.name.zh : family.name.en;
        },
        tag(family) {
          return String(localeId()).toLowerCase().startsWith('zh') ? family.tag.zh : family.tag.en;
        },
        getSnapshot() {
          if (cachedSnapshot !== null) return cachedSnapshot;
          let scheme = 'light';
          try {
            scheme = theme.getTheme().active.colorScheme;
          } catch {
            /* ignore */
          }
          cachedSnapshot = {
            family: state.family,
            motion: state.motion,
            wallpaper: state.wallpaper,
            mode: state.mode,
            clarity: state.clarity,
            rotateDays: state.rotateDays,
            scheme,
            families: FAMILIES,
            wallpaperCount: Object.keys(wallpaperMap).filter((key) => !/-(dark|light)$/.test(key)).length,
            manifest,
            locale: localeId(),
          };
          return cachedSnapshot;
        },
      };

      const schemeNow = () => {
        try {
          return theme.getTheme().active.colorScheme;
        } catch {
          return 'light';
        }
      };

      const syncArt = (family) => {
        const dark = schemeNow() === 'dark';
        const variant = wallpaperMap[family.id + (dark ? '-dark' : '-light')];
        const wallpaper = variant || wallpaperMap[family.id];
        if (wallpaper) {
          root.style.setProperty('--ts-art-current', `url("${wallpaper.url}?v=${wallpaper.mtimeMs}")`);
        } else {
          root.style.removeProperty('--ts-art-current');
        }
      };

      /**
       * Stack the family's alias tokens, with the window-canvas wash scaled by
       * the clarity level: softer clarity keeps more paper over the wallpaper,
       * clearer lets the artwork through the main column too.
       */
      const installLayer = (family) => {
        const factor = state.clarity === 'clear' ? 0.1 : state.clarity === 'soft' ? 0.5 : 0.28;
        const overrides = {};
        // `overrideTokens` wants token-name -> { light, dark }, not the two
        // scheme maps side by side. Cross the per-scheme token maps here.
        for (const [name, value] of Object.entries(family.layer.light)) {
          const darkValue = family.layer.dark[name] ?? value;
          if (name === '--dsw-alias-bg-base' || name === '--dsw-specific-sidebar-fill') {
            overrides[name] = { light: scaleAlpha(value, factor), dark: scaleAlpha(darkValue, factor) };
          } else {
            overrides[name] = { light: value, dark: darkValue };
          }
        }
        layerDispose = theme.overrideTokens(SOURCE, overrides);
      };

      const applyFamily = (id, options = {}) => {
        if (id !== 'off' && !FAMILIES.some((family) => family.id === id)) return;
        if (layerDispose !== null) {
          layerDispose();
          layerDispose = null;
        }
        state.family = id;
        if (!options.auto && state.mode === 'rotate') state.lastRotation = Date.now();
        if (id === 'off') {
          root.removeAttribute('data-theme-studio');
          root.removeAttribute('data-theme-motion');
          root.removeAttribute('data-theme-wallpaper');
          root.removeAttribute('data-theme-clarity');
          root.style.removeProperty('--ts-art-current');
        } else {
          const family = FAMILIES.find((item) => item.id === id);
          installLayer(family);
          root.setAttribute('data-theme-studio', id);
          root.setAttribute('data-theme-motion', state.motion ? 'on' : 'off');
          root.setAttribute('data-theme-wallpaper', state.wallpaper ? 'on' : 'off');
          root.setAttribute('data-theme-clarity', state.clarity);
          syncArt(family);
        }
        persist();
        invalidate();
      };

      const setMotion = (on) => {
        state.motion = Boolean(on);
        if (state.family !== 'off') root.setAttribute('data-theme-motion', state.motion ? 'on' : 'off');
        persist();
        invalidate();
      };

      const setWallpaper = (on) => {
        state.wallpaper = Boolean(on);
        if (state.family !== 'off') root.setAttribute('data-theme-wallpaper', state.wallpaper ? 'on' : 'off');
        persist();
        invalidate();
      };

      /** Background clarity: affects every scrim/glow alpha through --ts-veil. */
      const setClarity = (level) => {
        if (level !== 'soft' && level !== 'standard' && level !== 'clear') return;
        state.clarity = level;
        if (state.family !== 'off') {
          root.setAttribute('data-theme-clarity', level);
          const family = FAMILIES.find((item) => item.id === state.family);
          if (family) {
            // The canvas wash is a token, not a CSS var: restack the layer so
            // the main column reveals as much wallpaper as the level asks for.
            if (layerDispose !== null) {
              layerDispose();
              layerDispose = null;
            }
            installLayer(family);
          }
        }
        persist();
        invalidate();
      };

      const nextFamilyId = () => {
        const index = FAMILIES.findIndex((family) => family.id === state.family);
        return FAMILIES[(index + 1 + FAMILIES.length) % FAMILIES.length].id;
      };

      /** Advance to the next theme once the two-day rotation interval elapsed. */
      const maybeRotate = () => {
        if (state.mode !== 'rotate') return;
        if (!state.lastRotation) {
          state.lastRotation = Date.now();
          persist();
          return;
        }
        if (Date.now() - state.lastRotation < state.rotateDays * 24 * 60 * 60 * 1000) return;
        applyFamily(nextFamilyId(), { auto: true });
        state.lastRotation = Date.now();
        persist();
        invalidate();
      };

      const setMode = (mode) => {
        state.mode = mode === 'rotate' ? 'rotate' : 'fixed';
        state.lastRotation = state.mode === 'rotate' ? Date.now() : 0;
        if (state.mode === 'rotate') maybeRotate();
        persist();
        invalidate();
      };

      const applyManifest = (document) => {
        manifest = document;
        wallpaperMap = {};
        for (const wallpaper of document && Array.isArray(document.wallpapers) ? document.wallpapers : []) {
          if (wallpaper && typeof wallpaper.theme === 'string' && typeof wallpaper.url === 'string') wallpaperMap[wallpaper.theme] = wallpaper;
        }
        const family = FAMILIES.find((item) => item.id === state.family);
        if (family) syncArt(family);
        invalidate();
        scheduleDiagnostics();
        startProbe();
      };

      const fetchManifest = async (attempt = 0) => {
        try {
          const response = await fetch(`${ROUTE}/manifest.json`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
          applyManifest(await response.json());
        } catch (error) {
          if (attempt === 0) {
            later(() => {
              void fetchManifest(1);
            }, 4000);
          }
        }
      };

      const collectDiagnostics = async () => {
        const body = document.body;
        const before = getComputedStyle(body, '::before');
        const after = getComputedStyle(body, '::after');
        const skin = (element) => {
          if (!element) return null;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            cls: String(element.className || '').slice(0, 100),
            position: style.position,
            zIndex: style.zIndex,
            background: style.backgroundColor,
            backgroundImage: String(style.backgroundImage || '').slice(0, 180),
            opacity: style.opacity,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          };
        };
        const nodes = [];
        const queue = [document.getElementById('root')];
        let guard = 0;
        while (queue.length > 0 && nodes.length < 20 && guard < 80) {
          const element = queue.shift();
          if (!element) continue;
          nodes.push(skin(element));
          for (const child of [...element.children].slice(0, 4)) queue.push(child);
          guard += 1;
        }
        const tokens = {};
        for (const name of [
          '--dsw-alias-bg-base',
          '--dsw-alias-bg-layer-1',
          '--dsw-alias-bg-overlay',
          '--dsw-specific-sidebar-fill',
          '--dsw-alias-label-primary',
          '--dsw-alias-brand-primary',
          '--ts-veil',
        ]) {
          tokens[name] = getComputedStyle(body).getPropertyValue(name).trim();
        }
        const wallpapers = [];
        for (const wallpaper of manifest && Array.isArray(manifest.wallpapers) ? manifest.wallpapers : []) {
          wallpapers.push(
            await new Promise((resolve) => {
              const image = new Image();
              const timer = setTimeout(() => resolve({ ...wallpaper, loaded: false, reason: 'timeout' }), 4000);
              image.onload = () => {
                clearTimeout(timer);
                resolve({ ...wallpaper, loaded: true, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
              };
              image.onerror = () => {
                clearTimeout(timer);
                resolve({ ...wallpaper, loaded: false, reason: 'error' });
              };
              image.src = `${wallpaper.url}?v=${wallpaper.mtimeMs}`;
            }),
          );
        }
        return {
          at: new Date().toISOString(),
          url: location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
          platform: {
            dark: body.hasAttribute('data-ds-dark-theme'),
            themeSource: root.getAttribute('data-ds-theme-source'),
            windowsTitlebar: root.hasAttribute('data-windows-titlebar'),
            platform: root.getAttribute('data-platform'),
          },
          studio: {
            family: state.family,
            motion: state.motion,
            wallpaper: state.wallpaper,
            mode: state.mode,
            clarity: state.clarity,
            attribute: root.getAttribute('data-theme-studio'),
            hasArtUrl: Boolean(root.style.getPropertyValue('--ts-art-current')),
          },
          body: {
            backgroundColor: getComputedStyle(body).backgroundColor,
            before: {
              backgroundImage: String(before.backgroundImage || '').slice(0, 400),
              position: before.position,
              zIndex: before.zIndex,
              animationName: before.animationName,
              transform: before.transform,
            },
            after: {
              backgroundImage: String(after.backgroundImage || '').slice(0, 240),
              zIndex: after.zIndex,
              mixBlendMode: after.mixBlendMode,
              opacity: after.opacity,
              animationName: after.animationName,
            },
          },
          tokens,
          nodes,
          wallpapers,
          manifestDirectory: manifest ? manifest.directory : null,
          hasRoot: Boolean(document.getElementById('root')),
        };
      };

      /**
       * Live UI probe, enabled only while the diagnostics sentinel exists.
       * It reports which theme entries the current page actually mounted and
       * where they landed, so a "button is missing" report can be answered from
       * the DOM instead of guesses.
       */
      const probeRect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          zIndex: style.zIndex,
          visible: rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden',
        };
      };
      const heroRowProbe = () => {
        const rows = [...document.querySelectorAll('div')].filter((node) => typeof node.className === 'string' && /heroWorkspaceRow|heroOptions/.test(node.className));
        return rows.slice(0, 4).map((node) => {
          const rect = node.getBoundingClientRect();
          return { cls: String(node.className).slice(0, 140), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
        });
      };
      const probeStyle = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
          border: style.border,
          borderRadius: style.borderRadius,
          padding: style.padding,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          background: style.backgroundColor,
          color: style.color,
          minHeight: style.minHeight,
        };
      };
      const workspaceChipProbe = () => {
        const buttons = [...document.querySelectorAll('button')];
        const element = buttons.find((button) => {
          const text = String(button.textContent || '').trim();
          const label = String(button.getAttribute('aria-label') || '');
          return text.includes('默认工作区') || text.includes('选择工作区') || /workspace/i.test(label);
        });
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          cls: String(element.className).slice(0, 140),
          rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
          border: style.border,
          borderRadius: style.borderRadius,
          padding: style.padding,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          background: style.backgroundColor,
          color: style.color,
          minHeight: style.minHeight,
        };
      };
      const styleOfElement = (element) => {
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          cls: String(element.className || '').slice(0, 120),
          aria: String(element.getAttribute('aria-label') || '').slice(0, 40),
          rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
          border: style.border,
          borderRadius: style.borderRadius,
          padding: style.padding,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontWeight: style.fontWeight,
          background: style.backgroundColor,
          color: style.color,
        };
      };
      const themeNeighborProbe = () => {
        const button = document.querySelector('.ts-headBtn');
        if (!button) return null;
        let container = button.parentElement;
        const out = [];
        for (let level = 0; level < 3 && container && container.parentElement; level += 1) {
          for (const sibling of [...container.parentElement.children]) {
            if (sibling === container) continue;
            const inner = sibling.querySelector ? sibling.querySelector('button') : null;
            if (!inner) continue;
            const rect = inner.getBoundingClientRect();
            if (rect.width < 10) continue;
            out.push({ level, wrapper: styleOfElement(sibling), button: styleOfElement(inner) });
          }
          container = container.parentElement;
        }
        return out.slice(0, 8);
      };
      const probeUi = () => ({
        kind: 'ui-probe',
        build: BUILD,
        at: new Date().toISOString(),
        href: String(location.href),
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        nodes: {
          footerWrap: probeRect('.ts-footWrap'),
          footerButton: probeRect('.ts-footBtn'),
          fabRoot: probeRect('.ts-fabRoot'),
          fabButton: probeRect('.ts-fabBtn'),
          fabPanel: probeRect('.ts-fabPanel2'),
          heroChip: probeRect('.ts-heroChip'),
          headerSwitch: probeRect('.ts-headBtn'),
          sheet: probeRect('.ts-fabPanel'),
        },
        host: {
          headerLeading: Boolean(document.querySelector('[data-conversation-header-leading]')),
          headerCorner: Boolean(document.querySelector('[data-conversation-header-corner]')),
          conversationTabs: Boolean(document.querySelector('[data-conversation-tabs]')),
          settingsOpen: Boolean(document.querySelector('[data-shortcut-modal="settings"]')),
          sidebarCollapsedClass: Boolean(document.querySelector('[class*="collapsed"]')),
          heroRows: heroRowProbe(),
          workspaceChip: workspaceChipProbe(),
          themeNeighbors: themeNeighborProbe(),
          themeHead: probeStyle('.ts-headBtn'),
          sidebarCandidates: [...document.querySelectorAll('*')].filter((node) => typeof node.className === 'string' && /sidebar/i.test(node.className)).slice(0, 6).map((node) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return { cls: String(node.className).slice(0, 90), bg: style.backgroundColor, w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x) }; }),
          mainSurface: (() => { const node = document.querySelector('[data-conversation-root], [class*="scrollBody"], [class*="centerCol"], main'); if (!node) return null; const style = getComputedStyle(node); return { cls: String(node.className || '').slice(0, 90), bg: style.backgroundColor }; })(),
          themeFab: probeStyle('.ts-fabBtn'),
          title: String(document.title).slice(0, 140),
          bodyTextSample: String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 160),
          wallpaperImage: String(getComputedStyle(document.body, '::before').backgroundImage || '').slice(-220),
        },
      });
      let probeTimer = null;
      const publishProbe = () => {
        if (!manifest || manifest.diagnostics !== true) return;
        try {
          void fetch(`${ROUTE}/diag`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(probeUi()),
          }).catch(() => {});
        } catch {
          /* ignore */
        }
      };
      const startProbe = () => {
        if (probeTimer !== null || !manifest || manifest.diagnostics !== true) return;
        probeTimer = every(publishProbe, 3000);
        later(publishProbe, 1500);
      };

      const scheduleDiagnostics = () => {
        if (diagSent || !manifest || manifest.diagnostics !== true) return;
        diagSent = true;
        clearTimeout(diagTimer);
        diagTimer = later(() => {
          collectDiagnostics()
            .then(async (payload) => {
              try {
                const response = await fetch(`${ROUTE}/diag`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(payload),
                });
                if (response.ok) return;
                throw new Error(`diag HTTP ${response.status}`);
              } catch {
                // Desktop custom-protocol bridges may refuse POST; a minimal
                // GET snapshot still lets the developer verify the live layer.
                const minimal = {
                  at: payload.at,
                  url: payload.url,
                  viewport: payload.viewport,
                  platform: payload.platform,
                  studio: payload.studio,
                  body: payload.body,
                  tokens: payload.tokens,
                  nodes: (payload.nodes || []).slice(0, 10),
                  wallpapers: (payload.wallpapers || []).map((item) => ({ theme: item.theme, name: item.name, loaded: item.loaded, reason: item.reason, naturalWidth: item.naturalWidth, naturalHeight: item.naturalHeight })),
                  manifestDirectory: payload.manifestDirectory,
                };
                const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(minimal))));
                await fetch(`${ROUTE}/diag?data=${encodeURIComponent(encoded)}`, { method: 'GET' });
              }
            })
            .catch(() => {});
        }, 2200);
      };

      const UI_BINDING = {
        subscribe: UI_API.subscribe,
        getSnapshot: UI_API.getSnapshot,
        t: UI_API.t,
        name: UI_API.name,
        tag: UI_API.tag,
        actions: {
          applyFamily,
          setMotion,
          setWallpaper,
          setClarity,
          setMode,
          refreshWallpapers() {
            void fetchManifest(0);
          },
        },
      };
      UI = UI_BINDING;

      /**
       * Plugin-owned floating theme switch.
       *
       * Slots depend on which panels the host mounts, and the blank-session
       * "新会话" Hero mounts neither the session header nor a guaranteed option
       * row (a live DOM probe confirmed both fallbacks were absent there). This
       * vanilla button is appended to <body> directly, so it exists in every
       * main-panel state; CSS hides it only when a better seat (the session
       * header switch or the Hero chip) is present in the DOM.
       */
      const mountFloatingSwitch = () => {
        const body = typeof document === 'undefined' ? null : document.body;
        if (!body || typeof body.appendChild !== 'function' || typeof body.addEventListener !== 'function') return () => {};
        let host = null;
        let unsubscribe = null;
        let panel = null;
        let stopContextWatch = () => {};
        const listeners = [];
        const on = (target, type, handler, capture) => {
          target.addEventListener(type, handler, capture);
          listeners.push(() => target.removeEventListener(type, handler, capture));
        };
        const clear = (element) => {
          while (element.firstChild) element.removeChild(element.firstChild);
        };
        const make = (tag, className, text) => {
          const element = document.createElement(tag);
          if (className) element.className = className;
          if (text !== undefined) element.textContent = text;
          return element;
        };
        try {
          host = make('div', 'ts-fabRoot');
          host.id = 'dsh-theme-studio-fab';
          host.innerHTML = [
            '<button type="button" class="ts-fabBtn" aria-haspopup="dialog" aria-expanded="false">',
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="display:block;flex:none">',
            '<path d="M8 2.2c3.2 0 5.8 2.3 5.8 5.2 0 1.4-.9 2.4-2.2 2.4h-1.1c-.7 0-1.2.5-1.2 1.1 0 .3.1.5.3.8.2.2.3.5.3.8 0 .7-.6 1.2-1.4 1.2C5.1 13.7 2.2 11.2 2.2 8c0-3.2 2.6-5.8 5.8-5.8z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>',
            '<circle cx="5.2" cy="7.2" r="0.9" fill="currentColor"/><circle cx="7.4" cy="5.4" r="0.9" fill="currentColor"/><circle cx="9.7" cy="6.2" r="0.9" fill="currentColor"/>',
            '</svg><span class="ts-fabBtnLabel"></span></button>',
            '<div class="ts-fabPanel2" role="dialog" hidden>',
            '<div class="ts-fabHead"><span class="ts-fabTitle"></span><span class="ts-fabNow"></span></div>',
            '<div class="ts-fabModes" data-row="mode"></div>',
            '<div class="ts-fabGrid" data-row="grid"></div>',
            '<div class="ts-fabClarity"><span class="ts-fabClarityLabel"></span><div class="ts-fabModes" data-row="clarity"></div></div>',
            '<div class="ts-fabHint" data-row="hint"></div>',
            '</div>',
          ].join('');
          body.appendChild(host);
          const button = host.querySelector('.ts-fabBtn');
          panel = host.querySelector('.ts-fabPanel2');
          const label = host.querySelector('.ts-fabBtnLabel');
          const title = host.querySelector('.ts-fabTitle');
          const now = host.querySelector('.ts-fabNow');
          const modeRow = host.querySelector('[data-row="mode"]');
          const grid = host.querySelector('[data-row="grid"]');
          const clarityRow = host.querySelector('[data-row="clarity"]');
          const clarityLabel = host.querySelector('.ts-fabClarityLabel');
          const hint = host.querySelector('[data-row="hint"]');
          let open = false;
          const render = () => {
            const snapshot = UI_BINDING.getSnapshot();
            const t = UI_BINDING.t;
            const current = snapshot.families.find((family) => family.id === snapshot.family);
            label.textContent = t('panelTitle');
            title.textContent = t('panelTitle');
            clarityLabel.textContent = t('clarity');
            button.setAttribute('aria-label', t('fab'));
            button.setAttribute('title', t('fab') + (current ? ' · ' + UI_BINDING.name(current) : ''));
            panel.setAttribute('aria-label', t('panelTitle'));
            now.textContent = current ? UI_BINDING.name(current) : t('offTitle');
            clear(modeRow);
            [
              ['fixed', t('modeFixed')],
              ['rotate', t('modeRotate')],
            ].forEach(([value, text]) => {
              const item = make('button', 'ts-fabMode' + (snapshot.mode === value ? ' is-active' : ''), text);
              item.type = 'button';
              on(item, 'click', (event) => {
                event.stopPropagation();
                UI_BINDING.actions.setMode(value);
              });
              modeRow.appendChild(item);
            });
            clear(clarityRow);
            [
              ['soft', t('claritySoft')],
              ['standard', t('clarityStandard')],
              ['clear', t('clarityClear')],
            ].forEach(([value, text]) => {
              const item = make('button', 'ts-fabMode' + (snapshot.clarity === value ? ' is-active' : ''), text);
              item.type = 'button';
              on(item, 'click', (event) => {
                event.stopPropagation();
                UI_BINDING.actions.setClarity(value);
              });
              clarityRow.appendChild(item);
            });
            clear(grid);
            snapshot.families.forEach((family) => {
              const item = make('button', 'ts-fabItem' + (snapshot.family === family.id ? ' is-active' : ''));
              item.type = 'button';
              item.title = family.name.zh + ' / ' + family.name.en;
              const swatch = make('span', 'ts-fabSwatch');
              swatch.style.backgroundImage = family.preview;
              item.appendChild(swatch);
              item.appendChild(make('span', 'ts-fabName', UI_BINDING.name(family)));
              on(item, 'click', (event) => {
                event.stopPropagation();
                UI_BINDING.actions.applyFamily(family.id);
              });
              grid.appendChild(item);
            });
            const offItem = make('button', 'ts-fabItem' + (snapshot.family === 'off' ? ' is-active' : ''));
            offItem.type = 'button';
            offItem.appendChild(make('span', 'ts-fabSwatch'));
            offItem.appendChild(make('span', 'ts-fabName', t('offTitle')));
            on(offItem, 'click', (event) => {
              event.stopPropagation();
              UI_BINDING.actions.applyFamily('off');
            });
            grid.appendChild(offItem);
            hint.textContent = snapshot.mode === 'rotate' ? t('rotateHint') : t('fixedHint');
          };
          const setOpen = (value) => {
            open = value;
            panel.hidden = !open;
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) render();
          };
          on(button, 'click', (event) => {
            event.stopPropagation();
            setOpen(!open);
          });
          on(panel, 'click', (event) => event.stopPropagation());
          on(
            document,
            'pointerdown',
            (event) => {
              if (open && host && !host.contains(event.target)) setOpen(false);
            },
            true,
          );
          on(
            document,
            'keydown',
            (event) => {
              if (open && event.key === 'Escape') setOpen(false);
            },
            true,
          );
          unsubscribe = UI_BINDING.subscribe(() => render());
          render();
          /* Runtime guard for hosts where the CSS markers do not cover a new
           * surface: only show the switch on conversation/home, and never while
           * a settings/plugins dialog is open. */
          const contextAllowed = () => {
            if (document.querySelector('[data-shortcut-modal="settings"]')) return false;
            if (document.querySelector('[role="presentation"] > [role="dialog"][aria-modal="true"]')) return false;
            if (document.querySelector('[data-conversation-header-leading], [data-conversation-root], [data-conversation-composer-overlay], [data-slot="conversation.session"]')) return true;
            return [...document.querySelectorAll('div[class]')].some((node) => /heroWorkspaceRow|heroOptions/.test(String(node.className)));
          };
          let contextObserver = null;
          let contextTimer = null;
          const syncContext = () => {
            if (!host) return;
            try {
              const allowed = contextAllowed();
              host.style.display = allowed ? '' : 'none';
              if (!allowed && open) setOpen(false);
            } catch {
              /* leave the switch visible if the host DOM cannot be inspected */
            }
          };
          if (typeof MutationObserver === 'function') {
            contextObserver = new MutationObserver(syncContext);
            contextObserver.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['class', 'data-shortcut-modal', 'aria-modal'],
            });
          }
          if (typeof window.setInterval === 'function') contextTimer = window.setInterval(syncContext, 1500);
          syncContext();
          stopContextWatch = () => {
            if (contextObserver) {
              try {
                contextObserver.disconnect();
              } catch {
                /* ignore */
              }
              contextObserver = null;
            }
            if (contextTimer !== null) {
              window.clearInterval(contextTimer);
              contextTimer = null;
            }
          };
        } catch (error) {
          if (host && typeof host.remove === 'function') host.remove();
          return () => {};
        }
        return () => {
          try {
            if (stopContextWatch) stopContextWatch();
          } catch {
            /* ignore */
          }
          try {
            if (unsubscribe) unsubscribe();
          } catch {
            /* ignore */
          }
          for (const off of listeners) {
            try {
              off();
            } catch {
              /* ignore */
            }
          }
          listeners.length = 0;
          try {
            if (host) host.remove();
          } catch {
            /* ignore */
          }
          host = null;
          panel = null;
        };
      };

      trace.step = 'floating-switch';
      ctx.effect(() => mountFloatingSwitch(), 'theme-studio: floating switch');

      trace.step = 'styles';
      ctx.effect(() => {
        const disposeStyles = insertStyles(ctx, buildCss());
        return () => {
          disposeStyles();
        };
      }, 'theme-studio: stylesheets');

      trace.step = 'theme-layer';
      ctx.effect(() => {
        applyFamily(state.family, { auto: true });
        return () => {
          if (layerDispose !== null) {
            layerDispose();
            layerDispose = null;
          }
          clearTimers();
          const family = FAMILIES.find((item) => item.id === state.family);
          if (family) root.style.removeProperty('--ts-art-current');
          root.removeAttribute('data-theme-studio');
          root.removeAttribute('data-theme-motion');
          root.removeAttribute('data-theme-wallpaper');
          root.removeAttribute('data-theme-clarity');
        };
      }, 'theme-studio: active theme');

      trace.step = 'listeners';
      ctx.effect(() => {
        const offTheme = ctx.on('theme/change', () => {
          const family = FAMILIES.find((item) => item.id === state.family);
          if (family) syncArt(family);
          invalidate();
        });        const offLocale = locale && typeof locale.subscribe === 'function' ? locale.subscribe(() => invalidate()) : null;
        return () => {
          offTheme();
          if (typeof offLocale === 'function') offLocale();
          listeners.clear();
        };
      }, 'theme-studio: change listeners');

      trace.step = 'rotation';
      ctx.effect(() => {
        maybeRotate();
        const id = every(() => maybeRotate(), 30 * 60 * 1000);
        return () => window.clearInterval(id);
      }, 'theme-studio: theme rotation');

      trace.step = 'manifest';
      void fetchManifest(0);

      trace.step = 'locale';
      if (locale && typeof locale.register === 'function') {
        ctx.effect(
          () =>
            locale.register(NS, {
              zh: DICT.zh,
              en: DICT.en,
            }),
          'theme-studio: dictionaries',
        );
      }

      trace.step = 'slot-section';
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'theme-studio-quick',
            order: 12,
            locale: NS,
          },
          QuickThemeRow,
        ),
      );

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'theme-studio',
            order: 35,
            label: () => UI_BINDING.t('nav'),
            locale: NS,
          },
          ThemeStudioPage,
        ),
      );

      trace.step = 'slot-icon';
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register({ name: 'settings.section.icon', id: 'theme-studio', order: 35 }, (owner) => h(NavIcon, { size: owner && owner.size ? owner.size : 16 })),
      );

      trace.step = 'slot-overlay';
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'theme-studio-switcher', order: -20, label: () => UI_BINDING.t('fab') },
          HeaderThemeSwitch,
        ),
      );

      // The header switch only exists while a Session header is mounted; the
      // sidebar foot is mounted for every main-panel state, including the
      // blank-session home, so the theme stays reachable there.
      trace.step = 'slot-sidebar-theme';
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'theme-studio-foot', order: 20, label: () => UI_BINDING.t('fab'), locale: NS },
          SidebarThemeAction,
        ),
      );

      // A blank new session ("新会话" Hero) hides the session header chrome; the
      // plugin-owned floating switch below covers that state at the top-right.
      trace.step = 'ready';
    }

    /**
     * Boot-safe entry point: one broken theme must never abort the Web UI.
     * @param ctx - client Cordis context.
     */
    /**
     * Boot-safe entry point. Activation is deferred one tick and fully guarded:
     * one broken theme must never abort the Web UI boot (a throwing client
     * entry takes the whole shell down). Failures are reported to the Host
     * diagnostics sink instead of escaping.
     * @param ctx - client Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const timer = window.setTimeout(() => {
          const trace = { step: 'begin' };
          try {
            activate(ctx, trace);
          } catch (error) {
            reportFailure('apply:' + trace.step, error);
          }
        }, 0);
        return () => window.clearTimeout(timer);
      }, 'theme-studio: deferred activation');
    }

    function insertStyles(ctx, css) {
      const stylesApi = typeof styles !== 'undefined' ? styles : null;
      let removeShapes = () => {};
      if (typeof document !== 'undefined' && document.body && typeof document.createElementNS === 'function') {
        // Invisible SVG filter used by clear mode's unsharp pass.
        if (!document.getElementById('ts-clarity-filter')) {
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.id = 'ts-clarity-filter';
          svg.setAttribute('width', '0');
          svg.setAttribute('height', '0');
          svg.setAttribute('aria-hidden', 'true');
          svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
          const defs = document.createElementNS(ns, 'defs');
          const filter = document.createElementNS(ns, 'filter');
          filter.id = 'ts-clarity-sharpen';
          filter.setAttribute('x', '0');
          filter.setAttribute('y', '0');
          filter.setAttribute('width', '100%');
          filter.setAttribute('height', '100%');
          filter.setAttribute('color-interpolation-filters', 'sRGB');
          const kernel = document.createElementNS(ns, 'feConvolveMatrix');
          kernel.setAttribute('order', '3');
          kernel.setAttribute('preserveAlpha', 'true');
          kernel.setAttribute('edgeMode', 'duplicate');
          kernel.setAttribute('kernelMatrix', '0 -0.06 0 -0.06 1.24 -0.06 0 -0.06 0');
          filter.appendChild(kernel);
          defs.appendChild(filter);
          svg.appendChild(defs);
          document.body.appendChild(svg);
          removeShapes = () => svg.remove();
        }
      }
      let removeSheet = () => {};
      if (stylesApi && typeof stylesApi.insert === 'function') {
        const dispose = stylesApi.insert(css);
        removeSheet = () => { if (typeof dispose === 'function') dispose(); };
      } else if (typeof document !== 'undefined') {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-theme-studio';
        tag.textContent = css;
        document.head.appendChild(tag);
        removeSheet = () => tag.remove();
      }
      return () => {
        removeSheet();
        removeShapes();
      };
    }

    return {
      inject: ['theme', 'slots'],
      apply,
    };
    } catch (fatal) {
      reportFailure('factory', fatal);
      return { inject: [], apply() {} };
    }
  },
});
