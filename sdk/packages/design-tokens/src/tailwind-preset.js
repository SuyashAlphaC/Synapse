// Tailwind preset for the Synapse Core / Sui Overflow 2026 theme.
//
// Usage from a Next.js app's tailwind.config.ts:
//   import synapsePreset from '@synapse-core/design-tokens/tailwind';
//   export default {
//     presets: [synapsePreset],
//     content: ['./src/**/*.{ts,tsx}'],
//   };

/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: {
        paper: '#F5F0E6',
        ink: {
          DEFAULT: '#030F1C',
          soft: '#1A2533',
        },
        'code-tag': '#5BC0EB',
        accent: {
          orange: '#FF6B35',
          purple: '#9D7AEB',
          green: '#5BD49C',
          blue: '#4A9BFF',
          pink: '#FF8FA3',
          yellow: '#F7C543',
          lavender: '#C4A8F0',
          coral: '#FF7E6B',
        },
        grid: '#D6E4F5',
        state: {
          active: '#5BD49C',
          expired: '#F7C543',
          revoked: '#FF6B35',
          draft: '#C4A8F0',
        },
      },
      fontFamily: {
        display: ['"Inter Display"', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        tighter: '-0.04em',
        tight: '-0.02em',
      },
      borderRadius: {
        DEFAULT: '4px',
      },
      boxShadow: {
        flat: '4px 4px 0 0 #030F1C',
        'flat-soft': '2px 2px 0 0 rgba(3, 15, 28, 0.4)',
        lift: '0 4px 14px rgba(3, 15, 28, 0.08)',
        hover: '0 8px 24px rgba(3, 15, 28, 0.12)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
        slow: '320ms',
      },
      backgroundImage: {
        blueprint:
          'linear-gradient(#D6E4F5 1px, transparent 1px), linear-gradient(90deg, #D6E4F5 1px, transparent 1px)',
      },
      backgroundSize: {
        'blueprint-grid': '32px 32px',
      },
      maxWidth: {
        container: '1280px',
        wide: '1440px',
      },
    },
  },
};
