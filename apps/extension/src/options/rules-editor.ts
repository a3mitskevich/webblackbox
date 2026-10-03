import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { ProfileRule, RecordingProfile } from "../shared/profiles/model.js";
import { MAX_RULE_PRIORITY, MIN_RULE_PRIORITY } from "../shared/profiles/model.js";
import { icon } from "../shared/ui/icons.js";
import { button, el, iconButton } from "./dom.js";
import {
  chipListField,
  fieldGroup,
  numberField,
  selectField,
  textField,
  toggleField
} from "./fields.js";
import { chipListOptions, patternValidator } from "./profile-form.js";
import { formatQueryLines } from "./profile-form-model.js";
import { ruleLabel, type RuleConditionKind, type RuleTestResult } from "./rule-tester.js";

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

const CONDITION_LABELS: Record<RuleConditionKind, ExtensionMessageKey> = {
  any: "optionsTestConditionAny",
  host: "optionsTestConditionHost",
  path: "optionsTestConditionPath",
  query: "optionsTestConditionQuery",
  title: "optionsTestConditionTitle"
};

export type RulesViewOptions = {
  /** Rules in display (= evaluation) order. */
  rules: readonly ProfileRule[];
  catalog: readonly RecordingProfile[];
  openRuleIds: ReadonlySet<string>;
  extendedCaptureHosts: readonly string[];
  test: { url: string; title: string; result?: RuleTestResult };
  t: Translate;
};

function profileOptions(
  rule: ProfileRule,
  catalog: readonly RecordingProfile[],
  t: Translate
): Array<{ value: string; label: string }> {
  const options = catalog.map((profile) => ({ value: profile.id, label: profile.name }));

  // A rule may target a profile that was deleted or dropped from managed policy; keep its id
  // selectable so the next sync does not blank it and block saving.
  return catalog.some((profile) => profile.id === rule.profileId)
    ? options
    : [
        ...options,
        { value: rule.profileId, label: t("optionsRuleProfileMissing", { id: rule.profileId }) }
      ];
}

function describeRuleSummary(rule: ProfileRule, t: Translate): string {
  const { match } = rule;
  const hosts = match.hosts ?? [];
  const parts = [
    ...hosts.slice(0, 2),
    ...(hosts.length > 2 ? [`+${hosts.length - 2}`] : []),
    ...(match.paths ?? []).slice(0, 1),
    ...(match.query ? [`?${formatQueryLines(match.query).split("\n").join("&")}`] : []),
    ...(match.titleRegex ? [`title /${match.titleRegex}/`] : []),
    ...(match.selectorPresent ? [match.selectorPresent] : []),
    ...(match.metaTag ? [`meta ${match.metaTag.name}`] : [])
  ];
  return parts.length > 0 ? parts.join(" · ") : t("optionsRuleMatchesAll");
}

