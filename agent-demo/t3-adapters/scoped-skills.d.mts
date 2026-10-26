import type { AutoOpsAccess, AutoOpsPrincipal, ThreadBinding } from './access.mjs';
export interface SkillScope {skillIds?:readonly string[];question?: {configuration:{skillIds:readonly string[]}};projectId:string;agentId:string;workspaceType?:'internal'|'external';workspaceVersionId?:string;environmentId?:string|null;threadId?:string;nativeParentThreadId?:string}
export interface ScopedSkill {id:string;skillId:string;name:string;versionId:string;contentHash:string;packageRoot:string;path:string;description:string;displayName:string;enabled:true;readiness:'ready';files:{path:string;size:number;sha256:string;mime?:string;binary?:boolean}[];tools?:string[]}
export interface SkillContext {snapshotId:string;scope:SkillScope;skills:ScopedSkill[];physicalCwd:string;cwd:string}
export function prepareScopedBusinessSkills(directory:string,binding:SkillScope,options?:{lock?:boolean}):SkillContext;
export function resolveBusinessSkillContext(directory:string,input:Partial<SkillScope>,options:{access?:AutoOpsAccess;principal:AutoOpsPrincipal}):{cwd:string;snapshotId:string;skills:{name:string;displayName:string;description:string;versionId:string;contentHash:string;enabled:true}[]};
export function authorizeBusinessSkillCwd(directory:string,cwd:string,options:{access?:AutoOpsAccess;principal:AutoOpsPrincipal}):string;
export function scopedBusinessSkillsForCwd(directory:string,cwd:string):ScopedSkill[];
export function scopedBusinessSkillPolicy(directory:string,binding:ThreadBinding):{context:SkillContext;resources:{name:string;versionId:string;instructionsPath:string;resourcesRoot:string}[];config:Record<string,import('./native-catalog.mjs').NativePolicyValue>};
export function readScopedSkillResource(directory:string,contextId:string,name:string,path:string,options:{access?:AutoOpsAccess;principal?:AutoOpsPrincipal;threadId?:string}):{name:string;path:string;mime:string;bytes:Buffer;versionId:string;binary:boolean;sourceUrl:string};
export function readScopedSkillResourceForThread(directory:string,threadId:string,path:string,access?:AutoOpsAccess):Record<string,unknown>;

export function scopedBusinessSkillPolicyForCwd(directory:string,cwd:string):ReturnType<typeof scopedBusinessSkillPolicy>;
export function filterBusinessProviderResult<T>(directory:string,value:T,options:{access?:AutoOpsAccess;principal:AutoOpsPrincipal}):T;
