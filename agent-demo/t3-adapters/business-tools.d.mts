import type { configuredWorkspaceStore } from './workspaces.mjs';
export interface BusinessBinding {
  threadId: string; projectId: string; environmentId: string; agentId: string;
  ownerId: string; visibility: 'private' | 'project'; createdAt?: string;
  workspaceType?: 'internal' | 'external'; workspaceVersionId?: string;
}
export interface BusinessAttachment { id: string; name: string; mime: string; readable?: boolean; bytes?: Uint8Array; content?: string; sourceUrl: string }
export interface BusinessArtifact { id: string; name: string; mime: string; size: number; sourceUrl: string }
export class AutoOpsToolError extends Error { code: string }
export function createBusinessArtifactStore(dataDir: string): {
  create(input: { binding: BusinessBinding; runId: string; name: string; mime: string; bytes: Uint8Array }): BusinessArtifact;
  read(id: string): null | { id: string; threadId: string; runId: string; projectId: string; ownerId: string; published: boolean; name: string; mime: string; bytes: Uint8Array; createdAt: string };
  list(threadId: string): ReadonlyArray<Record<string, unknown>>;
  close(): void;
};
export function configuredBusinessArtifactStore(): ReturnType<typeof createBusinessArtifactStore> | undefined;
export function createAutoOpsBusinessTools(options: {
  authorizeThread(threadId: string): PromiseLike<unknown> | unknown;
  loadAttachments(binding: BusinessBinding): PromiseLike<ReadonlyArray<BusinessAttachment>> | ReadonlyArray<BusinessAttachment>;
  loadAttachmentBytes?(binding: BusinessBinding, id: string): PromiseLike<Uint8Array> | Uint8Array;
  storeArtifact(input: { binding: BusinessBinding; runId: string; name: string; mime: string; bytes: Uint8Array }): PromiseLike<BusinessArtifact> | BusinessArtifact;
  renderPdf?(content: string): PromiseLike<Uint8Array> | Uint8Array;
  workspaceStore?: ReturnType<typeof configuredWorkspaceStore>;
}): {
  listMaterials(threadId: string): Promise<Record<string, unknown>>;
  readDocument(threadId: string, id: string): Promise<Record<string, unknown>>;
  readAttachment(threadId: string, id: string): Promise<Record<string, unknown>>;
  queryEnvironment(threadId: string, environmentId: string): Promise<Record<string, unknown>>;
  createReport(threadId: string, runId: string, input: { name: string; mime: string; content: string }): Promise<Record<string, unknown>>;
};
