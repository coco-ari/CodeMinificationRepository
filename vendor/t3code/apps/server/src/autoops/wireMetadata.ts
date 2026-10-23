import type { OrchestrationV2DomainEvent, OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import { getThreadBinding } from '../../../../../../agent-demo/t3-adapters/access.mjs';

function externalRoot(threadId: string): string | undefined {
  const binding = getThreadBinding(threadId);
  if (binding?.workspaceType !== 'external') return undefined;
  return `autoops/${binding.projectId}/current/external`;
}

/** 仅投影传输元数据，原生状态与自由文本保持原值。 */
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
    // 保留事件联合类型，只替换传输中的会话目录。
    return root ? {...event,payload:{...event.payload,worktreePath:root}} as OrchestrationV2DomainEvent : event;
  }
  return event;
}
