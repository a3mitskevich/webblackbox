import {
  AppWindow,
  ArrowDown,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Code,
  Copy,
  Database,
  File,
  FileText,
  Flag,
  Funnel,
  Info,
  Keyboard,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  MousePointer2,
  PanelsLeftRight,
  Pause,
  Play,
  RotateCcw,
  Rows3,
  Search,
  SkipBack,
  SkipForward,
  Sun,
  Terminal,
  Timer,
  X,
  type LucideIcon
} from "lucide-react";

/**
 * The player's icon set, from Lucide (tree-shaken per icon, inline SVG). The names are the
 * player's own (domain glyphs included: click, nav, req, ws all have a Lucide match), so a
 * feature asks for `"ws"`, not for a Lucide component.
 */
const ICONS = {
  click: MousePointer2,
  nav: ArrowRight,
  req: ArrowRightLeft,
  error: CircleAlert,
  ws: ArrowDownUp,
  console: Terminal,
  storage: Database,
  play: Play,
  pause: Pause,
  prev: SkipBack,
  next: SkipForward,
  search: Search,
  sun: Sun,
  moon: Moon,
  system: Monitor,
  lock: Lock,
  unlock: LockOpen,
  tabs: AppWindow,
  file: File,
  filter: Funnel,
  flag: Flag,
  keyboard: Keyboard,
  media: Clapperboard,
  close: X,
  back: ArrowLeft,
  layout: PanelsLeftRight,
  copy: Copy,
  replay: RotateCcw,
  widen: Maximize2,
  narrow: Minimize2,
  expand: ChevronRight,
  collapse: ChevronDown,
  sent: ArrowUp,
  received: ArrowDown,
  slowest: Timer,
  code: Code,
  report: FileText,
  info: Info,
  lanes: Rows3
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** Glyphs drawn solid (the play/pause button), the rest are 1.5 px strokes as in the mockups. */
const FILLED: ReadonlySet<IconName> = new Set(["play", "pause"]);

type IconProps = {
  name: IconName;
  className?: string;
  /** Pixel size; the CSS class sets the rendered size (`.ic` 16 px, `.ic-lg`). */
  size?: number;
};

export function Icon({ name, className = "ic", size = 16 }: IconProps) {
  const Glyph = ICONS[name];

  return (
    <Glyph
      className={className}
      size={size}
      strokeWidth={1.5}
      absoluteStrokeWidth
      fill={FILLED.has(name) ? "currentColor" : "none"}
      aria-hidden="true"
      focusable="false"
    />
  );
}
