import React from 'react';

/*
  STAGE 11.1: the shared status Badge primitive.

  Semantic variants instead of the hardcoded colour classes the audit found on the
  dashboard job cards (bg-blue-100 text-blue-800 etc). The variant names describe
  meaning -- success, warning, danger, info -- so a page reads as intent rather than
  as a colour, and the palette lives in one place (index.css @theme).
*/
const VARIANT_CLASSES = {
    neutral: 'border-border bg-surface-muted text-foreground-muted',
    primary: 'border-transparent bg-accent-subtle text-accent-subtle-foreground',
    success: 'border-transparent bg-success-subtle text-success-subtle-foreground',
    warning: 'border-transparent bg-warning-subtle text-warning-subtle-foreground',
    danger: 'border-transparent bg-danger-subtle text-danger-subtle-foreground',
    info: 'border-transparent bg-info-subtle text-info-subtle-foreground',
};

const Badge = ({ variant = 'neutral', className = '', children, ...rest }) => {
    const variantClass = VARIANT_CLASSES[variant] || VARIANT_CLASSES.neutral;

    return (
        <span
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${variantClass} ${className}`}
            {...rest}
        >
            {children}
        </span>
    );
};

export default Badge;
