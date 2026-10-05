export type CspDirective = [name: string, sources: string[]];

export declare function readCsp(html: string): string;
export declare function withCsp(html: string, policy: string): string;
export declare function parseCsp(policy: string): CspDirective[];
export declare function serializeCsp(directives: readonly CspDirective[]): string;
export declare function devCsp(policy: string): string;
export declare function strictStyleCsp(policy: string): string;
