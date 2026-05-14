import type { ReactNode } from 'react';

interface CodeTagProps {
  children: ReactNode;
  className?: string;
  variant?: 'open' | 'close';
}

/**
 * `<date>May 13, 2026</date>` style decorative wrapper from overflow.sui.io.
 * Cyan angle brackets, mono content between.
 */
export function CodeTag({ children, className = '', variant = 'open' }: CodeTagProps) {
  // Always apply the base `.code-tag` styling (mono font, size, weight,
  // currentColor); the `.code-tag-close` modifier only overrides the
  // pseudo-element bracket characters.
  const classes =
    variant === 'close' ? `code-tag code-tag-close ${className}` : `code-tag ${className}`;
  return <span className={classes.trim()}>{children}</span>;
}

interface TagPairProps {
  tag: string;
  children: ReactNode;
  className?: string;
}

/** Wraps a value in matching `<tag>value</tag>` decoration. */
export function TagPair({ tag, children, className = '' }: TagPairProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <CodeTag>{tag}</CodeTag>
      <span>{children}</span>
      <CodeTag variant="close">{tag}</CodeTag>
    </span>
  );
}
