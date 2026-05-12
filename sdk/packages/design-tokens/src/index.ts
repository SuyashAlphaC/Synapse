/**
 * Synapse Core Design Tokens
 *
 * Codifies the Sui Overflow 2026 theme (overflow.sui.io) for use across the
 * Synapse Core dashboard, Memory Inspector, marketing site, and pitch deck.
 *
 * Visual language:
 *   - Cream background, dark navy text (high contrast, paper-like)
 *   - Vibrant accent palette: orange, purple, green, blue, pink, yellow
 *   - Bold geometric grotesque typography for headings
 *   - Code-tag motif (`<date>...</date>`) used as a decorative element
 *   - Blueprint grid background motif for hero sections
 *   - Y2K / retro-tech aesthetic: isometric blocks, hand-pointer cursors,
 *     sharp corners, no excessive rounding
 */

export const colors = {
  // Primary background / text
  paper: '#F5F0E6', // warm off-white, the dominant background
  ink: '#030F1C', // near-black navy used for body text + buttons
  inkSoft: '#1A2533', // softened ink for secondary text

  // Code-tag / accent text (the "<date>" tags in the hero)
  codeTag: '#5BC0EB', // bright cyan-blue used for code-tag decorations

  // Vibrant accent palette (drawn from the Overflow keycap illustration)
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

  // Functional / status colors
  status: {
    success: '#5BD49C',
    warning: '#F7C543',
    danger: '#FF6B35',
    info: '#4A9BFF',
  },

  // Grid / line accents
  grid: '#D6E4F5', // light blue blueprint grid lines
  divider: 'rgba(3, 15, 28, 0.12)',
} as const;

export const typography = {
  fontFamily: {
    // Bold geometric grotesque for headings (Overflow uses something close to
    // Inter Display Bold; we ship Inter as the open-source equivalent + a
    // system fallback chain).
    display: '"Inter Display", Inter, system-ui, -apple-system, sans-serif',
    sans: 'Inter, system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, monospace',
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem',
    '5xl': '3rem',
    '6xl': '3.75rem',
    '7xl': '4.5rem',
    '8xl': '6rem',
    '9xl': '8rem',
  },
  fontWeight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
    extrabold: '800',
    black: '900',
  },
  lineHeight: {
    tight: '1.05',
    snug: '1.2',
    normal: '1.45',
    relaxed: '1.6',
  },
  letterSpacing: {
    tighter: '-0.04em',
    tight: '-0.02em',
    normal: '0',
    wide: '0.02em',
    wider: '0.05em',
  },
} as const;

export const spacing = {
  px: '1px',
  0.5: '0.125rem',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
  32: '8rem',
  40: '10rem',
  48: '12rem',
  64: '16rem',
} as const;

export const radius = {
  none: '0',
  sm: '2px',
  base: '4px', // Overflow uses sharp corners; default radius stays small
  md: '6px',
  lg: '8px',
  xl: '12px',
  full: '9999px',
} as const;

export const shadow = {
  // Sharp drop shadows characteristic of the Y2K aesthetic
  flat: '4px 4px 0 0 #030F1C',
  flatSoft: '2px 2px 0 0 rgba(3, 15, 28, 0.4)',
  lift: '0 4px 14px rgba(3, 15, 28, 0.08)',
  hover: '0 8px 24px rgba(3, 15, 28, 0.12)',
} as const;

export const motion = {
  duration: {
    fast: '120ms',
    base: '200ms',
    slow: '320ms',
  },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    decel: 'cubic-bezier(0, 0, 0.2, 1)',
    accel: 'cubic-bezier(0.4, 0, 1, 1)',
  },
} as const;

export const layout = {
  maxWidth: {
    prose: '65ch',
    container: '1280px',
    wide: '1440px',
  },
  // Blueprint grid as a CSS background-image pattern
  blueprintGrid: `
    linear-gradient(${colors.grid} 1px, transparent 1px),
    linear-gradient(90deg, ${colors.grid} 1px, transparent 1px)
  `,
  blueprintGridSize: '32px 32px',
} as const;

/**
 * Convenience map for chip/badge color schemes per agent state.
 * Used in the Memory Inspector timeline and dashboard agent cards.
 */
export const agentStateColors = {
  active: colors.accent.green,
  expired: colors.accent.yellow,
  revoked: colors.accent.orange,
  draft: colors.accent.lavender,
} as const;

export const tokens = {
  colors,
  typography,
  spacing,
  radius,
  shadow,
  motion,
  layout,
  agentStateColors,
} as const;

export type SynapseTokens = typeof tokens;

export default tokens;
