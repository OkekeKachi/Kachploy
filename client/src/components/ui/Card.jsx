import React from 'react';

/*
  STAGE 11.1: the shared Card / surface primitive.

  A single flat surface -- neutral background, subtle border, one resting shadow --
  for every panel the app draws. It intentionally exposes nothing but `as` and
  `className`: the goal is one consistent surface treatment, not a mini framework.
  Callers compose padding and layout with utility classes, and can override the tag
  with `as` (for example `as="section"` or `as="li"`) without losing semantics.
*/
const Card = React.forwardRef(function Card(props, ref) {
    const { as, className = '', children, ...rest } = props;
    const Component = as || 'div';

    return (
        <Component
            ref={ref}
            className={`rounded-lg border border-border bg-surface shadow-card ${className}`}
            {...rest}
        >
            {children}
        </Component>
    );
});

export default Card;
