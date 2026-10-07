// e2e:player scenarios of the extension guide (task 50): the guide opens from the empty state
// and the header menu without an archive, and the bundled extension download actually resolves
// (HTTP 200) in the built player — the build's bundle-extension.mjs step put it there.
export default {
  feature: "extension-guide",
  scenarios: [
    {
      name: "open the guide from the empty state; the download link resolves",
      async run(ctx) {
        await ctx.client.send("Page.navigate", { url: `${ctx.origin}/?lang=en` });
        await ctx.waitForSelector(ctx.testId("empty-state"), "The empty state did not render");
        await ctx.click("empty-extension-guide");
        await ctx.waitForSelector(
          ctx.testId("extension-guide"),
          "The extension guide did not open"
        );

        const state = await ctx.evaluate(`(async () => {
          const q = (id) => document.querySelector('[data-testid="' + id + '"]');
          const link = q("extension-download-link");
          const missing = q("extension-download-missing");
          const result = {
            missing: Boolean(missing),
            missingText: missing?.textContent ?? "",
            version: q("extension-version")?.textContent ?? "",
            sha256: q("extension-sha256")?.textContent ?? "",
            playerUrl: q("player-url")?.textContent ?? "",
            status: null,
            bytes: 0
          };
          if (link) {
            const response = await fetch(new URL(link.getAttribute("href"), location.href));
            result.status = response.status;
            result.bytes = (await response.arrayBuffer()).byteLength;
          }
          return result;
        })()`);

        ctx.assert(
          !state.missing,
          "The built player has no bundled extension (the build warned about it): run " +
            "`pnpm --filter @webblackbox/extension package:chrome` first, then rebuild the player",
          state
        );
        ctx.assert(state.status === 200, "The extension download link did not resolve", state);
        ctx.assert(state.bytes > 10_000, "The extension download is suspiciously small", state);
        ctx.assert(
          /^Version \d+\.\d+\.\d+ · /u.test(state.version),
          "The download facts do not show the metadata",
          state
        );
        ctx.assert(/^[0-9a-f]{64}$/u.test(state.sha256), "No SHA-256 shown", state);
        ctx.assert(
          state.playerUrl.startsWith("http://127.0.0.1:"),
          "The guide shows a wrong Player URL",
          state
        );

        await ctx.press("Escape", { code: "Escape", keyCode: 27 });
        return { status: state.status, bytes: state.bytes, version: state.version };
      }
    },
    {
      name: "open the guide from the header menu with an archive loaded",
      async run(ctx) {
        await ctx.openSynthetic();
        await ctx.click("player-menu");
        await ctx.waitForSelector(
          ctx.testId("menu-extension-guide"),
          "The guide menu item is missing"
        );
        await ctx.click("menu-extension-guide");
        await ctx.waitForSelector(
          ctx.testId("extension-guide"),
          "The extension guide did not open over the workspace"
        );
        // The workspace stays behind the dialog; Esc returns to it.
        await ctx.press("Escape", { code: "Escape", keyCode: 27 });
        const restored = await ctx.evaluate(
          `!document.querySelector('${ctx.testId("extension-guide")}') && Boolean(document.querySelector('${ctx.testId("stage")}'))`
        );
        ctx.assert(restored, "Esc did not close the guide over the workspace");
        return { ok: true };
      }
    }
  ]
};
