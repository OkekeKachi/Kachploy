import React from 'react';

const SIZE_CLASSES = {
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-2xl',
};

const TONE_CLASSES = {
    light: 'text-foreground',
    dark: 'text-white',
};

const BrandWordmark = ({ size = 'md', tone = 'light', className = '' }) => {
    const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;
    const toneClass = TONE_CLASSES[tone] || TONE_CLASSES.light;

    return (
        <span
            className={`inline-block whitespace-nowrap font-brand font-semibold leading-none tracking-[-0.035em] ${sizeClass} ${toneClass} ${className}`}
        >
            <span className="font-bold text-accent">K</span>achploy
        </span>
    );
};

export default BrandWordmark;
