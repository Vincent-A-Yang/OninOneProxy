"use client";

/**
 * Unified Tooltip component.
 *
 * Supports two usage styles:
 *   1. <Tooltip text="tip">trigger element</Tooltip>      // children as trigger
 *   2. <Tooltip text="..." />                              // backward compat: help icon as trigger
 *
 * Props:
 *   - text:     tooltip content (string)
 *   - children: optional trigger element; falls back to a help icon when omitted
 *   - position: top | bottom | left | right (default "top")
 *   - color:    optional background color override
 */
export default function Tooltip({ text, children, position = "top", color }) {
  const posClass = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[position];

  const bgStyle = color ? { backgroundColor: color } : {};
  const bgClass = color ? "" : "bg-gray-900";

  // Backward compat: when no children provided, render a default help icon
  // (supports the legacy endpoint/components/Tooltip usage: <Tooltip text="..." />)
  const trigger = children ?? (
    <span className="material-symbols-outlined text-[14px] text-text-muted cursor-help">help</span>
  );

  return (
    <div className="relative inline-flex group/tt">
      {trigger}
      <div
        className={`pointer-events-none absolute ${posClass} z-50 w-max max-w-56 rounded px-2 py-1 text-[11px] leading-snug ${bgClass} text-white opacity-0 group-hover/tt:opacity-100 transition-opacity duration-150 whitespace-normal`}
        style={bgStyle}
      >
        {text}
      </div>
    </div>
  );
}
