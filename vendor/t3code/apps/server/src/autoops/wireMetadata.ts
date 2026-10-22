import type { OrchestrationV2DomainEvent, OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import { getThreadBinding } from '../../../../../../agent-demo/t3-adapters/access.mjs';

function externalRoot(threadId: string): string | undefined {
  const binding = getThreadBinding(threadId);
  return binding?.workspaceType === 'external' && binding.workspaceVersionId
    ? `autoops/${binding.projectId}/workspaces/${binding.workspaceVersionId}`
    : undefined;
}

/** Only transport metadata is mapped. Native state and free-form content retain their values. */
export function projectExternalWorkspaceMetadata(projection: OrchestrationV2ThreadProjection): OrchestrationV2ThreadProjection {
  const root = externalRoot(projection.thread.id);
  if (!root) return projection;
  return {
    ...projection,
    thread: projection.thread.worktreePath === null ? projection.thread : {...projection.thread, worktreePath:root},
    providerSessions: projection.providerSessions.map((session) => ({...session,cwd:root})),
    checkpointScopes: projection.checkpointScopes.map((scope) => ({...scope,cwd:root})),
  };
}

export function projectExternalWorkspaceEventMetadata(event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent {
  if (event.type === 'provider-session.attached' || event.type === 'provider-session.updated') {
    const root = externalRoot(event.threadId);
    return root ? {...event,payload:{...event.payload,cwd:root}} : event;
  }
  if (event.type === 'checkpoint-scope.created') {
    const root = externalRoot(event.threadId);
    return root ? {...event,payload:{...event.payload,cwd:root}} : event;
  }
  if (event.type.startsWith('thread.') && 'worktreePath' in event.payload && typeof event.payload.worktreePath === 'string') {
    const root = externalRoot(event.threadId);
    // The discriminated event union is preserved; only the app-thread path changes.
    return root ? {...event,payload:{...event.payload,worktreePath:root}} as OrchestrationV2DomainEvent : event;
  }
  return event;
}