function createRuleBody(rule: ProfileRule, options: RulesViewOptions): HTMLElement {
  const { t } = options;
  const list = chipListOptions(t);
  const chips = (
    name: string,
    label: ExtensionMessageKey,
    values: string[],
    placeholder: ExtensionMessageKey
  ): HTMLElement =>
    chipListField({
      ...list,
      id: `${rule.id}-${name}`,
      name,
      label: t(label),
      values,
      placeholder: t(placeholder),
      validate: patternValidator(t)
    });
  const text = (suffix: string, name: string, label: ExtensionMessageKey, value: string) =>
    textField({ id: `${rule.id}-${suffix}`, name, label: t(label), value, mono: true });

  const body = el("div", { className: "wb-rule__body", attrs: { id: `${rule.id}-body` } }, [
    fieldGroup(null, [
      textField({
        id: `${rule.id}-name`,
        name: "ruleName",
        label: t("optionsRuleName"),
        value: rule.name ?? ""
      }),
      selectField({
        id: `${rule.id}-profile`,
        name: "ruleProfile",
        label: t("optionsRuleProfile"),
        value: rule.profileId,
        options: profileOptions(rule, options.catalog, t)
      }),
      numberField({
        id: `${rule.id}-priority`,
        name: "rulePriority",
        label: t("optionsRulePriority"),
        hint: t("optionsRulePriorityHint"),
        value: String(rule.priority),
        min: MIN_RULE_PRIORITY,
        max: MAX_RULE_PRIORITY
      }),
      selectField({
        id: `${rule.id}-incognito`,
        name: "ruleIncognito",
        label: t("optionsRuleIncognito"),
        value: rule.match.incognito === undefined ? "any" : rule.match.incognito ? "only" : "never",
        options: [
          { value: "any", label: t("optionsRuleIncognitoAny") },
          { value: "only", label: t("optionsRuleIncognitoOnly") },
          { value: "never", label: t("optionsRuleIncognitoNever") }
        ]
      }),
      toggleField({
        id: `${rule.id}-enabled`,
        name: "ruleEnabled",
        label: t("optionsRuleEnabled"),
        checked: rule.enabled
      })
    ]),
    fieldGroup(t("optionsRuleGroupUrl"), [
      chips(
        "ruleHosts",
        "optionsRuleHosts",
        [...(rule.match.hosts ?? [])],
        "optionsHostPlaceholder"
      ),
      chips(
        "rulePaths",
        "optionsRulePaths",
        [...(rule.match.paths ?? [])],
        "optionsPathPlaceholder"
      ),
      chips(
        "ruleQuery",
        "optionsRuleQuery",
        formatQueryLines(rule.match.query).split("\n").filter(Boolean),
        "optionsQueryPlaceholder"
      )
    ]),
    fieldGroup(t("optionsRuleGroupPage"), [
      text("title-regex", "ruleTitleRegex", "optionsRuleTitleRegex", rule.match.titleRegex ?? ""),
      text("selector", "ruleSelector", "optionsRuleSelector", rule.match.selectorPresent ?? ""),
      text("meta-name", "ruleMetaName", "optionsRuleMetaName", rule.match.metaTag?.name ?? ""),
      text("meta-value", "ruleMetaValue", "optionsRuleMetaValue", rule.match.metaTag?.value ?? "")
    ])
  ]);
  body.hidden = !options.openRuleIds.has(rule.id);
  return body;
}

function createRuleRow(rule: ProfileRule, index: number, options: RulesViewOptions): HTMLElement {
  const { t } = options;
  const open = options.openRuleIds.has(rule.id);
  const profileName =
    options.catalog.find((profile) => profile.id === rule.profileId)?.name ?? rule.profileId;
  const grip = el(
    "span",
    {
      className: "wb-rule__grip",
      attrs: { draggable: "true", title: t("optionsRuleDrag"), "aria-hidden": "true" },
      dataset: { dragHandle: "" }
    },
    [icon("grip")]
  );

  return el(
    "li",
    {
      className: rule.enabled
        ? "wb-rule wb-profiles__rule"
        : "wb-rule wb-rule--off wb-profiles__rule",
      dataset: { ruleId: rule.id, ruleIndex: String(index) }
    },
    [
      el("div", { className: "wb-rule__bar" }, [
        grip,
        el("span", { className: "wb-rule__rank", text: String(index + 1) }),
        el(
          "button",
          {
            className: "wb-rule__toggle",
            attrs: {
              type: "button",
              "aria-expanded": String(open),
              "aria-controls": `${rule.id}-body`
            },
            dataset: { action: "rule-toggle" }
          },
          [
            el("strong", { text: ruleLabel(rule) }),
            el("span", { className: "wb-rule__arrow", text: `→ ${profileName}` }),
            el("span", { className: "wb-rule__summary", text: describeRuleSummary(rule, t) })
          ]
        ),
        ...(rule.enabled
          ? []
          : [el("span", { className: "wb-badge", text: t("optionsRuleDisabledBadge") })]),
        iconButton(t("optionsRuleMoveUp"), "rule-up", "up", { disabled: index === 0 }),
        iconButton(t("optionsRuleMoveDown"), "rule-down", "down", {
          disabled: index === options.rules.length - 1
        }),
        iconButton(t("optionsRuleDelete"), "rule-delete", "trash", { danger: true })
      ]),
      createRuleBody(rule, options)
    ]
  );
}

