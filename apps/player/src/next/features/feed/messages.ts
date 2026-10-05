import { defineFeatureMessages } from "../messages.js";
import EN from "./locales/en.json" with { type: "json" };
import RU from "./locales/ru.json" with { type: "json" };
import ZH_CN from "./locales/zh-CN.json" with { type: "json" };

export const feedMessages = defineFeatureMessages<keyof typeof EN>("feed", {
  en: EN,
  ru: RU,
  "zh-CN": ZH_CN
});
