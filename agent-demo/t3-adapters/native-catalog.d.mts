export function fixedNativeModelCatalog(model:string):{models:Record<string,unknown>[]};
export function businessNativeModelCatalog(dataDirectory:string,defaultModel:string):{models:Record<string,unknown>[]};
export type NativePolicyValue = null|string|number|boolean|NativePolicyValue[]|{[key:string]:NativePolicyValue};
export function businessNativePolicy(dataDirectory:string,codexHome:string,model:string,env?:NodeJS.ProcessEnv):Record<string,NativePolicyValue>;
export function prepareBusinessNativePolicy(dataDirectory:string,codexHome:string,model:string,env?:NodeJS.ProcessEnv):{policy:Record<string,NativePolicyValue>;skills:{name:string;path:string;description:string;enabled:true}[]};
export function configuredBusinessNativePolicy(env?:Record<string,string|undefined>):Record<string,NativePolicyValue>;
export function assertBusinessNativeConfig(response:unknown,env?:Record<string,string|undefined>):void;
export function refreshBusinessSkillLaunchArgs(launchArgs:string,env?:Record<string,string|undefined>):string;
