export declare function wrapInScriptScope(code: string): string;

export declare function contentScriptScopePlugin(): {
  name: string;
  renderChunk(code: string, chunk: { path: string }): { code: string } | undefined;
};
