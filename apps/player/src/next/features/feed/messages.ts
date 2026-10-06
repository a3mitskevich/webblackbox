import { defineFeatureMessages, type FeatureTranslator } from "../messages.js";
import EN from "./locales/en.json" with { type: "json" };
import RU from "./locales/ru.json" with { type: "json" };
import ZH_CN from "./locales/zh-CN.json" with { type: "json" };

export type FeedKey = keyof typeof EN;
export type FeedTranslator = FeatureTranslator<FeedKey>;

export const feedMessages = defineFeatureMessages<FeedKey>("feed", {
  en: EN,
  ru: RU,
  "zh-CN": ZH_CN
});
