import { createPlayerI18n, type PlayerLocale } from "./i18n.js";

/** True for the rejection of an upload cancelled through its `AbortSignal`. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * POSTs the archive with upload progress. An optional `signal` cancels the request
 * (`xhr.abort()`); the promise then rejects with an `AbortError` `DOMException`.
 */
export function uploadArchiveWithProgress(
  url: string,
  headers: Record<string, string>,
  body: ArrayBuffer,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void,
  locale: PlayerLocale = "en",
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const i18n = createPlayerI18n(locale);
  const abortError = () => new DOMException(i18n.messages.uploadAborted, "AbortError");

  if (signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbortSignal = () => {
      reject(abortError());
      xhr.abort();
    };
    const done = (payload: Record<string, unknown>) => {
      signal?.removeEventListener("abort", onAbortSignal);
      resolve(payload);
    };
    const fail = (error: Error) => {
      signal?.removeEventListener("abort", onAbortSignal);
      reject(error);
    };

    xhr.open("POST", url);

    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.addEventListener("progress", (event) => {
      if (signal?.aborted) {
        return;
      }

      const totalBytes = event.lengthComputable ? event.total : body.byteLength;
      onProgress(event.loaded, totalBytes);
    });

    xhr.addEventListener("error", () => {
      fail(new Error(i18n.messages.uploadNetworkError));
    });

    xhr.addEventListener("abort", () => {
      fail(signal?.aborted ? abortError() : new Error(i18n.messages.uploadAborted));
    });

    xhr.addEventListener("load", () => {
      const responseText = xhr.responseText ?? "";

      if (xhr.status < 200 || xhr.status >= 300) {
        fail(new Error(responseText || `HTTP ${xhr.status}`));
        return;
      }

      if (responseText.trim().length === 0) {
        done({});
        return;
      }

      try {
        const parsed = JSON.parse(responseText) as unknown;

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          done(parsed as Record<string, unknown>);
          return;
        }

        fail(new Error(i18n.messages.uploadResponseNotJsonObject));
      } catch {
        fail(new Error(i18n.messages.uploadInvalidJson));
      }
    });

    signal?.addEventListener("abort", onAbortSignal, { once: true });
    xhr.send(body);
  });
}
