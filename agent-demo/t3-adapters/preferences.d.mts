import type { DatabaseSync } from 'node:sqlite';
export interface PersonalChange { principalId:string; threadId:string; revision:number }
export type PersonalReceipt = {handled:false} | {handled:true;sequence:number;revision:number;threadId:string};
export interface PersonalPreferences {
  applyCommand(principalId:string, command:{type:string;commandId?:string;threadId?:string;[key:string]:unknown}, context?:{thread: {id:string;[key:string]:unknown}|null;nativeSequence:number}):PersonalReceipt;
  overlayThread<T extends {id:string}>(principalId:string, thread:T):T;
  overlayProjection<T>(principalId:string, projection:T):T;
  overlayShell<T>(principalId:string, snapshot:T, options?:{location?:'active'|'archive'|'all'}):T;
  setTimestampDecoder(decoder:(value:string)=>unknown):void;
  subscribe(principalId:string,listener:(change:PersonalChange)=>void):()=>void;
  revision(principalId:string):number;
  dispose():void;
}
export function isPersonalPreferenceCommand(command:unknown):boolean;
export function initializePreferencesSchema(db:DatabaseSync):void;
export function createPreferences(options:{db:DatabaseSync;now?:()=>number;decodeTimestamp?:(value:string)=>unknown}):PersonalPreferences;
export function configuredPreferences(decodeTimestamp?:(value:string)=>unknown):PersonalPreferences|undefined;
