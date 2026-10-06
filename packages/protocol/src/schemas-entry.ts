// `@webblackbox/protocol/schemas`: the zod schemas and validators. The package root re-exports
// them for compatibility, but code that runs inside recorded pages must not use them; import
// from this subpath where zod is wanted so the dependency stays explicit.
export * from "./messages.js";
export * from "./pointer-schemas.js";
export * from "./schemas.js";
