import type { ProblemGroup } from "@webblackbox/player-sdk";

import "./feed.css";

import { formatOffset } from "../../../core/format.js";
import { Hint } from "../../components/hint.js";
import { Icon } from "../../components/icon.js";
import { useController, usePlayerState } from "../../context.js";
import { resolveSelectedEventId } from "../../controller.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { feedMessages, type FeedTranslator } from "./messages.js";
import { problemTitle, problemsCount } from "./problem-text.js";

type ProblemChipProps = {
  group: ProblemGroup;
  archive: LoadedArchive;
  selectedEventId: string | null;
  t: FeedTranslator;
  locale: string;
};

function describeTimes(
  group: ProblemGroup,
  archive: LoadedArchive,
  t: FeedTranslator,
  locale: string
): string {
  const at = (mono: number) => `${formatOffset(mono - archive.model.minMono, locale)} s`;
  return group.count === 1
    ? t("problemOnce", { first: at(group.firstMono) })
    : t("problemTimes", {
        count: group.count,
        first: at(group.firstMono),
        last: at(group.lastMono)
      });
}

function ProblemChip({ group, archive, selectedEventId, t, locale }: ProblemChipProps) {
  const controller = useController();
  const title = problemTitle(group, t);
  const current = group.occurrences.findIndex(
    (occurrence) => occurrence.eventId === selectedEventId
  );
  // Third-party noise says so (the mockup's "Failed to load ×6 third-party"); hosts are in the hint.
  const where = group.thirdParty ? t("thirdParty") : group.where;
  const hint = [
    describeTimes(group, archive, t, locale),
    group.hosts.length > 0 ? t("problemHosts", { hosts: group.hosts.join(", ") }) : "",
    group.count > 1 ? t("problemStepHint") : ""
  ]
    .filter(Boolean)
    .join("\n");

  // The first click jumps to the first occurrence; the next clicks walk through the others.
  const jump = (): void => {
    const index = current < 0 ? 0 : (current + 1) % group.occurrences.length;
    const occurrence = group.occurrences[index];
    const event = occurrence ? archive.model.eventById.get(occurrence.eventId) : undefined;

    if (!occurrence || !event) {
      return;
    }

    controller.selectEvent(
      event,
      t("announceProblem", {
        problem: title,
        index: index + 1,
        count: group.count,
        time: `${formatOffset(occurrence.mono - archive.model.minMono, locale)} s`
      })
    );
  };

  return (
    <li>
      <Hint label={hint}>
        <button
          type="button"
          className={["problem", current >= 0 ? "sel" : "", group.thirdParty ? "third" : ""]
            .filter(Boolean)
            .join(" ")}
          aria-pressed={current >= 0}
          onClick={jump}
          data-testid="problem-chip"
          data-problem-key={group.key}
          data-third-party={group.thirdParty}
        >
          {group.thirdParty ? null : <Icon name="error" />}
          <b>{title}</b>
          <span className="n">{t("repeatCount", { count: group.count })}</span>
          {where ? <span className="where">{where}</span> : null}
        </button>
      </Hint>
    </li>
  );
}

/**
 * The persistent problems strip above the stage (PROPOSAL §9 B, replaces Quick Triage): failures
 * grouped by player-sdk (`groupProblems`), first-party first. A chip jumps to the first
 * occurrence; clicking it again steps through the others. It never hides itself.
 */
export function ProblemsStrip() {
  const t = useFeatureI18n(feedMessages);
  const archive = usePlayerState((state) => state.archive);
  const locale = usePlayerState((state) => state.locale);
  const selectedEventId = usePlayerState((state) =>
    state.archive ? resolveSelectedEventId(state.archive, state.selection) : null
  );

  if (!archive) {
    return null;
  }

  const groups = archive.view.problems;

  return (
    <section className="problems" aria-label={t("problemsLabel")} data-testid="problems-strip">
      <span
        className={groups.length > 0 ? "problems-count" : "problems-count ok"}
        data-testid="problems-count"
      >
        {groups.length > 0 ? problemsCount(groups.length, locale, t) : t("noProblems")}
      </span>
      {groups.length > 0 ? (
        <ul className="problems-list">
          {groups.map((group) => (
            <ProblemChip
              key={group.key}
              group={group}
              archive={archive}
              selectedEventId={selectedEventId}
              t={t}
              locale={locale}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
