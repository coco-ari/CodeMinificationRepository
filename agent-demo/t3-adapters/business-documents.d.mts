export interface DocumentLimits {maxBytes?:number;maxTextCharacters?:number;maxPages?:number;timeoutMs?:number;maxExpandedBytes?:number;maxArchiveEntries?:number}
export const BUSINESS_DOCUMENT_LIMITS: Readonly<Required<DocumentLimits>>;
export class BusinessDocumentError extends Error {code:string}
export function extractBusinessAttachment(file:{id:string;name:string;mime:string;bytes:Uint8Array},options?:DocumentLimits):Promise<{id:string;name:string;mime:string;size:number;readable:boolean;content?:string;extraction:{status:string;code?:string;message?:string;[key:string]:unknown}}>
export function renderBusinessPdf(content:string,options?:DocumentLimits):Promise<Buffer>;
