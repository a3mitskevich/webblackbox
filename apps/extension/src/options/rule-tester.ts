import type {
  ProfileRule,
  RecordingProfile,
  RecordingProfilesStore
} from "../shared/profiles/model.js";
import { selectRecordingProfile } from "../shared/profiles/resolve.js";
import { matchesHostPattern, matchesPathGlob } from "../shared/profiles/rules.js";
import type { ProfilesState } from "../shared/profiles/storage.js";

/**
 * "Test URL" for the rules editor: which profile Start would use for a URL with the unsaved
 * draft, and why. Uses the service worker's selection logic; rules that depend on page signals
 * (selector present, meta tag) cannot be checked from a URL and are reported as such.
 */

export type RuleConditionKind =
  | "any"
  | "host"
  | "path"
  | "query"
  | "title"
  | "incognito-only"
  | "incognito-never";

export type RuleTestResult =
  | { kind: "invalid-url" }
  /** Every profile was deleted: Start has nothing to record with. */
  | { kind: "no-profile" }
  | {
      kind: "selected";
      profileName: string;
      source: "rule" | "default";
      rule?: {
        label: string;
        priority: number;
        conditions: Array<{ kind: RuleConditionKind; value: string }>;
      };
      /** Enabled rules that need page signals and are assumed not to match here. */
      unchecked: string[];
    };

export type RuleTestInput = {
  state: ProfilesState;
  draft: RecordingProfilesStore;
  catalog: RecordingProfile[];
  url: string;
  title?: string;
  /** Test as an incognito window (rules can require or exclude one). */
  incognito?: boolean;
};

export function ruleLabel(rule: ProfileRule): string {
  return rule.name?.trim() || rule.id;
}

export function testRulesForUrl(input: RuleTestInput): RuleTestResult {
  const url = parseHttpUrl(input.url);

  if (!url) {
    return { kind: "invalid-url" };
  }

  const managedRuleCount = input.state.rules.length - input.state.store.rules.length;
  const rules = [
    ...input.state.rules.slice(0, Math.max(0, managedRuleCount)),
    ...input.draft.rules
  ];
  const selection = selectRecordingProfile({
    state: { ...input.state, store: input.draft, legacy: false, catalog: input.catalog, rules },
    page: {
      url: url.href,
      incognito: input.incognito === true,
      ...(input.title ? { title: input.title } : {})
    }
  });

  if (!selection) {
    return { kind: "no-profile" };
  }

  const rule = selection.rule ? rules.find((entry) => entry.id === selection.rule?.id) : undefined;

  return {
    kind: "selected",
    profileName: selection.profile.name,
    source: rule ? "rule" : "default",
    ...(rule
      ? {
          rule: {
            label: ruleLabel(rule),
            priority: rule.priority,
            conditions: describeMatchedConditions(rule, url, input.title)
          }
        }
      : {}),
    unchecked: rules
      .filter((entry) => entry.enabled && (entry.match.selectorPresent || entry.match.metaTag))
      .map(ruleLabel)
  };
}

function describeMatchedConditions(
  rule: ProfileRule,
  url: URL,
  title: string | undefined
): Array<{ kind: RuleConditionKind; value: string }> {
  const { match } = rule;
  const host = match.hosts?.find((pattern) => matchesHostPattern(url, pattern));
  const path = match.paths?.find((pattern) => matchesPathGlob(url.pathname, pattern));
  const conditions: Array<{ kind: RuleConditionKind; value: string }> = [
    ...(host ? [{ kind: "host" as const, value: host }] : []),
    ...(path ? [{ kind: "path" as const, value: path }] : []),
    ...Object.entries(match.query ?? {}).map(([key, expected]) => ({
      kind: "query" as const,
      value: expected === true ? key : `${key}=${expected}`
    })),
    ...(match.titleRegex !== undefined && title !== undefined
      ? [{ kind: "title" as const, value: match.titleRegex }]
      : []),
    ...(typeof match.incognito === "boolean"
      ? [
          {
            kind: match.incognito ? ("incognito-only" as const) : ("incognito-never" as const),
            value: ""
          }
        ]
      : [])
  ];

  return conditions.length > 0 ? conditions : [{ kind: "any", value: "" }];
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
