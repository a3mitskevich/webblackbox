import type { ReactElement } from "react";

/** 16 px stroke icons (currentColor), from the Replay mockups. */
const PATHS = {
  click: <path d="M5 2v9l2.5-2.2L9.3 13l1.8-.8-1.8-4.1H13z" />,
  nav: <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />,
  req: <path d="M2.5 5.5h9l-2.5-2.5M13.5 10.5h-9l2.5 2.5" />,
  error: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.8M8 10.8v.4" />
    </>
  ),
  ws: <path d="M5 2.5v11M5 2.5 2.5 5M5 2.5 7.5 5M11 13.5v-11M11 13.5 8.5 11M11 13.5l2.5-2.5" />,
  console: <path d="M3 4.5 6.5 8 3 11.5M8 11.5h5" />,
  storage: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  play: <path d="M5 3v10l8-5z" fill="currentColor" stroke="none" />,
  pause: <path d="M5 3h2v10H5zM9 3h2v10H9z" fill="currentColor" stroke="none" />,
  prev: <path d="M4 3v10M12 3 6 8l6 5z" />,
  next: <path d="M12 3v10M4 3l6 5-6 5z" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  system: (
    <>
      <rect x="2" y="3" width="12" height="8.5" rx="1.5" />
      <path d="M6 14h4M8 11.5V14" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.6" />
    </>
  ),
  tabs: (
    <>
      <rect x="2" y="4" width="12" height="9" rx="1.5" />
      <path d="M2 7h12M5 4V2.5h5V4" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
    </>
  ),
  filter: <path d="M2 3h12L9.5 8.5V13l-3-1.5v-3z" />,
  flag: <path d="M3.5 14V2.5M3.5 3h8l-2 3 2 3h-8" />,
  perf: <path d="M2 12.5h12M3.5 10l3-4 2.5 2.5L13 3.5" />,
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
  keyboard: (
    <>
      <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
      <path d="M4 7h1M7 7h1M10 7h1M5 10h6" />
    </>
  ),
  media: (
    <>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="m6.5 6 3.5 2-3.5 2z" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  back: <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

type IconProps = {
  name: IconName;
  className?: string;
};

export function Icon({ name, className = "ic" }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
