import type { AutoOpsAccess, AutoOpsPrincipal } from './access.mjs';
export interface BusinessSkill {name:string;description:string;instructions:string;tools:string[];displayName?:string;enabled?:boolean;builtin?:boolean}
export interface BusinessSkillRegistry {version:number;skills:BusinessSkill[]}
export const BUSINESS_SKILL_TOOLS:readonly string[];
export function readBusinessSkillRegistry(dataDirectory:string):BusinessSkillRegistry;
export function businessSkillsRevision(registry:BusinessSkillRegistry):string;
export function businessSkillContents(skill:BusinessSkill):string;
export function manageBusinessSkills(dataDirectory:string,codexHome:string,access:AutoOpsAccess,principal:AutoOpsPrincipal,input:{action:'toggle';revision:string;name:string;enabled:boolean}|{action:'import';revision:string;skill:BusinessSkill}):BusinessSkillRegistry;
export function resolveBusinessSkillMentions(text:string,env?:Record<string,string|undefined>):{type:'skill';name:string;path:string}[];
export function readBusinessSkills(dataDirectory:string):BusinessSkill[];
export function prepareBusinessSkills(dataDirectory:string,codexHome:string):{name:string;path:string;description:string;enabled:true}[];
export function filterBusinessSkills<T extends {name:string;path:string;enabled:boolean}>(skills:readonly T[],env?:Record<string,string|undefined>):readonly T[];
export function businessSlashCommands<T extends {name:string}>(commands:readonly T[],env?:Record<string,string|undefined>):readonly T[];
export function businessSkillRules(dataDirectory:string,codexHome:string,options?:{userHome?:string;extraRoots?:string[]}):{path:string;enabled:boolean}[];
