import uFuzzy from "@leeoniya/ufuzzy";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { useDeferredValue, useMemo, useState } from "react";

import { formatOffset } from "../../core/format.js";
import { searchPalette } from "../../core/palette-search.js";
import { nextThemePreference } from "../../core/preferences.js";
import { PLAYER_LOCALES, type PlayerI18n } from "../../lib/i18n.js";
import { compactText } from "../../lib/text.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import type { PlayerController } from "../controller.js";
import { describeFeedEvent } from "../features/feed/feed-view.js";
import { openGenerate } from "../features/generate/api.js";
import { GENERATE_MENU_ENTRIES } from "../features/generate/generate-menu.js";
import { generateMessages } from "../features/generate/messages.js";
import { eventTitle, shortPath } from "../features/inspector/inspector-text.js";
import { RAIL_TAB_ORDER } from "../features/registry.js";
import type { LoadedArchive, PlayerState } from "../state.js";
import { shallowEqual } from "../store.js";
import { Icon, type IconName } from "./icon.js";

type PaletteItem = {
  id: string;
  label: string;
  detail: string;
  icon: IconName;
  run: () => void;
};

type PaletteGroup = { value: string; items: PaletteItem[] };

/** The parts of the state the commands depend on (not the playhead: no per-frame rebuild). */
type CommandState = Pick<PlayerState, "archive" | "locale" | "theme" | "range" | "lanesExpanded">;

const selectCommandState = (state: PlayerState): CommandState => ({
  archive: state.archive,
  locale: state.locale,
  theme: state.theme,
  range: state.range,
  lanesExpanded: state.lanesExpanded
});

const THEME_LABEL_KEYS = {
  system: "themeSystem",
  light: "themeLight",
  dark: "themeDark"
} as const;
const LABEL_MAX = 120;

const commandFuzzy = new uFuzzy({ unicode: true, interSplit: "[^\\p{L}\\d]+" });

/** Every command of the palette for the current state (the player's menus and keys). */
function buildCommands(
  controller: PlayerController,
  state: CommandState,
  i18n: PlayerI18n
): PaletteItem[] {
  const { archive, locale } = state;
  const command = (id: string, label: string, icon: IconName, run: () => void): PaletteItem => ({
    id: `cmd-${id}`,
    label,
    detail: "",
    icon,
    run
  });
  const nextTheme = nextThemePreference(state.theme);
  const always = [
    command("theme", i18n.tn(THEME_LABEL_KEYS[nextTheme]), "system", () =>
      controller.setTheme(nextTheme)
    ),
    ...PLAYER_LOCALES.filter((option) => option !== locale).map((option) =>
      command(
        `locale-${option}`,
        i18n.tn("cmdLanguage", { language: i18n.messages.localeNames[option] }),
        "search",
        () => controller.setLocale(option)
      )
    ),
    command("shortcuts", i18n.tn("shortcuts"), "keyboard", () => controller.setShortcutsOpen(true))
  ];

  if (!archive) {
    return always;
  }

  const firstError = archive.view.errorEvents[0];

  return [
    ...GENERATE_MENU_ENTRIES.map((entry) =>
      command(entry.kind, generateMessages.translate(locale, entry.label), "code", () =>
        openGenerate(controller.store, { kind: entry.kind })
      )
    ),
    command("about", i18n.tn("aboutRecording"), "info", () => controller.setArchiveInfoOpen(true)),
    ...(firstError
      ? [
          command("first-error", i18n.tn("cmdFirstError"), "error", () =>
            controller.selectEvent(firstError)
          )
        ]
      : []),
    command("next-error", i18n.tn("cmdNextError"), "error", () => controller.stepError(1)),
    command("next-action", i18n.tn("cmdNextAction"), "click", () => controller.nextAction()),
    ...RAIL_TAB_ORDER.map((tab) =>
      command(`tab-${tab.id}`, i18n.tn("cmdShowTab", { tab: tab.label(locale) }), "layout", () =>
        controller.setTab(tab.id)
      )
    ),
    command("lanes", i18n.tn("expandLanes"), "lanes", () =>
      controller.setLanesExpanded(!state.lanesExpanded)
    ),
    command("range-start", i18n.tn("cmdMarkStart"), "lanes", () => controller.markRange("start")),
    command("range-end", i18n.tn("cmdMarkEnd"), "lanes", () => controller.markRange("end")),
    ...(state.range
      ? [command("range-clear", i18n.tn("clearRange"), "close", () => controller.clearRange())]
      : []),
    command("rail-wide", i18n.tn("cmdRailWide"), "widen", () => controller.toggleRailWide()),
    command("reset-layout", i18n.tn("resetLayout"), "layout", () => controller.resetLayout()),
    ...always
  ];
}

function filterCommands(commands: readonly PaletteItem[], query: string): PaletteItem[] {
  const needle = query.trim();

  if (!needle) {
    return [...commands];
  }

  const idxs = commandFuzzy.filter(
    commands.map((item) => item.label),
    needle
  );
  return (idxs ?? []).flatMap((index) => {
    const item = commands[index];
    return item ? [item] : [];
  });
}

