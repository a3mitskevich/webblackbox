type NavigatorWithUaData = Pick<Navigator, "platform"> & {
  userAgentData?: { platform?: string };
};

/** macOS / iOS, where the palette key is ⌘K (the keymap binds both Ctrl+K and Meta+K). */
export function isApplePlatform(
  nav: NavigatorWithUaData | undefined = globalThis.navigator
): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The command palette's key as the user presses it on this platform. */
export function paletteKeyLabel(nav?: NavigatorWithUaData): string {
  return isApplePlatform(nav) ? "⌘K" : "Ctrl K";
}
