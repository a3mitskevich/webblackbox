/** Small DOM builders shared by the extension pages (no innerHTML: values are user data). */

export type ElementOptions = {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
};

export function el<TTag extends keyof HTMLElementTagNameMap>(
  tag: TTag,
  options: ElementOptions = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[TTag] {
  const element = document.createElement(tag);

  if (options.className) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    element.setAttribute(name, value);
  }

  Object.assign(element.dataset, options.dataset ?? {});
  element.append(...children);
  return element;
}

let nextId = 0;

/** Document-unique id for label/description wiring. */
export function uniqueId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}
