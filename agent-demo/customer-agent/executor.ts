import { join } from "node:path";
import type { CustomerCapabilityInput } from "../../autoops/contracts/runtime.ts";
import { CustomerAttachmentCache, type AttachmentDownload } from "./attachments.ts";
import { CUSTOMER_ATTACHMENT_LIMITS } from "../../vendor/t3code/packages/contracts/src/customerAttachments.ts";
import { createHash } from "node:crypto";
import type { CustomerAgentCommand, CustomerAgentReceipt, CustomerAgentClientFrame } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";
import { ConnectorError, CustomerAgentStore, type LocalSession, type LocalWorkspace } from "./store.ts";
import type { HeadlessCodexRunner, HeadlessCodexRunnerOptions } from "../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts";
import { SKILL_MENTION_PATTERN } from "../../vendor/t3code/packages/shared/src/composerInlineTokens.ts";
import { resolveCustomerFileReferences } from "./files.ts";
import { createSharedDockerRuntime, loadSharedDockerProfile, sharedRuntimeDirectory, type SharedDockerRuntime } from './shared-docker-profile.ts';
import { sharedSessionIdentity, type SharedExecutionScope } from '../../autoops/contracts/shared-execution.ts';

export type RunnerFactory = (options: HeadlessCodexRunnerOptions) => Promise<HeadlessCodexRunner>;
export const customerSkillId = (workspaceId: string, localPath: string): string =>
  createHash("sha256").update(`${workspaceId}:${localPath}`).digest("hex");
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("invalid_input", "命令输入格式不正确");
  return value as Record<string, any>;
};
const errorReceipt = (command: CustomerAgentCommand, error: unknown, state: "failed" | "unknown" = "failed"): CustomerAgentReceipt => ({
  type: "receipt", commandId: command.commandId, sessionId: command.sessionId, state,
  ...(command.executionScope?{grantId:command.executionScope.grantId}:{}),
  error: { code: error instanceof ConnectorError ? error.code : "runtime_error",
    // Provider errors may contain command arguments or credentials: keep operations logs and wire errors generic.
    message: error instanceof ConnectorError ? error.message : "客户运行器未能完成操作，请在本机查看运行状态" },
});

