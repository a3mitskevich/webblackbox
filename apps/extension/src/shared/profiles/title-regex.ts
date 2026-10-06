/**
 * Title rules match with the shared linear-time engine (`@webblackbox/protocol/linear-regex`):
 * title regexes come from users, imported files and managed policy and run in the service worker
 * on every navigation, so they must never backtrack. Backreferences and lookarounds are rejected.
 */
import { compileLinearRegex } from "@webblackbox/protocol/linear-regex";

/** Longest page title a title regex is tested against. */
export const MAX_MATCHED_TITLE_LENGTH = 256;

export type TitleMatcher = (title: string) => boolean;

/** The matcher for `source` (case-insensitive), or null when it is invalid or unsupported. */
export function compileTitleRegex(source: string): TitleMatcher | null {
  const regex = compileLinearRegex(source);

  return regex ? (title) => regex.test(title.slice(0, MAX_MATCHED_TITLE_LENGTH)) : null;
}
