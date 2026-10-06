import { Menu } from "@base-ui/react/menu";
import { useId, useMemo, type ChangeEvent, type RefObject } from "react";

import { formatRecordedAt } from "../../core/format.js";
import { nextThemePreference, type ThemePreference } from "../../core/preferences.js";
import { PLAYER_LOCALES, type PlayerLocale } from "../../lib/i18n.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import { GenerateMenu } from "../features/generate/index.js";
import { ShareButton } from "../features/share/share-button.js";
import { archiveContentsOf, profileBannerLines } from "./archive-info.js";
import { Hint } from "./hint.js";
import { Icon, type IconName } from "./icon.js";

const LOCALE_SHORT_LABELS: Record<PlayerLocale, string> = {
  en: "EN",
  ru: "RU",
  "zh-CN": "中文"
};

const THEME_ICONS: Record<ThemePreference, IconName> = {
  system: "system",
  light: "sun",
  dark: "moon"
};

/** The Player's version (Vite `define`), shown in the player menu. */
const PLAYER_VERSION = typeof __PLAYER_VERSION__ === "string" ? __PLAYER_VERSION__ : "0.0.0";
const SOURCE_URL = "https://github.com/webllm/webblackbox";

const THEME_LABEL_KEYS = {
  system: "themeSystem",
  light: "themeLight",
  dark: "themeDark"
} as const;

type ArchiveInputProps = {
  className: string;
  label: string;
  hideLabelWhenNarrow?: boolean;
  testId?: string;
};

/** "Open archive": a real file input styled as a button (keyboard and screen-reader friendly). */
export function ArchiveInput({
  className,
  label,
  hideLabelWhenNarrow = false,
  testId = "archive-input"
}: ArchiveInputProps) {
  const controller = useController();
  const inputId = useId();

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file) {
      void controller.openFile(file);
    }
  };

  return (
    <>
      <input
        id={inputId}
        className="file-input"
        type="file"
        accept=".webblackbox,.zip"
        onChange={handleChange}
        data-testid={testId}
      />
      <label className={className} htmlFor={inputId}>
        <Icon name="file" />
        <span className={hideLabelWhenNarrow ? "hide-narrow" : undefined}>{label}</span>
      </label>
    </>
  );
}

type HeaderProps = {
  searchRef: RefObject<HTMLInputElement | null>;
};

