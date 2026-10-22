import type { AutoOpsAccess,AutoOpsPrincipal } from './access.mjs';
export function readImportedDrafts(access:AutoOpsAccess,principal:AutoOpsPrincipal,dataDirectory:string):{id:string;threadId:string;text:string;attachments:{id:string;type:string;name:string;mimeType:string;sizeBytes:number}[]}[];
