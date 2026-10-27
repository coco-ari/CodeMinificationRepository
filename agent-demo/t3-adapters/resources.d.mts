import type { AutoOpsPrincipal, AutoOpsAccess, InputReferenceClaim } from './access.mjs';
import type { createBusinessArtifactStore } from './business-tools.mjs';
import type { WorkspaceManagement } from './workspace-management.ts';
import type { configuredWorkspaceStore } from './workspaces.mjs';
export interface ResourceInput {cwd:string;query:string;limit:number;kind?:'file'|'directory';imageOnly?:boolean}
export interface ResourceContext {records:ReadonlyArray<{kind:string;path?:string}>}
export interface ResourceEntries {entries:{path:string;kind:'file'|'directory'}[];truncated:boolean}
export interface BusinessResourceCatalog {
  projectAtCwd(principal:AutoOpsPrincipal,cwd:string):unknown;
  search(principal:AutoOpsPrincipal,input:ResourceInput):ResourceEntries | Promise<ResourceEntries>;
  list(principal:AutoOpsPrincipal,input:{cwd:string;directoryPath?:string}):ResourceEntries | Promise<ResourceEntries>;
  read(principal:AutoOpsPrincipal,input:{cwd:string;relativePath:string}):Promise<{relativePath:string;contents:string;byteLength:number;truncated:boolean;exists:boolean}>;
  resource(principal:AutoOpsPrincipal,path:string):Promise<{path:string;name:string;mime:string;bytes:Uint8Array}>;
  metadata(principal:AutoOpsPrincipal,paths:ReadonlyArray<string>):Promise<{entries:({kind:'file'|'directory';byteLength?:number;mimeType?:string}|null)[]}>;
  requireContext(threadId:string,context:ResourceContext|undefined,actorId?:string,claim?:InputReferenceClaim):void;
  readForThread(threadId:string,path:string,inputId?:string,referenceInputIds?:ReadonlyArray<string>,history?:{referencePaths:ReadonlyArray<string>;attachmentIds:ReadonlyArray<string>;acceptedAt:string;runId?:string;actorId?:string}):Promise<Record<string,unknown>>;
}
export function createBusinessResourceCatalog(options:{access:AutoOpsAccess;artifactStore?:ReturnType<typeof createBusinessArtifactStore>;readAttachment?:(id:string)=>Promise<Uint8Array>;workspaceStore?:ReturnType<typeof configuredWorkspaceStore>;workspaceInputs?:Pick<WorkspaceManagement,'captureAvailableInput'|'readInput'|'inputFiles'|'readInputFile'|'readInputContent'>;authorizeToolThread?:(threadId:string,actorId?:string)=>ReturnType<AutoOpsAccess['requireToolThread']>}):BusinessResourceCatalog;
export function configuredBusinessResourceCatalog(options?:{readAttachment?:(id:string)=>Promise<Uint8Array>}):BusinessResourceCatalog|undefined;
