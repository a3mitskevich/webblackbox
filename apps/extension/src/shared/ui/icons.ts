/** 16px stroke icons built with the DOM API (no innerHTML). */

const SVG_NS = "http://www.w3.org/2000/svg";

const ICON_PATHS = {
  sessions: ["M3 4h10", "M3 8h10", "M3 12h6"],
  settings: ["M2.5 4.5h6", "M11.5 4.5h2", "M2.5 11.5h2", "M7.5 11.5h6", "M10 3v3", "M6 10v3"],
  marker: ["M4 14V2.5", "M4 3h7.5l-1.8 2.5L11.5 8H4"],
  stop: ["M4.5 4.5h7v7h-7z"],
  play: ["M5 3.5v9l7-4.5z"],
  download: ["M8 2.5v8", "M4.5 7.5 8 11l3.5-3.5", "M3 13.5h10"],
  external: ["M9.5 2.5h4v4", "M13.5 2.5 7.5 8.5", "M12 9.5v4H2.5V4H6.5"],
  up: ["M4 10l4-4 4 4"],
  down: ["M4 6l4 4 4-4"],
  grip: ["M6 4h.01", "M10 4h.01", "M6 8h.01", "M10 8h.01", "M6 12h.01", "M10 12h.01"],
  trash: ["M3 4.5h10", "M6.5 4.5V3h3v1.5", "M4.5 4.5l.7 9h5.6l.7-9"],
  close: ["M4 4l8 8", "M12 4l-8 8"]
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("wb-icon");

  for (const data of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }

  return svg;
}
