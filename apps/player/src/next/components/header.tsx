import { useId, type ChangeEvent, type RefObject } from "react";

import { formatRecordedAt } from "../../core/format.js";
import { nextThemePreference, type ThemePreference } from "../../core/preferences.js";
import { PLAYER_LOCALES, type PlayerLocale } from "../../lib/i18n.js";
import { useController, useI18n, usePlayerState } from "../context.js";
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
        <div className="sess" data-testid="session">
          <span className="sess-title">{hostOf(meta.origin)}</span>
          <span className="sess-sub" title={subtitle}>
            {subtitle}
          </span>
        </div>
      ) : null}
      {meta ? (
        <span className={meta.encrypted ? "chip ok" : "chip"} data-testid="encryption-chip">
          <Icon name={meta.encrypted ? "lock" : "unlock"} />
          {meta.encrypted ? i18n.tn("encrypted") : i18n.tn("notEncrypted")}
        </span>
      ) : null}
      {meta && meta.otherTabs > 0 && meta.tabsEventId ? (
        <button
          type="button"
          className="chip chip-button"
          aria-label={i18n.tn("otherTabs", { count: i18n.formatNumber(meta.otherTabs) })}
          title={i18n.tn("otherTabs", { count: i18n.formatNumber(meta.otherTabs) })}
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
          <button
            key={option}
            type="button"
            lang={option}
            aria-pressed={option === locale}
            title={i18n.messages.localeNames[option]}
            onClick={() => controller.setLocale(option)}
            data-testid={`locale-${option}`}
          >
            {LOCALE_SHORT_LABELS[option]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn icon-only"
        aria-label={`${i18n.tn(THEME_LABEL_KEYS[theme])} → ${i18n.tn(THEME_LABEL_KEYS[nextTheme])}`}
        title={i18n.tn(THEME_LABEL_KEYS[theme])}
        onClick={() => controller.setTheme(nextTheme)}
        data-testid="theme-toggle"
        data-theme-preference={theme}
      >
        <Icon name={THEME_ICONS[theme]} />
      </button>
      <button
        type="button"
        className="btn icon-only hide-narrow"
        aria-label={i18n.tn("shortcuts")}
        title={i18n.tn("shortcuts")}
        onClick={() => controller.setShortcutsOpen(true)}
        data-testid="shortcuts-button"
      >
        <Icon name="keyboard" />
      </button>
      <a
        className="btn hide-narrow"
        href={classicPlayerHref()}
        title={i18n.tn("classicPlayer")}
        aria-label={i18n.tn("classicPlayer")}
        data-testid="classic-link"
      >
        <Icon name="back" />
        <span className="lbl">{i18n.tn("classicPlayer")}</span>
      </a>
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

/** The same page without `?ui=next` (the hash is kept). */
function classicPlayerHref(): string {
  if (typeof window === "undefined") {
    return "./";
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("ui");
  return `${url.pathname}${url.search}${url.hash}`;
}
