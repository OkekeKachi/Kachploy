import React from 'react';

/*
  STAGE 11.1: accessible form-field primitives.

  The Stage 11.0 audit found Profile.jsx (and others) using `placeholder` as the
  only label, with no <label>/htmlFor -- an accessibility gap. These primitives give
  the redesign a labelled input to standardise on:

    Field  wrapper: renders the <label> for the control by id, plus hint/error text
    Label  a plain <label> for callers that lay the field out themselves
    Input / Textarea / Select  the controls, sharing one border/focus treatment

  They are additive. No existing form is migrated in this stage: the controls below
  just pass through every native prop, so a page can adopt them incrementally
  without its form behaviour changing.
*/
const CONTROL_CLASSES =
    'block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm ' +
    'text-foreground placeholder:text-foreground-subtle transition-colors ' +
    'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 ' +
    'disabled:cursor-not-allowed disabled:bg-surface-muted';

export const Label = ({ htmlFor, children, className = '', ...rest }) => (
    <label htmlFor={htmlFor} className={`block text-sm font-medium text-foreground ${className}`} {...rest}>
        {children}
    </label>
);

export const Input = React.forwardRef(function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`${CONTROL_CLASSES} ${className}`} {...rest} />;
});

export const Textarea = React.forwardRef(function Textarea({ className = '', rows = 4, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={`${CONTROL_CLASSES} ${className}`} {...rest} />;
});

export const Select = React.forwardRef(function Select({ className = '', children, ...rest }, ref) {
    return (
        <select ref={ref} className={`${CONTROL_CLASSES} ${className}`} {...rest}>
            {children}
        </select>
    );
});

export const Field = ({ id, label, hint, error, required, children, className = '' }) => (
    <div className={`space-y-1.5 ${className}`}>
        {label && (
            <Label htmlFor={id}>
                {label}
                {required && (
                    <span className="ml-0.5 text-danger" aria-hidden="true">
                        *
                    </span>
                )}
            </Label>
        )}
        {children}
        {error ? (
            <p className="text-xs font-medium text-danger">{error}</p>
        ) : (
            hint && <p className="text-xs text-foreground-subtle">{hint}</p>
        )}
    </div>
);

export default Field;