function eventItems(
  archive: LoadedArchive,
  ids: readonly string[],
  controller: PlayerController,
  locale: PlayerState["locale"]
): PaletteItem[] {
  return ids.flatMap((id) => {
    const event = archive.model.eventById.get(id);

    if (!event) {
      return [];
    }

    const row = describeFeedEvent(archive, id, locale);
    const label = eventTitle(archive, event, locale);

    return [
      {
        id: `evt-${id}`,
        label: compactText(label, LABEL_MAX),
        detail: `${formatOffset(event.mono - archive.model.minMono, locale)} · ${event.type} · ${id}`,
        icon: row?.glyph ?? "flag",
        run: () => {
          // The event opens in the inspector (Activity tab), whatever kind it is.
          controller.selectEvent(event);
          controller.setTab("activity");
          controller.openDetails();
        }
      }
    ];
  });
}

function requestItems(
  archive: LoadedArchive,
  reqIds: readonly string[],
  controller: PlayerController,
  locale: PlayerState["locale"]
): PaletteItem[] {
  return reqIds.flatMap((reqId) => {
    const entry = archive.model.waterfallByReqId.get(reqId);

    return entry
      ? [
          {
            id: `req-${reqId}`,
            label: `${entry.status ?? "—"} ${entry.method} ${shortPath(entry.url, LABEL_MAX)}`,
            detail: formatOffset(entry.startMono - archive.model.minMono, locale),
            icon: "req" as const,
            run: () => {
              controller.select({ kind: "request", id: reqId });
              controller.setTab("network");
            }
          }
        ]
      : [];
  });
}

/**
 * The command palette (`Ctrl+K`): search everything — events by id, URL, text or selector,
 * requests by URL — and run any command of the menus. Base UI `Dialog` + `Autocomplete` (an
 * always-open inline list), ranked by uFuzzy (LIBRARIES.md: no cmdk).
 */
export default function CommandPalette() {
  const controller = useController();
  const i18n = useI18n();
  const open = usePlayerState((state) => state.paletteOpen);
  const commandState = usePlayerState(selectCommandState, shallowEqual);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const groups = useMemo((): PaletteGroup[] => {
    if (!open) {
      return [];
    }

    const { archive, locale } = commandState;
    const commands = filterCommands(buildCommands(controller, commandState, i18n), deferredQuery);
    const matches = archive ? searchPalette(archive.model, deferredQuery) : null;
    const all: PaletteGroup[] = [{ value: i18n.tn("paletteCommands"), items: commands }];

    if (archive && matches) {
      all.push(
        {
          value: i18n.tn("paletteEvents"),
          items: eventItems(archive, matches.eventIds, controller, locale)
        },
        {
          value: i18n.tn("paletteRequests"),
          items: requestItems(archive, matches.reqIds, controller, locale)
        }
      );
    }

    return all.filter((group) => group.items.length > 0);
  }, [open, deferredQuery, controller, i18n, commandState]);

  const close = (): void => {
    controller.setPaletteOpen(false);
    setQuery("");
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="dlg-backdrop" />
        <Dialog.Popup
          className="dlg palette"
          aria-label={i18n.tn("paletteLabel")}
          data-testid="command-palette"
        >
          <Autocomplete.Root
            open
            inline
            items={groups}
            filteredItems={groups}
            value={query}
            onValueChange={setQuery}
            itemToStringValue={(item: PaletteItem) => item.label}
            autoHighlight="always"
            keepHighlight
          >
            <div className="palette-input">
              <Icon name="search" />
              <Autocomplete.Input
                aria-label={i18n.tn("paletteLabel")}
                placeholder={i18n.tn("palettePlaceholder")}
                data-testid="palette-input"
              />
            </div>
            <Dialog.Close className="visually-hidden">{i18n.tn("paletteClose")}</Dialog.Close>
            <div className="palette-list">
              <Autocomplete.Empty>
                <p className="palette-empty">{i18n.tn("paletteEmpty")}</p>
              </Autocomplete.Empty>
              <Autocomplete.List>
                {(group: PaletteGroup) => (
                  <Autocomplete.Group
                    key={group.value}
                    items={group.items}
                    className="palette-group"
                  >
                    <Autocomplete.GroupLabel className="palette-group-label">
                      {group.value}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(item: PaletteItem) => (
                        <Autocomplete.Item
                          key={item.id}
                          value={item}
                          className="palette-item"
                          onClick={() => {
                            close();
                            item.run();
                          }}
                          data-testid="palette-item"
                          data-item-id={item.id}
                        >
                          <Icon name={item.icon} />
                          <span className="palette-label">{item.label}</span>
                          {item.detail ? (
                            <span className="palette-detail">{item.detail}</span>
                          ) : null}
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
            </div>
            <p className="palette-hint">{i18n.tn("paletteHint")}</p>
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
