import type { AutoOpsAccess, AutoOpsPrincipal } from './access.mjs';
export function handleSkillLibraryRequest(input:{access:AutoOpsAccess;principal:AutoOpsPrincipal;url:URL;method:string;input?:unknown;dataDirectory:string}):Promise<{status:number;body?:unknown;file?:{name:string;mime:string;bytes:Uint8Array}}>;
