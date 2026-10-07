import * as z from "zod";

// The player runs under a CSP without 'unsafe-eval'. Zod's JIT probes `new Function("")` when the
// archive schemas (protocol) are built, which the browser reports as a CSP violation. Jitless
// parsing never probes. This module is imported first by the entry, before any schema exists.
z.config({ jitless: true });
