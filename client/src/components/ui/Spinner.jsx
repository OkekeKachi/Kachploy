import React from 'react';

/*
  STAGE 11.1: shared loading indicators.

  The audit found the same two-ring spinner and "Loading... / Please wait" block
  copy-pasted into ProtectedRoute.jsx and RoleBasedDashboard.jsx (and again on the
  dashboards). These are the two primitives that replace it: a bare `Spinner` for
  inline use, and a `PageLoader` that centres a spinner plus a label in the viewport.

  Both use `border-current`, so the caller colours the spinner with a text-* class
  and nothing else needs to change. `role="status"` gives assistive technology a
  single, polite announcement point.
*/
const SIZE_CLASSES = {
    sm: 'h-4 w-4 border-2',
    md: 'h-6 w-6 border-2',
    lg: 'h-10 w-10 border-4',
};

const Spinner = ({ size = 'md', className = '', label = 'Loading' }) => {
    const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;

    return (
        <span
            role="status"
            aria-label={label}
            className={`inline-block animate-spin rounded-full border-current border-t-transparent ${sizeClass} ${className}`}
        />
    );
};

export const PageLoader = ({ label = 'Loading…', className = '' }) => (
    <div className={`flex min-h-screen w-full items-center justify-center bg-canvas ${className}`}>
        <div className="flex flex-col items-center gap-3 text-foreground-muted">
            <Spinner size="lg" className="text-accent" />
            <p className="text-sm font-medium">{label}</p>
        </div>
    </div>
);

export default Spinner;
