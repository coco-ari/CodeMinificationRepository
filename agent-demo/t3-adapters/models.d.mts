export interface BusinessModel {
  id:string;name:string;reasoningLevels:string[];defaultReasoning:string|null;
  inputModalities:string[];contextWindow:number|null;supportsReasoningEffortUpdates:boolean;
}
export interface BusinessModels { discovered:boolean;source?:string;fetchedAt?:string;models:BusinessModel[] }
export function normalizeCpaModels(value:unknown):BusinessModel[];
export function readBusinessModels(directory:string|undefined,defaultModel:string,expectedSource?:string):BusinessModels;
export function configuredBusinessModels(env?:Record<string,string|undefined>):BusinessModels;
export function requireBusinessModel(model:string,env?:Record<string,string|undefined>):BusinessModel;
export function assertBusinessModelSelection(selection:unknown,env?:Record<string,string|undefined>):void;
export function cpaModelsUrl(baseUrl:string):string;
export function synchronizeBusinessModels(env?:Record<string,string|undefined>,fetcher?:typeof fetch):Promise<BusinessModels|undefined>;
