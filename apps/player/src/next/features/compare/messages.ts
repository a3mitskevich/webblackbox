import { defineFeatureMessages, type FeatureTranslator } from "../messages.js";
import EN from "./locales/en.json" with { type: "json" };
import RU from "./locales/ru.json" with { type: "json" };
import ZH_CN from "./locales/zh-CN.json" with { type: "json" };

export type CompareMessageKey = keyof typeof EN;
export type CompareTranslate = FeatureTranslator<CompareMessageKey>;

export const compareMessages = defineFeatureMessages<CompareMessageKey>("compare", {
  en: EN,
  ru: RU,
  "zh-CN": ZH_CN
});
