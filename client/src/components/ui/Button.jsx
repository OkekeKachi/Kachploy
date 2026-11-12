import React from 'react';

/*
  STAGE 11.1: the shared Button primitive.

  One component with a small, explicit variant set replaces the per-page button
  class strings the audit found scattered across the dashboards and navbars. It
  renders a real <button>, takes every native attribute through `...rest`, and adds
  a single consistent focus ring so keyboard users get the same visible focus
  everywhere.

  Variants:
    primary      accent surface, for the one main action on a screen
    secondary    bordered neutral surface, for supporting actions
    destructive  danger surface, for remove/delete actions
    ghost        no surface until hover, for icon buttons and menu triggers
*/
const VARIANT_CLASSES = {
    primary:
        'bg-accent text-foreground-inverse hover:bg-accent-hover border border-transparent',
    secondary:
        'bg-surface text-foreground border border-border-strong hover:bg-surface-muted',
    destructive:
        'bg-danger text-foreground-inverse hover:bg-danger/90 border border-transparent',
    ghost:
        'bg-transparent text-foreground-muted hover:bg-surface-muted hover:text-foreground border border-transparent',
};

const SIZE_CLASSES = {
    sm: 'h-8 px-3 text-sm gap-1.5',
    md: 'h-10 px-4 text-sm gap-2',
    lg: 'h-11 px-5 text-base gap-2',
    icon: 'h-9 w-9 p-0',
};

const BASE_CLASSES =
    'inline-flex items-center justify-center rounded-md font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ' +
    'disabled:cursor-not-allowed disabled:opacity-60';

const Button = React.forwardRef(function Button(
    { variant = 'primary', size = 'md', type = 'button', className = '', children, ...rest },
    ref,
) {
    const variantClass = VARIANT_CLASSES[variant] || VARIANT_CLASSES.primary;
    const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;

    return (
        <button
            ref={ref}
            type={type}
            className={`${BASE_CLASSES} ${variantClass} ${sizeClass} ${className}`}
            {...rest}
        >
            {children}
        </button>
    );
});

export default Button;