export function Header({ searchRef }: HeaderProps) {
  const controller = useController();
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const theme = usePlayerState((state) => state.theme);
  const query = usePlayerState((state) => state.query);
  const archive = usePlayerState((state) => state.archive);
  const meta = archive?.view.meta ?? null;
  const nextTheme = nextThemePreference(theme);

  const subtitle = meta
    ? [
        i18n.formatSeconds(meta.durationMs),
        i18n.formatMode(meta.mode),
        formatRecordedAt(meta.createdAt, locale),
        archive?.fileName ?? ""
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <header className="hdr" data-testid="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          ◉
        </span>
        <span className="hide-narrow">WebBlackbox</span>
      </div>
      {meta ? (
        <Hint label={i18n.tn("aboutRecordingHint")}>
          <button
            type="button"
            className="sess"
            aria-label={`${hostOf(meta.origin)} · ${subtitle} · ${i18n.tn("aboutRecording")}`}
            onClick={() => controller.setArchiveInfoOpen(true)}
            data-testid="session"
          >
            <span className="sess-title">{hostOf(meta.origin)}</span>
            <span className="sess-sub">{subtitle}</span>
          </button>
        </Hint>
      ) : null}
      {meta ? (
        <span className={meta.encrypted ? "chip ok" : "chip"} data-testid="encryption-chip">
          <Icon name={meta.encrypted ? "lock" : "unlock"} />
          {meta.encrypted ? i18n.tn("encrypted") : i18n.tn("notEncrypted")}
        </span>
      ) : null}
      <ProfileChip />
      {meta && meta.otherTabs > 0 && meta.tabsEventId ? (
        <Hint label={i18n.tn("otherTabs", { count: i18n.formatNumber(meta.otherTabs) })}>
          <button
            type="button"
            className="chip chip-button"
            aria-label={i18n.tn("otherTabs", { count: i18n.formatNumber(meta.otherTabs) })}
            data-testid="other-tabs-chip"
            onClick={() => {
              const event = archive?.model.eventById.get(meta.tabsEventId ?? "");

              if (event) {
                controller.selectEvent(event);
              }
            }}
          >
            <Icon name="tabs" />
            <span className="lbl">
              {i18n.tn("otherTabs", { count: i18n.formatNumber(meta.otherTabs) })}
            </span>
            <span className="lbl-short" aria-hidden="true">
              {i18n.formatNumber(meta.otherTabs)}
            </span>
          </button>
        </Hint>
      ) : null}
      <span className="hdr-spacer" />
      {archive ? (
        <label className="search">
          <Icon name="search" />
          <span className="visually-hidden">{i18n.tn("searchLabel")}</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={i18n.tn("searchPlaceholder")}
            onChange={(event) => controller.setQuery(event.target.value)}
            data-testid="search"
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
      ) : null}
      <div
        className="seg"
        role="group"
        aria-label={i18n.tn("language")}
        data-testid="locale-switch"
      >
        {PLAYER_LOCALES.map((option) => (
          <Hint key={option} label={i18n.messages.localeNames[option]}>
            <button
              type="button"
              lang={option}
              aria-pressed={option === locale}
              aria-label={`${LOCALE_SHORT_LABELS[option]} · ${i18n.messages.localeNames[option]}`}
              onClick={() => controller.setLocale(option)}
              data-testid={`locale-${option}`}
            >
              {LOCALE_SHORT_LABELS[option]}
            </button>
          </Hint>
        ))}
      </div>
      <Hint label={i18n.tn(THEME_LABEL_KEYS[theme])}>
        <button
          type="button"
          className="btn icon-only"
          aria-label={`${i18n.tn(THEME_LABEL_KEYS[theme])} → ${i18n.tn(THEME_LABEL_KEYS[nextTheme])}`}
          onClick={() => controller.setTheme(nextTheme)}
          data-testid="theme-toggle"
          data-theme-preference={theme}
        >
          <Icon name={THEME_ICONS[theme]} />
        </button>
      </Hint>
      {archive ? (
        <Hint label={i18n.tn("resetLayout")}>
          <button
            type="button"
            className="btn icon-only hide-narrow"
            aria-label={i18n.tn("resetLayout")}
            onClick={() => controller.resetLayout()}
            data-testid="reset-layout"
          >
            <Icon name="layout" />
          </button>
        </Hint>
      ) : null}
      <Hint label={i18n.tn("shortcuts")}>
        <button
          type="button"
          className="btn icon-only hide-narrow"
          aria-label={i18n.tn("shortcuts")}
          onClick={() => controller.setShortcutsOpen(true)}
          data-testid="shortcuts-button"
        >
          <Icon name="keyboard" />
        </button>
      </Hint>
      {archive ? <GenerateMenu /> : null}
      <ShareButton />
      <PlayerMenu />
      <ArchiveInput className="btn primary" label={i18n.tn("openArchive")} hideLabelWhenNarrow />
    </header>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * The recording profile next to "Encrypted" (PROPOSAL §12: "recorded with profile X instead of
 * Y"): amber when it was downgraded, capped by policy or cut short; opens "About this recording".
 */
function ProfileChip() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const profile = useMemo(() => {
    if (!archive) {
      return null;
    }

    const names = archiveContentsOf(archive).profiles.map((entry) => entry.name);
    return names.length > 0
      ? { label: names.join(" → "), warn: profileBannerLines(archive, i18n).length > 0 }
      : null;
  }, [archive, i18n]);

  if (!profile) {
    return null;
  }

  return (
    <Hint label={i18n.tn("aboutRecordingHint")}>
      <button
        type="button"
        className={profile.warn ? "chip chip-button warn" : "chip chip-button"}
        aria-label={`${i18n.tn("factProfile")}: ${profile.label}`}
        onClick={() => controller.setArchiveInfoOpen(true)}
        data-testid="profile-chip"
        data-warn={profile.warn}
      >
        {profile.warn ? <Icon name="flag" /> : null}
        <span className="lbl">{profile.label}</span>
      </button>
    </Hint>
  );
}

/** "⋯": about the recording, shortcuts, layout reset, the Player version and its source. */
function PlayerMenu() {
  const controller = useController();
  const i18n = useI18n();
  const hasArchive = usePlayerState((state) => state.archive !== null);

  return (
    <Menu.Root>
      <Hint label={i18n.tn("playerMenu")}>
        <Menu.Trigger
          className="btn icon-only"
          aria-label={i18n.tn("playerMenu")}
          data-testid="player-menu"
        >
          <Icon name="more" />
        </Menu.Trigger>
      </Hint>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="menu-layer">
          <Menu.Popup className="menu" data-testid="player-menu-popup">
            <Menu.Item
              className="menu-item"
              disabled={!hasArchive}
              onClick={() => controller.setArchiveInfoOpen(true)}
              data-testid="menu-about-recording"
            >
              <Icon name="info" />
              {i18n.tn("aboutRecording")}
            </Menu.Item>
            <Menu.Item
              className="menu-item"
              onClick={() => controller.setPaletteOpen(true)}
              data-testid="menu-palette"
            >
              <Icon name="search" />
              {i18n.tn("paletteLabel")}
              <kbd className="menu-kbd">Ctrl K</kbd>
            </Menu.Item>
            <Menu.Item
              className="menu-item"
              onClick={() => controller.setShortcutsOpen(true)}
              data-testid="menu-shortcuts"
            >
              <Icon name="keyboard" />
              {i18n.tn("shortcuts")}
            </Menu.Item>
            <Menu.Item
              className="menu-item"
              onClick={() => controller.resetLayout()}
              data-testid="menu-reset-layout"
            >
              <Icon name="layout" />
              {i18n.tn("resetLayout")}
            </Menu.Item>
            <Menu.Separator className="menu-sep" />
            <Menu.LinkItem
              className="menu-item"
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              data-testid="menu-source"
            >
              <Icon name="external" />
              {i18n.tn("sourceCode")}
            </Menu.LinkItem>
            <p className="menu-note" data-testid="player-version">
              {i18n.tn("playerVersion", { version: PLAYER_VERSION })}
            </p>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
