import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { OrchestrationV2DomainEvent, OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import * as DateTime from 'effect/DateTime';

const mocks = vi.hoisted(() => ({ bindings:new Map<string,{projectId:string;workspaceType:'internal'|'external';workspaceVersionId?:string}>() }));
vi.mock('../../../../../../agent-demo/t3-adapters/access.mjs', () => ({ getThreadBinding:(threadId:string) => mocks.bindings.get(threadId) }));
import { projectThreadProjectionForWire, projectDomainEventForWire } from '../orchestration-v2/WireProjection.ts';
import { buildBoundedThreadStreamSnapshot } from '../orchestration-v2/ThreadStream.ts';

const RAW_ROOT='/home/tao/private-runtime/t3/workspaces/project-a';
const SAFE_ROOT='autoops/project-a/current/external';
const NOW=DateTime.makeUnsafe('2026-10-22T00:00:00Z');
function projection(): OrchestrationV2ThreadProjection {
  return {
    thread:{id:'thread-a',projectId:'project-a',title:'范围验证',providerInstanceId:'codex',modelSelection:{instanceId:'codex',model:'grok-4.6'},runtimeMode:'approval-required',interactionMode:'default',branch:null,worktreePath:RAW_ROOT,activeProviderThreadId:null,lineage:{parentThreadId:null,relationshipToParent:null,rootThreadId:'thread-a'},forkedFrom:null,createdBy:'user',creationSource:'web',createdAt:NOW,updatedAt:NOW,archivedAt:null,settledOverride:null,settledAt:null,deletedAt:null},
    providerSessions:[{id:'session-a',cwd:RAW_ROOT,model:'grok-4.6',status:'ready',driver:'codex',providerInstanceId:'codex',capabilities:{},createdAt:NOW,updatedAt:NOW,lastError:null}],
    checkpointScopes:[{id:'checkpoint-scope-a',threadId:'thread-a',runId:null,nodeId:'node-a',parentScopeId:null,providerThreadId:null,kind:'root_run',ordinalWithinParent:0,advancesAppRunCount:true,cwd:RAW_ROOT,createdAt:NOW}],
    runs:[],attempts:[],nodes:[],subagents:[],providerThreads:[],providerTurns:[],runtimeRequests:[],messages:[],plans:[],turnItems:[],checkpoints:[],contextHandoffs:[],contextTransfers:[],visibleTurnItems:[],updatedAt:NOW,
  } as unknown as OrchestrationV2ThreadProjection;
}
function event(type:string,payload:unknown): OrchestrationV2DomainEvent {
  return {id:'event-a',type,threadId:'thread-a',occurredAt:NOW,payload} as OrchestrationV2DomainEvent;
}

describe('external workspace wire metadata', () => {
  beforeEach(() => {
    mocks.bindings.clear();
    mocks.bindings.set('thread-a',{projectId:'project-a',workspaceType:'external',workspaceVersionId:'external-v1'});
  });

  it('maps HTTP and native RPC snapshot metadata to the external scope without mutating native state', () => {
    const native=projection();
    const projected=projectThreadProjectionForWire(native);
    expect(projected.providerSessions[0]?.cwd).toBe(SAFE_ROOT);
    expect(projected.checkpointScopes[0]?.cwd).toBe(SAFE_ROOT);
    expect(projected.thread.worktreePath).toBe(SAFE_ROOT);
    expect(native.providerSessions[0]?.cwd).toBe(RAW_ROOT);
    expect(native.checkpointScopes[0]?.cwd).toBe(RAW_ROOT);
    expect(native.thread.worktreePath).toBe(RAW_ROOT);
    expect(projected.messages).toBe(native.messages);
    expect(projected.providerSessions[0]?.model).toBe('grok-4.6');
    expect(projectThreadProjectionForWire(projected)).toEqual(projected);
  });

  it('新版外部会话没有固定版本时仍不暴露宿主目录', () => {
    mocks.bindings.set('thread-a',{projectId:'project-a',workspaceType:'external'});
    const projected=projectThreadProjectionForWire(projection());
    expect(projected.providerSessions[0]?.cwd).toBe('autoops/project-a/current/external');
    expect(projected.thread.worktreePath).toBe('autoops/project-a/current/external');
    expect(projectDomainEventForWire(event('provider-session.updated',projection().providerSessions[0])).payload).toMatchObject({cwd:'autoops/project-a/current/external'});
  });

  it('uses the same metadata projection for bounded stream snapshots', () => {
    const native=projection();
    const stream=buildBoundedThreadStreamSnapshot({snapshotSequence:12,projection:native});
    expect(stream.projection.providerSessions[0]?.cwd).toBe(SAFE_ROOT);
    expect(stream.projection.checkpointScopes[0]?.cwd).toBe(SAFE_ROOT);
    expect(stream.projection.thread.worktreePath).toBe(SAFE_ROOT);
    expect(native.providerSessions[0]?.cwd).toBe(RAW_ROOT);
  });

  it.each(['provider-session.attached','provider-session.updated','checkpoint-scope.created'])('maps %s in both live and replay wire events', (type) => {
    const native=projection();
    const source=event(type,type === 'checkpoint-scope.created' ? native.checkpointScopes[0] : native.providerSessions[0]);
    const projected=projectDomainEventForWire(source);
    expect(projected.payload).toMatchObject({cwd:SAFE_ROOT});
    expect(source.payload).toMatchObject({cwd:RAW_ROOT});
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });

  it('maps a thread metadata event without editing a title containing path text', () => {
    const source=event('thread.metadata-updated',{...projection().thread,title:RAW_ROOT});
    expect(projectDomainEventForWire(source).payload).toMatchObject({worktreePath:SAFE_ROOT,title:RAW_ROOT});
    expect(source.payload).toMatchObject({worktreePath:RAW_ROOT});
  });

  it('does not rewrite model/user text or structured tool inputs and outputs', () => {
    const source=event('message.updated',{id:'message-a',text:RAW_ROOT,role:'assistant'});
    expect(projectDomainEventForWire(source)).toBe(source);
    const tool=event('turn-item.updated',{id:'tool-a',type:'dynamic_tool',threadId:'thread-a',input:{cwd:RAW_ROOT,body:'user supplied '+RAW_ROOT},output:{message:RAW_ROOT}});
    expect(projectDomainEventForWire(tool).payload).toMatchObject({input:{cwd:RAW_ROOT,body:'user supplied '+RAW_ROOT}});
    expect(tool.payload).toMatchObject({output:{message:RAW_ROOT}});
  });

  it('keeps a null native worktree null and never fabricates an executable worktree', () => {
    const native=projection();
    const projected=projectThreadProjectionForWire({...native,thread:{...native.thread,worktreePath:null}});
    expect(projected.thread.worktreePath).toBeNull();
    expect(projected.providerSessions[0]?.cwd).toBe(SAFE_ROOT);
  });

  it.each(['internal','standalone'])('leaves %s native metadata unchanged', (scope) => {
    if(scope === 'internal') mocks.bindings.set('thread-a',{projectId:'project-a',workspaceType:'internal',workspaceVersionId:'internal-v1'});
    else mocks.bindings.clear();
    const native=projection();
    expect(projectThreadProjectionForWire(native).providerSessions[0]?.cwd).toBe(RAW_ROOT);
    const source=event('checkpoint-scope.created',native.checkpointScopes[0]);
    expect(projectDomainEventForWire(source)).toBe(source);
  });
});
