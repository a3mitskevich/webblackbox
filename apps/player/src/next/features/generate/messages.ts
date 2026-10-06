import { defineFeatureMessages, type FeatureTranslator } from "../messages.js";
import EN from "./locales/en.json" with { type: "json" };
import RU from "./locales/ru.json" with { type: "json" };
import ZH_CN from "./locales/zh-CN.json" with { type: "json" };

export type GenerateMessageKey = keyof typeof EN;
export type GenerateTranslate = FeatureTranslator<GenerateMessageKey>;

export const generateMessages = defineFeatureMessages<GenerateMessageKey>("generate", {
  en: EN,
  ru: RU,
  "zh-CN": ZH_CN
});
