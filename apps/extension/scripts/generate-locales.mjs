import { writeMergedLocales } from "./lib/locale-fragments.mjs";

// tsup and vitest merge the fragments themselves; tsc needs them merged before it starts.
writeMergedLocales();
