// jsdom has no layout: give the layout observers the panels and virtual lists use an inert
// stand-in, so components that measure themselves still mount in unit tests. Real sizes are
// covered by e2e:player-next in Chrome.
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class InertResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  window.ResizeObserver = InertResizeObserver;
}
