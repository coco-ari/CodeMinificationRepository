import type { ChildProcess } from 'node:child_process';
export interface T3WorkerConfiguration {
  dataDir:string; baseDir:string; homePath:string; binaryPath:string;
  settings:{
    providerInstances:{codex:{driver:'codex';enabled:boolean;config:{binaryPath:string;homePath:string;launchArgs:string;customModels:string[]}}};
    defaultModelSelection:{instanceId:string;model:string};
    [key:string]:unknown;
  };
}
export function buildT3WorkerConfiguration(env?:Record<string,string|undefined>):T3WorkerConfiguration;
export function prepareT3Worker(env?:Record<string,string|undefined>):T3WorkerConfiguration&{childEnv:Record<string,string|undefined>};
export function startT3Worker(env?:Record<string,string|undefined>):ChildProcess;