export function createRulesList(options: RulesViewOptions): HTMLElement {
  const { t } = options;
  const list = el("ol", { className: "wb-rules" });

  if (options.rules.length === 0) {
    list.append(el("li", { className: "wb-empty", text: t("optionsRulesEmpty") }));
  }

  options.rules.forEach((rule, index) => list.append(createRuleRow(rule, index, options)));

  return el("div", { className: "wb-rules-panel" }, [
    el("div", { className: "wb-panel-head" }, [
      el("h3", { className: "wb-group__title", text: t("optionsRulesListTitle") }),
      button(t("optionsRuleAdd"), "rule-add", "surface", { small: true })
    ]),
    list,
    chipListField({
      ...chipListOptions(t),
      id: "extended-capture-hosts",
      name: "extendedCaptureHosts",
      label: t("optionsExtendedHosts"),
      hint: t("optionsExtendedHostsHint"),
      values: options.extendedCaptureHosts,
      placeholder: t("optionsHostPlaceholder"),
      validate: patternValidator(t)
    })
  ]);
}

export function createRuleTester(options: RulesViewOptions): HTMLElement {
  const { t } = options;

  return el("aside", { className: "wb-tester", attrs: { "aria-labelledby": "rule-test-title" } }, [
    el("h3", {
      className: "wb-group__title",
      text: t("optionsTestTitle"),
      attrs: { id: "rule-test-title" }
    }),
    textField({
      id: "rule-test-url",
      name: "testUrl",
      label: t("optionsTestUrl"),
      value: options.test.url,
      placeholder: "https://app.stage.example.com/admin?env=qa",
      mono: true
    }),
    textField({
      id: "rule-test-title-input",
      name: "testTitle",
      label: t("optionsTestPageTitle"),
      hint: t("optionsTestPageTitleHint"),
      value: options.test.title
    }),
    el(
      "output",
      {
        className: "wb-tester__result",
        attrs: { for: "rule-test-url", "aria-live": "polite" },
        dataset: { ruleTestResult: "" }
      },
      describeTestResult(options.test.result, t)
    )
  ]);
}

/** Lines explaining which profile a tested URL gets and why. */
export function describeTestResult(
  result: RuleTestResult | undefined,
  t: Translate
): HTMLElement[] {
  if (!result) {
    return [el("p", { className: "wb-field__hint", text: t("optionsTestIdle") })];
  }

  if (result.kind === "invalid-url") {
    return [el("p", { className: "wb-tester__error", text: t("optionsTestInvalidUrl") })];
  }

  const lines: HTMLElement[] = [
    el("p", { className: "wb-tester__verdict" }, [
      t("optionsTestProfile"),
      " ",
      el("strong", { text: result.profileName })
    ])
  ];

  if (result.rule) {
    lines.push(
      el("p", {
        text: t("optionsTestByRule", { rule: result.rule.label, priority: result.rule.priority })
      }),
      el(
        "ul",
        { className: "wb-tester__conditions" },
        result.rule.conditions.map((condition) =>
          el("li", {}, [
            t(CONDITION_LABELS[condition.kind]),
            ...(condition.value ? [" ", el("code", { text: condition.value })] : [])
          ])
        )
      )
    );
  } else {
    lines.push(el("p", { text: t("optionsTestNoRule") }));
  }

  if (result.downgradedFrom) {
    lines.push(
      el("p", {
        className: "wb-tester__warn",
        text: t("optionsTestDowngraded", {
          requested: result.downgradedFrom,
          name: result.profileName
        })
      })
    );
  }

  if (result.unchecked.length > 0) {
    lines.push(
      el("p", {
        className: "wb-field__hint",
        text: t("optionsTestUnchecked", { rules: result.unchecked.join(", ") })
      })
    );
  }

  return lines;
}
