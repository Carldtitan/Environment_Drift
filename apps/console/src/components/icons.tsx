/**
 * Navigation glyphs drawn in the console's own grammar: squares, rules, and
 * right angles, matching the signal-grid motif. Geometry only - no picture
 * illustration, no icon-font, no third-party set.
 */

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
  className: "glyph",
};

export function IconOverview() {
  return (
    <svg {...base}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <path d="M9.5 11.5h4M11.5 9.5v4" />
    </svg>
  );
}

export function IconContract() {
  return (
    <svg {...base}>
      <rect x="3" y="1.75" width="10" height="12.5" rx="1.5" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </svg>
  );
}

export function IconRun() {
  return (
    <svg {...base}>
      <path d="M3 3v10" />
      <circle cx="3" cy="5" r="1.3" />
      <circle cx="3" cy="11" r="1.3" />
      <path d="M6 5h7M6 11h4" />
    </svg>
  );
}

export function IconDrift() {
  return (
    <svg {...base}>
      <path d="M2 5.5h6M2 10.5h9" />
      <path d="M11 3.5 14 5.5l-3 2" />
      <path d="M14 12.5h-2" />
    </svg>
  );
}

export function IconTeam() {
  return (
    <svg {...base}>
      <rect x="2" y="3" width="5" height="5" rx="1" />
      <rect x="9" y="8" width="5" height="5" rx="1" />
      <path d="M4.5 8v2.5h4.5" />
    </svg>
  );
}

export function IconSettings() {
  return (
    <svg {...base}>
      <path d="M2 4.5h12M2 11.5h12" />
      <rect x="5" y="2.6" width="3.8" height="3.8" rx="1" />
      <rect x="8.2" y="9.6" width="3.8" height="3.8" rx="1" />
    </svg>
  );
}

export function IconMenu() {
  return (
    <svg {...base} width={18} height={18} viewBox="0 0 18 18">
      <path d="M3 5h12M3 9h12M3 13h12" />
    </svg>
  );
}

/** The product mark: the signal grid with the clean-verified cell filled. */
export function Wordmark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      aria-hidden="true"
      focusable="false"
      className="glyph"
    >
      <rect x="0.5" y="0.5" width="25" height="25" rx="7" fill="#b85632" />
      <rect x="6" y="6" width="6" height="6" rx="1.5" fill="none" stroke="#fffaf2" strokeWidth="1.5" />
      <rect x="14" y="6" width="6" height="6" rx="1.5" fill="none" stroke="#fffaf2" strokeWidth="1.5" />
      <rect x="6" y="14" width="6" height="6" rx="1.5" fill="none" stroke="#fffaf2" strokeWidth="1.5" />
      <rect x="14" y="14" width="6" height="6" rx="1.5" fill="#fffaf2" />
    </svg>
  );
}

export function IconTimeline() {
  // A time axis with three moments on it: the signal-grid motif, read as a
  // sequence rather than a snapshot.
  return (
    <svg {...base}>
      <path d="M2 8h12" />
      <circle cx="4" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="12" cy="8" r="1.4" />
      <path d="M8 3.5V6M12 10v2.5" />
    </svg>
  );
}