export class CustomerAgentExecutor {
  readonly store: CustomerAgentStore;
  readonly deviceId: string;
  readonly runners = new Map<string, HeadlessCodexRunner>();
  private readonly opening = new Set<string>();
  private readonly requests = new Map<string, Set<string>>();
  private readonly providerTurns = new Map<string, string>();
  private readonly providerThreads = new Map<string, unknown>();
  private readonly stopping = new Set<string>();
  private executing = 0;
  private readonly commands = new Set<Promise<CustomerAgentReceipt>>();
  private readonly shutdown = new AbortController();
  private readonly attachments: CustomerAttachmentCache | undefined;
  private readonly discoveryRunners = new Set<HeadlessCodexRunner>();
  private readonly sharedRuntimes = new Map<string,SharedDockerRuntime>();
  private readonly sharedAttachments = new Map<string,CustomerAttachmentCache>();
  private readonly authorizeShared:((scope:SharedExecutionScope,signal?:AbortSignal)=>Promise<void>)|undefined;
  private readonly downloadAttachment:AttachmentDownload|undefined;
  private readonly notify: (frame: CustomerAgentClientFrame) => void;
  private readonly runnerFactory: RunnerFactory;
  private readonly onState: (message: string) => void;
  constructor(options: {
    store: CustomerAgentStore; deviceId: string; runnerFactory: RunnerFactory; downloadAttachment?: AttachmentDownload;
    notify: (frame: CustomerAgentClientFrame) => void; onState?: (message: string) => void;
    authorizeShared?:(scope:SharedExecutionScope,signal?:AbortSignal)=>Promise<void>;
  }) {
    this.store = options.store; this.deviceId = options.deviceId; this.runnerFactory = options.runnerFactory;
    this.attachments = options.downloadAttachment ? new CustomerAttachmentCache(join(options.store.directory, "attachments"), options.downloadAttachment) : undefined;
    this.notify = options.notify; this.onState = options.onState ?? (() => {});
    this.authorizeShared=options.authorizeShared?async(scope,signal)=>{
      const checkLocal=async()=>{
        signal?.throwIfAborted();
        if(scope.target.deviceId!==this.deviceId)throw new ConnectorError('shared_target_changed','共享范围不属于本机设备');
        const workspace=this.store.resolveWorkspace(scope.target);
        if(workspace.projectId!==scope.sourceProjectId||!workspace.sharedProfilePath)throw new ConnectorError('shared_profile_required','本机来源的共享profile已撤回');
        if((await loadSharedDockerProfile(workspace.sharedProfilePath)).descriptor.digest!==scope.profile.digest)throw new ConnectorError('shared_profile_changed','本机隔离profile已变更，请重新核验');
        return workspace.sharedProfilePath;
      };
      const before=await checkLocal();
      await options.authorizeShared!(scope,signal);
      if(await checkLocal()!==before)throw new ConnectorError('shared_profile_changed','准入期间提供者已更换本机隔离profile');
    }:undefined;this.downloadAttachment=options.downloadAttachment;
  }
  private async isolatedRunner(options:HeadlessCodexRunnerOptions,isolation:SharedDockerRuntime):Promise<HeadlessCodexRunner> {
    const probe=await this.runnerFactory({...options,onEvent:()=>{}});
    try {await isolation.configureSkillCatalog((await probe.catalog()).skills)} finally {await probe.close()}
    const runner=await this.runnerFactory(options);
    try {isolation.assertSkillCatalog((await runner.catalog()).skills);return runner}
    catch(error){await runner.close();throw error}
  }
  private async runner(sessionId: string, workspace: LocalWorkspace, executionScope?:SharedExecutionScope): Promise<HeadlessCodexRunner> {
    const existing = this.runners.get(sessionId);
    if (existing) return existing;
    if (this.opening.has(sessionId)) throw new ConnectorError("session_opening", "本机会话正在建立");
    if (this.runners.size + this.opening.size >= 32) throw new ConnectorError("runtime_capacity", "本机已达到 32 个受管会话上限，请先停止活动任务并重启连接程序释放空闲会话");
    const saved = this.store.session(sessionId);
    if (saved && saved.workspaceId !== workspace.registeredWorkspaceId) throw new ConnectorError("binding_changed", "已有会话不能切换登记目录");
    if (saved?.state === "unknown" || saved?.state === "active") throw new ConnectorError("execution_unknown", "旧执行尚未确认结束，请先在本机核实");
    this.opening.add(sessionId);
    let isolation:SharedDockerRuntime|undefined;
    try {
      let epoch = "";
      isolation=executionScope ? await createSharedDockerRuntime({directory:this.store.directory,workspace,sessionId,scope:executionScope,authorize:this.authorizeShared!}) : undefined;
      if(isolation)this.sharedRuntimes.set(sessionId,isolation);
      const options:HeadlessCodexRunnerOptions={
        instanceId: `customer-${this.deviceId}-codex`, cwd: workspace.realPath, localPolicy: workspace.policy,
        ...(isolation?.options??{}),
        resolveAttachmentPath: (attachment) => {const path=(isolation?this.sharedAttachments.get(sessionId):this.attachments)?.resolve(sessionId,attachment);return path ? isolation?.attachmentPath(path)??path : null},
        onEvent: (event) => this.handleEvent(sessionId, epoch, event),
        onError: () => this.markUnknown(sessionId, "客户运行器连接异常，结果待核实", "runtime_lost"),
      };
      const runner=isolation?await this.isolatedRunner(options,isolation):await this.runnerFactory(options);
      epoch = runner.processGeneration;
      this.store.saveSession({ sessionId, runtimeEpoch: epoch, workspaceId: workspace.registeredWorkspaceId,
        state: "idle", nativeThreadId: saved?.nativeThreadId ?? null, nativeTurnId: null, runId: null, attemptId: null,
        ...(executionScope?{executionScope}:{}),
        ...(saved?.resolution ? { resolution: saved.resolution } : {}) });
      this.runners.set(sessionId, runner); return runner;
    } catch(error) {
      if(isolation) {
        // 目录发现或原生初始化失败也必须排空本次容器；停止不明时保留其持久状态。
        await isolation.close();this.sharedRuntimes.delete(sessionId);this.sharedAttachments.delete(sessionId);
      }
      throw error;
    } finally { this.opening.delete(sessionId); }
  }
  private markUnknown(sessionId: string, message: string, reason: "runtime_lost" | "journal_unavailable" | "outcome_unknown" = "outcome_unknown"): void {
    const session = this.store.session(sessionId);
    // A recovery poll may report the same lost runtime repeatedly. The persisted state
    // already appears in every reconnect hello; do not flood controls or terminal logs.
    if (session?.state === "unknown") return;
    if (session) {
      try { this.store.saveSession({ ...session, state: "unknown" }); }
      catch { reason = "journal_unavailable"; }
      this.notify({ type: "runtimeState", sessionId, runtimeEpoch: session.runtimeEpoch, state: "unknown", reason });
    }
    this.onState(`${sessionId}: ${message}`);
  }
  private handleEvent(sessionId: string, epoch: string, value: unknown): void {
    const event = object(value);
    const current = this.store.session(sessionId);
    if (!current || current.runtimeEpoch !== epoch) return;
    if (event.type === "command_output.delta") {
      const chunk = typeof event.chunk === "string" ? event.chunk : "";
      // Live log fragments are explicitly lossy; final turn-item output uses the reliable stream.
      this.notify({ type: "delta", sessionId, runtimeEpoch: epoch, event: { ...event, chunk: chunk.slice(-32 * 1024) } });
      return;
    }
    try {
      this.store.appendEvent(sessionId, epoch, event);
      if (event.type === "provider_thread.updated" && event.providerThread?.nativeThreadRef?.nativeId) {
        this.providerThreads.set(sessionId, event.providerThread);
        this.store.saveSession({ ...current, nativeThreadId: String(event.providerThread.nativeThreadRef.nativeId) });
      }
      if (event.type === "provider_turn.updated" && event.providerTurn?.runAttemptId === current.attemptId) {
        this.providerTurns.set(sessionId, String(event.providerTurn.id));
        this.store.saveSession({ ...this.store.session(sessionId)!, nativeTurnId: event.providerTurn.nativeTurnRef?.nativeId ?? null });
      }
      if (event.type === "runtime_request.updated") {
        const requests = this.requests.get(sessionId) ?? new Set<string>();
        if (event.runtimeRequest?.status === "pending") requests.add(event.runtimeRequest.id);
        else requests.delete(event.runtimeRequest?.id);
        this.requests.set(sessionId, requests);
      }
      if (event.type === "turn.terminal" && this.providerTurns.get(sessionId) === event.providerTurnId) {
        const session = this.store.session(sessionId)!;
        if (session.runId) this.store.releaseWorkspace(session.workspaceId, sessionId, session.runId);
        this.store.saveSession({ ...session, state: "idle", runId: null, attemptId: null });
        this.providerTurns.delete(sessionId); this.requests.delete(sessionId);
        this.stopping.delete(sessionId);
      }
      if (this.store.logBytes() >= this.store.maxLogBytes - this.store.reserveBytes) {
        void this.requestLocalStop(sessionId, "待回传日志接近容量上限，正在请求本机停止");
      }
    } catch (error) {
      this.markUnknown(sessionId, error instanceof ConnectorError ? error.message : "无法保存恢复日志，执行结果待核实", "journal_unavailable");
      // Do not continue unjournaled work; closing is a best-effort local stop, never a fabricated terminal.
      void this.runners.get(sessionId)?.close().catch(() => {});
    }
  }
  async execute(command: CustomerAgentCommand): Promise<CustomerAgentReceipt> {
    this.executing++;
    const task = this.executeCommand(command);
    this.commands.add(task);
    try { return await task; } finally { this.executing--; this.commands.delete(task); }
  }
  private async executeCommand(command: CustomerAgentCommand): Promise<CustomerAgentReceipt> {
    let nativeAttempted = false;
    try {
      this.shutdown.signal.throwIfAborted();
      const previous = this.store.receipt(command);
      if (previous) { this.notify(previous); return previous; }
      const workspace = this.store.resolveWorkspace(command.target, command.method === "interruptTurn" || command.method === "readThreadSnapshot");
      const session = this.store.session(command.sessionId);
      if(command.executionScope) {
        if(!workspace.sharedProfilePath || !this.authorizeShared)throw new ConnectorError('shared_profile_required','提供者尚未配置已验证的本机隔离profile');
        if(command.executionScope.target.deviceId!==this.deviceId || command.executionScope.target.registeredWorkspaceId!==workspace.registeredWorkspaceId || command.executionScope.target.workspaceBindingRevision!==workspace.workspaceBindingRevision || command.executionScope.sourceProjectId!==workspace.projectId)throw new ConnectorError('shared_target_changed','固定共享范围不属于此本机登记来源');
        if(session && sharedSessionIdentity(session.executionScope)!==sharedSessionIdentity(command.executionScope))throw new ConnectorError('shared_session_changed','原生会话不能更换共享调用者或项目');
        if(command.method!=='interruptTurn')await this.authorizeShared(command.executionScope);
        if(command.method!=='interruptTurn')await this.sharedRuntimes.get(command.sessionId)?.updateScope(command.executionScope);
        if(!this.sharedAttachments.has(command.sessionId)&&this.downloadAttachment)this.sharedAttachments.set(command.sessionId,new CustomerAttachmentCache(join(sharedRuntimeDirectory(this.store.directory,command.executionScope),'attachments'),this.downloadAttachment));
      } else if(session?.executionScope)throw new ConnectorError('shared_scope_required','共享会话不能退回提供者自用权限');
      if (session && session.workspaceId !== workspace.registeredWorkspaceId) throw new ConnectorError("binding_changed", "已有会话不能更换工作区");
      const control = ["steerTurn", "interruptTurn", "respondToRuntimeRequest"].includes(command.method);
      if (control && (!command.runtimeEpoch || command.runtimeEpoch !== session?.runtimeEpoch || !this.runners.has(command.sessionId))) {
        throw new ConnectorError("stale_runtime", "控制指令对应的本机运行已失效，正在核实执行状态");
      }
      const input = command.method === "catalog" ? {} : { ...object(command.input) };
      if (control && ["steerTurn", "interruptTurn"].includes(command.method) && this.providerTurns.get(command.sessionId) !== input.providerTurnId) {
        throw new ConnectorError("stale_turn", "这条控制指令不属于本机当前轮次");
      }
      if (command.method === "respondToRuntimeRequest" && !this.requests.get(command.sessionId)?.has(String(input.requestId))) {
        throw new ConnectorError("stale_request", "审批请求已失效或已经处理");
      }
      if (command.method === "startTurn") {
        this.store.assertCapacity();
        if (!input.runId || !input.attemptId) throw new ConnectorError("missing_execution_identity", "新轮次缺少执行身份");
        if (session?.state !== "idle" || !this.runners.has(command.sessionId)) throw new ConnectorError("session_not_ready", "本机会话尚未准备好或旧执行待核实");
      }
      const accepted = this.store.accept(command); this.notify(accepted);
      let dispatched = false;
      try {
        const runner = command.method === "openSession" || command.method === "catalog"
          ? await this.runner(command.sessionId, workspace,command.executionScope) : this.runners.get(command.sessionId);
        if (!runner) throw new ConnectorError("session_not_open", "请先建立或恢复本机会话");
        if(command.executionScope && ['startTurn','steerTurn'].includes(command.method)) {
          const catalog=await runner.catalog();
          this.sharedRuntimes.get(command.sessionId)!.assertSkillCatalog(catalog.skills);
          this.sharedRuntimes.get(command.sessionId)!.setModelDefaults(catalog.models.map(model=>{const descriptor=model.capabilities?.optionDescriptors?.find(value=>value.id==='reasoningEffort');return {id:model.slug,effort:descriptor?.type==='select'?descriptor.options.find(value=>value.isDefault)?.id??null:null}}));
        }
        if (command.method === "openSession") {
          const epochReceipt: CustomerAgentReceipt = { ...accepted, runtimeEpoch: runner.processGeneration };
          this.store.finish(epochReceipt); this.notify(epochReceipt);
        }
        if (command.method === "startTurn" || command.method === "steerTurn") {
          if (input.message) input.message = await resolveCustomerFileReferences(this.store, this.deviceId, command.target, input.message, this.shutdown.signal);
          const attachments=command.executionScope?this.sharedAttachments.get(command.sessionId):this.attachments;
          if (attachments) await attachments.prepare(command, this.shutdown.signal, () => { this.store.resolveWorkspace(command.target); });
          else if (input.message?.attachments?.length || command.attachments?.length) throw new ConnectorError("attachment_unavailable", "请更新连接程序后再发送附件");
          const requestedNames = input.assistantConfiguration?.skillNames ?? [];
          if (!Array.isArray(requestedNames) || requestedNames.length > 32 || requestedNames.some((name: unknown) => typeof name !== "string")) throw new ConnectorError("invalid_input", "助手技能选择无效");
          const mentions = [...String(input.message?.text ?? "").matchAll(SKILL_MENTION_PATTERN)].map((match) => match[2]!);
          if (input.assistantConfiguration && mentions.some(name => !requestedNames.includes(name))) throw new ConnectorError("skill_not_selected", "该技能不在本次助手配置中");
          const names = [...new Set([...requestedNames, ...mentions])];
          if (names.length) {
            const { skills } = await runner.catalog();
            for (const name of names) {
              const expected = command.skillBindings?.filter((skill) => skill.name === name) ?? [];
              const actual = skills.filter((skill) => skill.enabled && skill.name === name);
              if (expected.length !== 1 || actual.length !== 1 || expected[0]!.id !== customerSkillId(workspace.registeredWorkspaceId, actual[0]!.path)) {
                throw new ConnectorError("skill_catalog_changed", "所选本机技能已变更或有重名，请刷新能力目录后重新选择");
              }
            }
          }
        }
        if (command.method === "steerTurn" && this.providerTurns.get(command.sessionId) !== input.providerTurnId) throw new ConnectorError("stale_turn", "这条消息对应的轮次已结束，请重新发送");
        this.shutdown.signal.throwIfAborted();
        this.store.resolveWorkspace(command.target, command.method === "interruptTurn" || command.method === "readThreadSnapshot");
        if(command.executionScope && command.method!=='interruptTurn')await this.sharedRuntimes.get(command.sessionId)?.assertCurrent();
        if (command.method === "startTurn") {
          if (input.providerThread?.nativeThreadRef?.nativeId) {
            this.providerThreads.set(command.sessionId, input.providerThread);
          }
          this.store.transaction(() => {
            this.store.acquireWorkspace(workspace.registeredWorkspaceId, command.sessionId, String(input.runId));
            this.store.saveSession({ ...this.store.session(command.sessionId)!, state: "active", runId: String(input.runId), attemptId: String(input.attemptId) });
          });
        }
        dispatched = true;
        nativeAttempted = true;
        const result = command.method === "catalog" ? await this.catalogSnapshot(workspace, runner) : await runner.dispatch(command.method, input);
        if(command.executionScope && command.method!=='interruptTurn')await this.sharedRuntimes.get(command.sessionId)?.assertCurrent();
        if (Buffer.byteLength(JSON.stringify(result)) > 900 * 1024) throw new ConnectorError("result_too_large", "运行结果超过首版单次传输上限；原执行不会被自动重做");
        if (["ensureThread", "resumeThread"].includes(command.method) && result && typeof result === "object") {
          const thread = result as { nativeThreadRef?: { nativeId?: string } };
          if (thread.nativeThreadRef?.nativeId) {
            this.providerThreads.set(command.sessionId, result);
            this.store.saveSession({ ...this.store.session(command.sessionId)!, nativeThreadId: thread.nativeThreadRef.nativeId });
          }
        }
        if (command.method === "respondToRuntimeRequest") this.requests.get(command.sessionId)?.delete(String(input.requestId));
        const receipt: CustomerAgentReceipt = { type: "receipt", commandId: command.commandId, sessionId: command.sessionId,
          runtimeEpoch: runner.processGeneration, state: "completed", result,...(command.executionScope?{grantId:command.executionScope.grantId}:{}) };
        this.store.finish(receipt); this.notify(receipt); return receipt;
      } catch (error) {
        const notStarted = typeof error === "object" && error !== null && "outcome" in error && error.outcome === "not_started";
        if (notStarted) nativeAttempted = false;
        const uncertain = dispatched && !notStarted && !["catalog", "readThreadSnapshot"].includes(command.method);
        if (command.method === "startTurn" && notStarted) {
          const active = this.store.session(command.sessionId);
          if (active && active.runId === input.runId) {
            this.store.releaseWorkspace(active.workspaceId, command.sessionId, active.runId!);
            this.store.saveSession({ ...active, state: "idle", runId: null, attemptId: null });
          }
        }
        if (uncertain) this.markUnknown(command.sessionId, "原生命令结果待确认，不自动重发");
        const receipt = errorReceipt(command, error, uncertain ? "unknown" : "failed");
        this.store.finish(receipt); this.notify(receipt); return receipt;
      }
    } catch (error) {
      // A second journal failure after a native call must not downgrade unknown execution
      // into a preflight failure: the center uses failed as safe-to-release evidence.
      const uncertain = nativeAttempted && !["catalog", "readThreadSnapshot"].includes(command.method);
      if (uncertain) {
        try { this.markUnknown(command.sessionId, "原生操作后恢复日志未能完整保存，执行结果待核实", "journal_unavailable"); } catch { /* Preserve unknown in the receipt even if storage is unavailable. */ }
      }
      const receipt = errorReceipt(command, error, uncertain ? "unknown" : "failed"); this.notify(receipt); return receipt;
    }
  }
  async capabilities(workspace: LocalWorkspace): Promise<CustomerCapabilityInput> {
    this.store.resolveWorkspace(workspace);
    // Discovery does not leave a permanent app-server per registered directory.
    const runner = await this.runnerFactory({ instanceId: `customer-${this.deviceId}-codex`, cwd: workspace.realPath,
      localPolicy: workspace.policy, onEvent: () => {} });
    this.discoveryRunners.add(runner);
    let own:CustomerCapabilityInput;
    try { own=await this.catalogSnapshot(workspace, runner); } finally { this.discoveryRunners.delete(runner); await runner.close(); }
    if(!workspace.sharedProfilePath)return own;
    let isolated:SharedDockerRuntime|undefined,sharedRunner:HeadlessCodexRunner|undefined;
    try {
      const profile=await loadSharedDockerProfile(workspace.sharedProfilePath),scope:SharedExecutionScope={
        grantId:'local-catalog-only',actorId:'local-catalog',providerId:'local-catalog',projectId:workspace.projectId,sourceProjectId:workspace.projectId,
        threadId:`catalog-${workspace.registeredWorkspaceId}`,runId:'catalog-only',assistantId:'local-catalog',presetRevision:1,shareRevision:1,
        allocation:{kind:'member',id:'local-catalog',revision:1},capabilityRevision:'local-discovery',profile:profile.descriptor,
        target:{kind:'customer',deviceId:this.deviceId,registeredWorkspaceId:workspace.registeredWorkspaceId,workspaceBindingRevision:workspace.workspaceBindingRevision,runtimeId:workspace.runtimeId},
        model:{instanceId:`customer-${this.deviceId}-codex`,model:'catalog-only',reasoningEffort:null},skillIds:[],
      };
      isolated=await createSharedDockerRuntime({directory:this.store.directory,workspace,sessionId:scope.threadId,scope,discovery:true,authorize:async()=>{throw new ConnectorError('shared_discovery_only','能力发现不能发起模型执行')}});
      sharedRunner=await this.isolatedRunner({instanceId:`customer-${this.deviceId}-codex`,cwd:workspace.realPath,localPolicy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false},...isolated.options,onEvent:()=>{}},isolated);
      this.discoveryRunners.add(sharedRunner);
      const catalog=await this.catalogSnapshot(workspace,sharedRunner);
      const sharedProfile={...profile.descriptor,models:catalog.models,skills:catalog.skills};
      return {...own,sharedProfile,revision:createHash('sha256').update(JSON.stringify({own:own.revision,sharedProfile})).digest('hex')};
    } catch {
      this.onState('共享隔离能力发现未完成；当前仅发布已实际读取的自用能力，不开放共享执行');
      return own;
    } finally {
      if(sharedRunner){this.discoveryRunners.delete(sharedRunner);await sharedRunner.close()}
      if(isolated)await isolated.close();
    }
  }
  private async catalogSnapshot(workspace: LocalWorkspace, runner: HeadlessCodexRunner): Promise<CustomerCapabilityInput> {
    const catalog = await runner.catalog();
    return {
      registeredWorkspaceId: workspace.registeredWorkspaceId, workspaceBindingRevision: workspace.workspaceBindingRevision,
      runtimeId: "codex", protocolVersion: 1,
      workspaceFiles: true, assistantConfiguration: true,
      ...(this.attachments ? {attachments: CUSTOMER_ATTACHMENT_LIMITS} : {}),
      revision: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
      models: catalog.models.map((model) => {
        const effort = model.capabilities?.optionDescriptors?.find((option) => option.id === "reasoningEffort");
        const defaultEffort = effort?.type === "select" ? effort.options.find((option) => option.isDefault)?.id : undefined;
        return { id: model.slug, name: model.name,
          ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort }),
          supportedReasoningEfforts: effort?.type === "select" ? effort.options.map((option) => option.id) : [] };
      }),
      skills: catalog.skills.filter((skill) => skill.enabled).map((skill) => ({
        id: customerSkillId(workspace.registeredWorkspaceId, skill.path),
        name: skill.name, description: skill.description ?? "",
      })),
      permissions: { approvalPolicy: workspace.policy.approvalPolicy, sandboxMode: workspace.policy.sandboxMode },
    };
  }
  private async requestLocalStop(sessionId: string, message: string): Promise<void> {
    if (this.stopping.has(sessionId)) return;
    const runner = this.runners.get(sessionId), providerTurnId = this.providerTurns.get(sessionId), providerThread = this.providerThreads.get(sessionId);
    if (!runner || !providerTurnId || !providerThread) return;
    this.stopping.add(sessionId); this.onState(message);
    try { await runner.dispatch("interruptTurn", { providerTurnId, providerThread }); }
    catch { this.markUnknown(sessionId, "本机停止结果待确认"); }
  }
  enforceLocalRevocations(): void {
    const revoked = new Set(this.store.workspaces().filter((workspace) => workspace.revoked).map((workspace) => workspace.registeredWorkspaceId));
    for (const session of this.store.sessions()) {
      if (revoked.has(session.workspaceId) && session.state === "active") void this.requestLocalStop(session.sessionId, "本机目录授权已撤销，正在请求停止活动执行");
    }
  }
  hasActivity(): boolean {
    return this.executing > 0 || this.store.sessions().some((session) => session.state !== "idle" && this.runners.has(session.sessionId));
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.runners.values(), ...this.discoveryRunners].map((runner) => runner.close()));
    await Promise.allSettled([...this.commands]);
    for(const [sessionId,runtime] of this.sharedRuntimes) {
      try {await runtime.close()} catch {this.markUnknown(sessionId,'隔离容器停止结果待核实')}
    }
    this.sharedRuntimes.clear();this.sharedAttachments.clear();
    for (const session of this.store.sessions()) if (session.state === "active") this.markUnknown(session.sessionId, "连接程序退出，旧执行需核实");
    this.runners.clear();
  }
}
