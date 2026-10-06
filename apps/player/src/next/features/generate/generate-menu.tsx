import { Menu } from "@base-ui/react/menu";
import {
  ChevronDown,
  CircleDot,
  ClipboardCopy,
  CodeXml,
  FileText,
  FlaskConical,
  Layers,
  Network,
  Ticket,
  type LucideIcon
} from "lucide-react";

import { toastManager } from "../../components/toasts.js";
import { useController, usePlayerState } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { copyToClipboard } from "../network/copy-button.js";
import { openGenerate, type GenerateKind } from "./api.js";
import { buildBugReport } from "./generators.js";
import { generateMessages, type GenerateMessageKey } from "./messages.js";
import { formatRangeLabel } from "./range.js";

const ICON_PROPS = { size: 16, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };

type MenuEntry = {
  kind: GenerateKind;
  label: GenerateMessageKey;
  icon: LucideIcon;
  testId: string;
};

/** The generators in menu order (PROPOSAL §1 scenario 9; the classic export toolbar). */
export const GENERATE_MENU_ENTRIES: readonly MenuEntry[] = [
  {
    kind: "playwright",
    label: "itemPlaywright",
    icon: FlaskConical,
    testId: "generate-playwright"
  },
  {
    kind: "playwright-mocks",
    label: "itemPlaywrightMocks",
    icon: Layers,
    testId: "generate-playwright-mocks"
  },
  { kind: "bug-report", label: "itemBugReport", icon: FileText, testId: "generate-bug-report" },
  { kind: "har", label: "itemHar", icon: Network, testId: "generate-har" },
  {
    kind: "github-issue",
    label: "itemGitHubIssue",
    icon: CircleDot,
    testId: "generate-github-issue"
  },
  { kind: "jira-issue", label: "itemJiraIssue", icon: Ticket, testId: "generate-jira-issue" }
];

/**
 * Header "Generate ▾" (Base UI `Menu`): opens a generator dialog for the timeline range (or the
 * whole session), and copies the bug report in one step (the classic triage shortcut).
 */
export function GenerateMenu() {
  const controller = useController();
  const t = useFeatureI18n(generateMessages);
  const archive = usePlayerState((state) => state.archive);
  const range = usePlayerState((state) => state.range);
  const locale = usePlayerState((state) => state.locale);

  if (!archive) {
    return null;
  }

  const rangeLabel = formatRangeLabel(range, archive.model.minMono, locale);

  const copyBugReport = async (): Promise<void> => {
    const ok = await copyToClipboard(buildBugReport(archive, range));
    toastManager.add({
      title: ok ? t("bugReportCopied") : t("bugReportCopyFailed"),
      description: rangeLabel ?? t("menuWholeSession")
    });
  };

  return (
    <Menu.Root>
      <Menu.Trigger className="btn" aria-label={t("menuLabel")} data-testid="generate-button">
        <CodeXml {...ICON_PROPS} />
        <span className="lbl hide-narrow">{t("generate")}</span>
        <ChevronDown {...ICON_PROPS} size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="menu-layer">
          <Menu.Popup className="menu" data-testid="generate-menu">
            <div className="menu-note" data-testid="generate-menu-range">
              {rangeLabel ? t("menuRange", { range: rangeLabel }) : t("menuWholeSession")}
            </div>
            {GENERATE_MENU_ENTRIES.map((entry) => {
              const Glyph = entry.icon;

              return (
                <Menu.Item
                  key={entry.kind}
                  className="menu-item"
                  onClick={() => openGenerate(controller.store, { kind: entry.kind })}
                  data-testid={entry.testId}
                >
                  <Glyph {...ICON_PROPS} />
                  {t(entry.label)}
                </Menu.Item>
              );
            })}
            <Menu.Separator className="menu-sep" />
            <Menu.Item
              className="menu-item"
              onClick={() => void copyBugReport()}
              data-testid="generate-copy-bug-report"
            >
              <ClipboardCopy {...ICON_PROPS} />
              {t("itemCopyBugReport")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
