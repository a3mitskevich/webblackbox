// Types for `workspace-sources.mjs`, for TypeScript configs that import it (the Player's
// `vitest.config.ts` is part of its typecheck).

export type WorkspaceSource = { specifier: string; packageName: string; file: string };

export function listWorkspaceSources(): WorkspaceSource[];

export function workspaceSourceAliases(): Array<{ find: RegExp; replacement: string }>;
