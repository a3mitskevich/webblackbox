// jsdom has no layout: give the layout observers the panels and virtual lists use an inert
// stand-in, so components that measure themselves still mount in unit tests. Real sizes are
// covered by e2e:player in Chrome.
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class InertResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  window.ResizeObserver = InertResizeObserver;
}

// Panels and dialogs load lazily (their own chunks): under a parallel `pnpm test` the first
// import can take longer than testing-library's 1 s default for findBy* / waitFor.
if (typeof window !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 5_000 });
}
