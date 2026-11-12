import React from 'react';

/*
  STAGE 11.1: page layout primitives.

  PageContainer is the one horizontal rhythm every page should share -- the
  max-w-7xl / px-4 sm:px-6 lg:px-8 wrapper that the audit found re-typed on every
  page. PageHeader is the matching title block: a real <h1>, an optional supporting
  line, and a right-aligned actions slot that stacks under the title on small
  screens. Both are presentational and take children/slots so they can be adopted
  page by page in the redesign stages without forcing a rewrite now.
*/
export const PageContainer = ({ className = '', children }) => (
    <div className={`mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 ${className}`}>
        {children}
    </div>
);

export const PageHeader = ({ title, description, actions, className = '' }) => (
    <div
        className={`flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${className}`}
    >
        <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            {description && <p className="mt-1 text-sm text-foreground-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
);

export default PageContainer;
