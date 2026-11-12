import React from 'react';

/*
  STAGE 11.1: the shared EmptyState primitive.

  Pages repeatedly hand-roll the "icon, heading, one line of explanation, one call
  to action" block for empty lists (no jobs, no applications, no conversations).
  This is that block in one place, with an optional `action` slot for a Button or
  Link. It is built now so the upcoming page redraws have a single, consistent
  empty state to reach for.
*/
const EmptyState = ({ icon: Icon, title, description, action, className = '' }) => {
    return (
        <div
            className={`flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center ${className}`}
        >
            {Icon && (
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-foreground-subtle">
                    <Icon className="h-6 w-6" aria-hidden="true" />
                </div>
            )}
            {title && <h3 className="text-base font-semibold text-foreground">{title}</h3>}
            {description && (
                <p className="mt-1 max-w-md text-sm text-foreground-muted">{description}</p>
            )}
            {action && <div className="mt-5">{action}</div>}
        </div>
    );
};

export default EmptyState;
