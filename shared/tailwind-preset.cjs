/**
 * ClearWood design tokens — the single source of truth for BOTH frontends (storefront + admin).
 * Consumed as a Tailwind preset so the two apps can never drift.
 * Mirrors docs/PROJECT_CONTEXT.md §7. Used in earnest from Prompt 12.
 */

const colors = {
  bg: '#FAF7F2',
  surface: '#FFFFFF',
  'surface-2': '#F2ECE3',
  ink: '#1E1A16',
  'ink-soft': '#6B6058',
  clay: '#B4613A',
  'clay-dark': '#8F4A2B',
  walnut: '#8A5A3B',
  sage: '#7E8C77',
  line: '#E3DACE',
  success: '#2E7D5B',
  danger: '#B23B3B',
};

/** Emitted into `:root` by each app's index.css so plain CSS can use the tokens too. */
const cssVariables = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [`--cw-${key}`, value]),
);

/** @type {import('tailwindcss').Config} */
const preset = {
  theme: {
    screens: {
      xs: '360px',
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    container: {
      center: true,
      padding: { DEFAULT: '1.25rem', md: '2rem' },
      screens: { '2xl': '1280px' },
    },
    extend: {
      colors: { cw: colors },
      fontFamily: {
        display: ['Fraunces', 'Playfair Display', 'Georgia', 'serif'],
        body: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        sm: '8px',
        md: '14px',
        lg: '22px',
        pill: '999px',
      },
      boxShadow: {
        cw: '0 10px 30px rgba(30,26,22,.08)',
        'cw-lg': '0 18px 48px rgba(30,26,22,.12)',
      },
      spacing: {
        section: '96px',
        'section-sm': '56px',
      },
      maxWidth: {
        container: '1280px',
      },
      transitionTimingFunction: {
        cw: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      transitionDuration: {
        cw: '280ms',
      },
    },
  },
  plugins: [],
};

module.exports = preset;
module.exports.cwColors = colors;
module.exports.cwCssVariables = cssVariables;
