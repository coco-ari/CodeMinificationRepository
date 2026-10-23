export const personalSettingsKeys: readonly string[];
export function assertPersonalSettingsPatch(patch:unknown,env?:NodeJS.ProcessEnv):void;
export interface SettingsPreferences {
  dispose(): void;
  read(principalId:string):Record<string,unknown>;
  overlay<T>(principalId:string,settings:T):T;
  update(principalId:string,patch:unknown):Record<string,unknown>;
  subscribe(principalId:string,listener:()=>void):()=>void;
}
export function createSettingsPreferences(options:{db:unknown;env?:NodeJS.ProcessEnv}):SettingsPreferences;
export function configuredSettingsPreferences():SettingsPreferences|undefined;

export function closeConfiguredSettingsPreferences(): void;
