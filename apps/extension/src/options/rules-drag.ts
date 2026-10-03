/** Rule ids in the order the rows are shown (indexes in `data-rule-index` refer to it). */
export function shownRuleIds(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-rule-index][data-rule-id]"),
    (row) => row.dataset.ruleId ?? ""
  );
}

export type RuleMove = (from: number, to: number, shownIds: string[]) => void;

/** Drag a rule by its grip onto another row; same reorder as the up/down buttons. */
export function bindRuleDragging(root: HTMLElement, onMove: RuleMove): void {
  let fromIndex = -1;
  const rowOf = (event: Event): HTMLElement | null =>
    (event.target as Element | null)?.closest<HTMLElement>("[data-rule-index]") ?? null;

  root.addEventListener("dragstart", (event) => {
    const handle = (event.target as Element | null)?.closest("[data-drag-handle]");
    const row = rowOf(event);

    if (!handle || !row) {
      return;
    }

    fromIndex = Number(row.dataset.ruleIndex);
    event.dataTransfer?.setData("text/plain", row.dataset.ruleId ?? "");
    row.classList.add("wb-rule--dragging");
  });
  root.addEventListener("dragover", (event) => {
    if (fromIndex >= 0 && rowOf(event)) {
      event.preventDefault();
    }
  });
  root.addEventListener("drop", (event) => {
    const row = rowOf(event);

    if (fromIndex < 0 || !row) {
      return;
    }

    event.preventDefault();
    const from = fromIndex;
    fromIndex = -1;
    onMove(from, Number(row.dataset.ruleIndex), shownRuleIds(root));
  });
  root.addEventListener("dragend", () => {
    fromIndex = -1;
    root
      .querySelectorAll(".wb-rule--dragging")
      .forEach((row) => row.classList.remove("wb-rule--dragging"));
  });
}
