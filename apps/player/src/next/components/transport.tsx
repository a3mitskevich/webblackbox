import { useId } from "react";

import { formatClock } from "../../core/format.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import { PLAYBACK_RATES } from "../state.js";
import { Icon } from "./icon.js";

type SwitchProps = {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  className?: string;
  testId: string;
};

function Switch({ checked, label, onChange, className, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={className ? `toggle ${className}` : "toggle"}
      onClick={() => onChange(!checked)}
      data-testid={testId}
    >
      <i aria-hidden="true" />
      {label}
    </button>
  );
}

export function Transport() {
  const controller = useController();
  const i18n = useI18n();
  const speedId = useId();
  const archive = usePlayerState((state) => state.archive);
  const playheadMono = usePlayerState((state) => state.playheadMono);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const rate = usePlayerState((state) => state.rate);
  const skipIdle = usePlayerState((state) => state.skipIdle);
  const follow = usePlayerState((state) => state.follow);
  const locale = usePlayerState((state) => state.locale);

  if (!archive) {
    return null;
  }

  const { minMono, durationMono } = archive.model;

  return (
    <div className="transport" data-testid="transport">
      <button
        type="button"
        className="btn icon-only"
        aria-label={i18n.tn("previousEvent")}
        title={`${i18n.tn("previousEvent")} (J)`}
        onClick={() => controller.stepList(-1)}
        data-testid="previous-event"
      >
        <Icon name="prev" />
      </button>
      <button
        type="button"
        className="play"
        aria-label={isPlaying ? i18n.tn("pause") : i18n.tn("play")}
        title={`${isPlaying ? i18n.tn("pause") : i18n.tn("play")} (Space)`}
        onClick={() => controller.togglePlay()}
        data-testid="play-toggle"
        data-playing={isPlaying}
      >
        <Icon name={isPlaying ? "pause" : "play"} />
      </button>
      <button
        type="button"
        className="btn icon-only"
        aria-label={i18n.tn("nextEvent")}
        title={`${i18n.tn("nextEvent")} (L)`}
        onClick={() => controller.stepList(1)}
        data-testid="next-event"
      >
        <Icon name="next" />
      </button>
      <span className="clock" data-testid="clock">
        <time>{formatClock(playheadMono - minMono, locale)}</time>{" "}
        <span>/ {formatClock(durationMono, locale)}</span>
      </span>
      <span className="grow" />
      <Switch
        checked={skipIdle}
        label={i18n.tn("skipIdle")}
        onChange={(value) => controller.setSkipIdle(value)}
        className="hide-narrow"
        testId="skip-idle"
      />
      <Switch
        checked={follow}
        label={i18n.tn("followPlayhead")}
        onChange={(value) => controller.setFollow(value)}
        className="hide-narrow"
        testId="follow"
      />
      <span id={speedId} className="visually-hidden">
        {i18n.tn("playbackSpeed")}
      </span>
      <div className="seg seg-small" role="group" aria-labelledby={speedId} data-testid="speed">
        {PLAYBACK_RATES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === rate}
            onClick={() => controller.setRate(option)}
          >
            {i18n.formatNumber(option, { fractionDigits: option % 1 === 0 ? 0 : 1 })}×
          </button>
        ))}
      </div>
    </div>
  );
}
