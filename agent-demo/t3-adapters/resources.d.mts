import type { AutoOpsPrincipal, AutoOpsAccess } from './access.mjs';
import type { DatabaseSync } from 'node:sqlite';
import type { createBusinessArtifactStore } from './business-tools.mjs';
import type { configuredWorkspaceStore } from './workspaces.mjs';
export interface ResourceInput {cwd:string;query:string;limit:number;kind?:'file'|'directory';imageOnly?:boolean}
export interface ResourceContext {records:ReadonlyArray<{kind:string;path?:string}>}
export interface BusinessResourceCatalog {
  projectAtCwd(principal:AutoOpsPrincipal,cwd:string):unknown;
  search(principal:AutoOpsPrincipal,input:ResourceInput):{entries:{path:string;kind:'file'|'directory'}[];truncated:boolean};
  list(principal:AutoOpsPrincipal,input:{cwd:string;directoryPath?:string}):{entries:{path:string;kind:'file'|'directory'}[];truncated:boolean};
  read(principal:AutoOpsPrincipal,input:{cwd:string;relativePath:string}):Promise<{relativePath:string;contents:string;byteLength:number;truncated:boolean;exists:boolean}>;
  resource(principal:AutoOpsPrincipal,path:string):Promise<{path:string;name:string;mime:string;bytes:Uint8Array}>;
  metadata(principal:AutoOpsPrincipal,paths:ReadonlyArray<string>):Promise<{entries:({kind:'file'|'directory';byteLength?:number;mimeType?:string}|null)[]}>;
  requireContext(threadId:string,context:ResourceContext|undefined):void;
  readForThread(threadId:string,path:string):Promise<Record<string,unknown>>;
}
export function createBusinessResourceCatalog(options:{access:AutoOpsAccess;bindingDb:DatabaseSync;artifactStore?:ReturnType<typeof createBusinessArtifactStore>;attachmentsDir:string;workspaceStore?:ReturnType<typeof configuredWorkspaceStore>}):BusinessResourceCatalog;
export function configuredBusinessResourceCatalog():BusinessResourceCatalog|undefined;
