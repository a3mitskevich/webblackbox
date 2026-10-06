export declare const UI_LOCALES: readonly ["en", "ru", "zh-CN"];

export declare const localeFragmentsDir: string;

export declare const mergedLocalesDir: string;

export type LocaleFragment = {
  file: string;
  feature: string;
  locale: string;
  messages: Record<string, string>;
};

export declare function readLocaleFragments(dir: string): LocaleFragment[];

export declare function mergeLocaleFragments(
  fragments: LocaleFragment[]
): Record<string, Record<string, string>>;

export declare function writeMergedLocales(options?: {
  fragmentsDir?: string;
  outputDir?: string;
}): string[];

export declare function mergedLocalesPlugin(): { name: string; buildStart(): void };
