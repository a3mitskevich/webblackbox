import "./generate.css";

import { LazyDialog, retryableLazy } from "../../components/lazy-dialog.js";
import { useController } from "../../context.js";
import { useFeatureSlice } from "../slice.js";
import { closeGenerate, generateSlice, openGenerate, type GenerateSlice } from "./api.js";

export { GenerateMenu } from "./generate-menu.js";

/** The dialogs, the generators and Shiki load as their own chunk on first use. */
const LazyGenerateDialogs = retryableLazy(() => import("./generate-dialogs.js"));

const selectRequest = (slice: GenerateSlice) => slice.request;

/**
 * The generator dialogs, mounted once at the app root; nothing loads until one is opened. A chunk
 * that fails to load or a generator dialog that throws closes it with a "failed, retry" toast.
 */
export function GenerateDialogs() {
  const controller = useController();
  const request = useFeatureSlice(generateSlice, selectRequest);

  return (
    <LazyDialog
      open={request !== null}
      dialog={LazyGenerateDialogs}
      onClose={() => closeGenerate(controller.store)}
      // The toast keeps this render's callback: "Retry" reopens the request that failed.
      onReopen={() => {
        if (request) {
          openGenerate(controller.store, request);
        }
      }}
    />
  );
}
