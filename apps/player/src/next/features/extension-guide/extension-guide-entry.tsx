// The stylesheet loads eagerly with the app shell (like generate.css): the entry points in the
// header menu and the empty state use its classes before the dialog chunk exists.
import "./extension-guide.css";

import { LazyDialog, retryableLazy } from "../../components/lazy-dialog.js";
import { useController } from "../../context.js";
import { useFeatureSlice } from "../slice.js";
import {
  closeExtensionGuide,
  extensionGuideSlice,
  openExtensionGuide,
  type ExtensionGuideSlice
} from "./slice.js";

/** The guide (and its code) load on first open. */
const LazyExtensionGuideDialog = retryableLazy(() => import("./extension-guide-dialog.js"));

const selectOpen = (slice: ExtensionGuideSlice) => slice.open;

/**
 * The extension guide dialog, mounted once at the app root; nothing loads until it is opened. A
 * chunk that fails to load or a dialog that throws closes with a "failed, retry" toast.
 */
export function ExtensionGuideDialog() {
  const controller = useController();
  const open = useFeatureSlice(extensionGuideSlice, selectOpen);

  return (
    <LazyDialog
      open={open}
      dialog={LazyExtensionGuideDialog}
      onClose={() => closeExtensionGuide(controller.store)}
      onReopen={() => openExtensionGuide(controller.store)}
    />
  );
}
