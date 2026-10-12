// Prompt files live in evals/prompts so they version with the code; `{{name}}` placeholders are
// filled per run.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PROMPTS_DIR } from "./paths.js";

export type PromptName = "agent-system" | "agent-task" | "judge";

export async function loadPrompt(name: PromptName): Promise<string> {
  return (await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8")).replace(/\r\n/g, "\n").trim();
}

/** Replaces every `{{name}}`; a placeholder without a value is an error, not an empty string. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];

    if (value === undefined) {
      throw new Error(`Prompt placeholder {{${key}}} has no value`);
    }

    return value;
  });
}
