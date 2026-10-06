import "./generate.css";

import { lazy, Suspense } from "react";

import { useFeatureSlice } from "../slice.js";
import { generateSlice, type GenerateSlice } from "./api.js";

export { GenerateMenu } from "./generate-menu.js";

/** The dialogs, the generators and Shiki load as their own chunk on first use. */
const LazyGenerateDialogs = lazy(() => import("./generate-dialogs.js"));

const selectRequest = (slice: GenerateSlice) => slice.request;

/** The generator dialogs, mounted once at the app root; nothing loads until one is opened. */
export function GenerateDialogs() {
  const request = useFeatureSlice(generateSlice, selectRequest);

  return request ? (
    <Suspense fallback={null}>
      <LazyGenerateDialogs />
    </Suspense>
  ) : null;
}
