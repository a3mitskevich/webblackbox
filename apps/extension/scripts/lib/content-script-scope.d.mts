export declare const CLASSIC_SCRIPT_CHUNKS: readonly string[];

export declare function wrapInScriptScope(code: string): string;

export declare function isWrappedInScriptScope(code: string): boolean;

export declare function contentScriptScopePlugin(): {
  name: string;
  renderChunk(code: string, chunk: { path: string }): { code: string } | undefined;
};
