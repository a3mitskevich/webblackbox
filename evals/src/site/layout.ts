// The fixture is a small, ordinary-looking shop: every scenario page shares this layout, so a
// recording looks like a real product and nothing in the markup names the seeded bug.

export const SHOP_NAME = "Northwind Shop";

const BASE_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: #1d2433; background: #f6f7f9; }
  header { display: flex; gap: 20px; align-items: center; padding: 12px 24px; background: #1d2433; }
  header a { color: #f6f7f9; text-decoration: none; }
  header .brand { font-weight: 700; margin-right: auto; }
  main { max-width: 760px; margin: 24px auto; padding: 24px; background: #fff; border-radius: 8px; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input { width: 100%; padding: 8px 10px; border: 1px solid #c4cad4; border-radius: 6px; font: inherit; }
  button { margin-top: 16px; padding: 9px 18px; border: 0; border-radius: 6px; background: #2457d6;
    color: #fff; font: inherit; cursor: pointer; }
  button:disabled { background: #9aa6bd; cursor: not-allowed; }
  .muted { color: #6a7385; }
  .row { display: flex; gap: 12px; align-items: center; }
`;

export type PageOptions = {
  title: string;
  body: string;
  script?: string;
  style?: string;
  /** Script URLs loaded after the inline script. */
  scriptSrc?: readonly string[];
};

/** A complete HTML page in the shop layout. */
export function renderPage({ title, body, script, style, scriptSrc = [] }: PageOptions): string {
  const inline = script ? `<script>${script}</script>` : "";
  const external = scriptSrc.map((src) => `<script src="${src}"></script>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · ${SHOP_NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_STYLE}${style ?? ""}</style></head>
<body><header><a class="brand" href="/">${SHOP_NAME}</a><a href="/catalog/">Catalog</a>
<a href="/cart/">Cart</a><a href="/account/">Account</a></header>
<main>${body}</main>${inline}${external}</body></html>`;
}
