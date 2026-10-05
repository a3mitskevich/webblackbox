import { resolveShareServerOrigin } from "./share.js";

export function getShareServerApiKeyForBaseUrl(
  apiKeysByOrigin: Record<string, string>,
  baseUrl: string | null
): string {
  const origin = resolveShareServerOrigin(baseUrl);

  if (!origin) {
    return "";
  }

  return apiKeysByOrigin[origin] ?? "";
}

/**
 * Returns a copy of `apiKeysByOrigin` with `apiKey` saved for the origin of `baseUrl`.
 * An empty key never removes a saved one (e.g. a share link opened without a key).
 */
export function setShareServerApiKeyForBaseUrl(
  apiKeysByOrigin: Readonly<Record<string, string>>,
  baseUrl: string,
  apiKey: string
): Record<string, string> {
  const origin = resolveShareServerOrigin(baseUrl);
  const trimmed = apiKey.trim();

  if (!origin || trimmed.length === 0) {
    return apiKeysByOrigin;
  }

  return {
    ...apiKeysByOrigin,
    [origin]: trimmed
  };
}

export function bindShareApiKeyInputToTargetOrigin(
  sourceInput: HTMLInputElement,
  apiKeyInput: HTMLInputElement,
  resolveBaseUrl: (value: string) => string | null,
  resolveApiKeyForBaseUrl: (baseUrl: string | null) => string
): () => void {
  let apiKeyEdited = false;
  let resolvedBaseUrl = resolveBaseUrl(sourceInput.value);
  let targetOrigin = resolveShareServerOrigin(resolvedBaseUrl);
  apiKeyInput.value = resolveApiKeyForBaseUrl(resolvedBaseUrl);

  const onApiKeyInput = (): void => {
    apiKeyEdited = true;
  };

  const onSourceInput = (): void => {
    const nextBaseUrl = resolveBaseUrl(sourceInput.value);
    const nextOrigin = resolveShareServerOrigin(nextBaseUrl);

    if (nextOrigin === targetOrigin) {
      return;
    }

    resolvedBaseUrl = nextBaseUrl;
    targetOrigin = nextOrigin;

    if (!apiKeyEdited) {
      apiKeyInput.value = resolveApiKeyForBaseUrl(resolvedBaseUrl);
    }
  };

  apiKeyInput.addEventListener("input", onApiKeyInput);
  sourceInput.addEventListener("input", onSourceInput);

  return () => {
    apiKeyInput.removeEventListener("input", onApiKeyInput);
    sourceInput.removeEventListener("input", onSourceInput);
  };
}
