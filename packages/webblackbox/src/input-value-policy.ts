import type { CapturePolicy, RedactionProfile } from "@webblackbox/protocol";

/** Longest raw input value kept on a `user.input` event. */
export const MAX_CAPTURED_INPUT_VALUE_CHARS = 1_000;

type EditableField = HTMLInputElement | HTMLTextAreaElement;

const NEVER_CAPTURED_AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year"
]);
const PASSWORD_LIKE_NAME_PATTERN = /passw(?:or)?d|pwd|passcode/i;

type PasswordFieldRegistry = {
  /**
   * Fields seen as `type="password"` at least once. A "show password" toggle switches the type
   * to `text`, so the current type alone cannot tell a revealed password from a text field.
   */
  fields: WeakSet<Element>;
  /** Live reveal watchers; their queued records are read before any value is captured. */
  watchers: Set<MutationObserver>;
  /** One shared watcher per observed root, so repeated content script loads do not pile up. */
  rootWatchers: WeakMap<Node, { observer: MutationObserver; users: number }>;
};

/**
 * Shared by every bundle in the same JavaScript realm: the extension's content script watches
 * from page load, while the capture agent that reads values is a separately loaded bundle.
 * When the SDK runs in the page's own realm the page could plant a fake registry, so anything
 * but genuine collections is replaced (and a live `type="password"` is always checked directly).
 */
const PASSWORD_FIELD_REGISTRY_KEY = Symbol.for("webblackbox.passwordFieldRegistry");
const registry = resolvePasswordFieldRegistry();
const seenPasswordFields = registry.fields;
const revealWatchers = registry.watchers;

function resolvePasswordFieldRegistry(): PasswordFieldRegistry {
  const holder = globalThis as typeof globalThis & {
    [PASSWORD_FIELD_REGISTRY_KEY]?: unknown;
  };
  const existing = holder[PASSWORD_FIELD_REGISTRY_KEY] as Partial<PasswordFieldRegistry> | null;

  if (
    existing?.fields instanceof WeakSet &&
    existing.watchers instanceof Set &&
    existing.rootWatchers instanceof WeakMap
  ) {
    return existing as PasswordFieldRegistry;
  }

  const created: PasswordFieldRegistry = {
    fields: new WeakSet<Element>(),
    watchers: new Set<MutationObserver>(),
    rootWatchers: new WeakMap()
  };

  try {
    Object.defineProperty(holder, PASSWORD_FIELD_REGISTRY_KEY, {
      value: created,
      configurable: true
    });
  } catch {
    // A non-configurable planted value: keep this bundle's own registry.
  }

  return created;
}

/**
 * Remembers every field the page switches away from `type="password"` (a "show password"
 * toggle), even when nobody typed while it was hidden. Returns the disconnect function.
 */
export function watchPasswordFieldReveals(root: Node): () => void {
  if (typeof MutationObserver === "undefined") {
    return () => undefined;
  }

  const shared = registry.rootWatchers.get(root) ?? createRootWatcher(root);
  let stopped = false;

  shared.users += 1;

  return () => {
    if (stopped) {
      return;
    }

    stopped = true;
    shared.users -= 1;

    if (shared.users === 0) {
      registry.rootWatchers.delete(root);
      revealWatchers.delete(shared.observer);
      shared.observer.disconnect();
    }
  };
}

function createRootWatcher(root: Node): { observer: MutationObserver; users: number } {
  const observer = new MutationObserver(rememberRevealedFields);
  const shared = { observer, users: 0 };

  observer.observe(root, {
    attributes: true,
    attributeFilter: ["type"],
    attributeOldValue: true,
    subtree: true
  });
  revealWatchers.add(observer);
  registry.rootWatchers.set(root, shared);
  return shared;
}

function rememberRevealedFields(records: readonly MutationRecord[]): void {
  for (const record of records) {
    if (record.oldValue?.toLowerCase() === "password" && record.target instanceof Element) {
      seenPasswordFields.add(record.target);
    }
  }
}

/** Remembers a password field before the page can reveal it (call on keydown/focus). */
export function notePasswordField(target: EventTarget | null): void {
  if (target instanceof HTMLInputElement && target.type.toLowerCase() === "password") {
    seenPasswordFields.add(target);
  }
}

/**
 * Raw value of an edited field when the capture policy allows it, otherwise undefined.
 *
 * - `inputs: "allow"` keeps values except on fields matching a blocked selector (field or ancestor)
 *   that no unmask selector re-allows.
 * - `inputs: "masked"` keeps values only on fields that match an unmask selector.
 * - An unmask selector re-allows a field only when it matches at least as close to the field as
 *   the nearest blocked selector: `form.checkout` does not unmask `[data-sensitive]` inside it.
 * - Password, one-time-code and payment card fields are never captured, whatever the profile says.
 */
export function readCapturableInputValue(
  field: EditableField,
  policy: CapturePolicy
): string | undefined {
  const level = policy.categories.inputs;

  // A reveal in the same task as this read has not reached the observer callback yet.
  for (const watcher of revealWatchers) {
    rememberRevealedFields(watcher.takeRecords());
  }

  notePasswordField(field);

  if ((level !== "allow" && level !== "masked") || isNeverCapturedField(field)) {
    return undefined;
  }

  const unmaskedAt = nearestMatch(field, policy.redaction.unmaskSelectors ?? [], false);
  const blockedAt = nearestMatch(field, policy.redaction.blockedSelectors, true);
  const unmasked = unmaskedAt !== null && (blockedAt === null || blockedAt.contains(unmaskedAt));

  if (!unmasked && (level === "masked" || blockedAt !== null)) {
    return undefined;
  }

  return field.value.slice(0, MAX_CAPTURED_INPUT_VALUE_CHARS);
}

/**
 * True when a blocked selector covers the element (itself or an ancestor) and no unmask selector
 * re-allows it at least as close to the element. Invalid blocked selectors fail closed.
 */
export function isCoveredByBlockedSelector(element: Element, redaction: RedactionProfile): boolean {
  const blockedAt = nearestMatch(element, redaction.blockedSelectors, true);

  if (blockedAt === null) {
    return false;
  }

  const unmaskedAt = nearestMatch(element, redaction.unmaskSelectors ?? [], false);
  return unmaskedAt === null || !blockedAt.contains(unmaskedAt);
}

function isNeverCapturedField(field: EditableField): boolean {
  const isPasswordNow =
    field instanceof HTMLInputElement && field.type.toLowerCase() === "password";

  if (isPasswordNow || seenPasswordFields.has(field)) {
    return true;
  }

  if (PASSWORD_LIKE_NAME_PATTERN.test(`${field.name} ${field.id}`)) {
    return true;
  }

  const autocomplete = (field.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  return autocomplete.some((token) => NEVER_CAPTURED_AUTOCOMPLETE_TOKENS.has(token));
}

/**
 * Closest element (the field or an ancestor) matching any selector, or null. An invalid selector
 * counts as matching the field itself when `invalidMatchesField` is set, so blocks fail closed,
 * and as no match otherwise, so it unmasks nothing.
 */
function nearestMatch(
  field: Element,
  selectors: readonly string[],
  invalidMatchesField: boolean
): Element | null {
  let nearest: Element | null = null;

  for (const selector of selectors) {
    let match: Element | null;

    try {
      match = field.closest(selector);
    } catch {
      match = invalidMatchesField ? field : null;
    }

    if (match && (nearest === null || nearest.contains(match))) {
      nearest = match;
    }
  }

  return nearest;
}
