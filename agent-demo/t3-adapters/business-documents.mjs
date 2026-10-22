import { Worker } from 'node:worker_threads'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUSINESS_DOCUMENT_LIMITS = Object.freeze({ maxBytes:8*1024*1024, maxTextCharacters:500_000, maxPages:100, timeoutMs:15_000, maxExpandedBytes:64*1024*1024, maxArchiveEntries:2048 })
export class BusinessDocumentError extends Error {
  constructor(code,message) { super(message);this.name='BusinessDocumentError';this.code=code }
}
const resourcesDirectory = () => process.env.AUTOOPS_BUSINESS_RESOURCES_DIR
  ? resolve(process.env.AUTOOPS_BUSINESS_RESOURCES_DIR) : dirname(fileURLToPath(import.meta.url))
function limitsFor(options={}) {
  const limits={...BUSINESS_DOCUMENT_LIMITS}
  for(const key of Object.keys(limits)) if(options[key]!==undefined) {
    if(!Number.isSafeInteger(options[key]) || options[key]<1 || options[key]>limits[key]) throw new RangeError(`Invalid document limit: ${key}`)
    limits[key]=options[key]
  }
  return limits
}
function runWorker(job,limits) {
  return new Promise((resolveResult,reject)=>{
    const worker = new Worker(resolve(resourcesDirectory(),'business-documents.worker.mjs'), {
      workerData:{job,limits,resourcesDirectory:resourcesDirectory()},execArgv:[],
      resourceLimits:{maxOldGenerationSizeMb:256,stackSizeMb:4},
    })
    let settled=false
    const finish=(error,result)=>{
      if(settled)return;settled=true;clearTimeout(timer)
      void worker.terminate().then(()=>error?reject(error):resolveResult(result),reject)
    }
    const timer=setTimeout(()=>finish(new BusinessDocumentError('DOCUMENT_TIMEOUT','文档处理超时，请拆分后重试；未返回不完整正文。')),limits.timeoutMs)
    worker.once('message',result=>result.error?finish(new BusinessDocumentError(result.error.code,result.error.message)):finish(null,result.value))
    worker.once('error',error=>finish(new BusinessDocumentError(error.code==='ERR_WORKER_OUT_OF_MEMORY'?'DOCUMENT_RESOURCE_LIMIT':'DOCUMENT_WORKER_ERROR','文档解析或渲染失败，请检查文件。')))
    worker.once('exit',()=>finish(new BusinessDocumentError('DOCUMENT_WORKER_EXIT','文档处理没有完成。')))
  })
}

/** Receives already-authorized bytes only. Never fetches a URL or opens a supplied path. */
export async function extractBusinessAttachment({id,name,mime,bytes},options={}) {
  if(!(bytes instanceof Uint8Array))throw new TypeError('Attachment bytes must be a Uint8Array')
  const limits=limitsFor(options),file={id,name,mime,size:bytes.byteLength}
  if(bytes.byteLength>limits.maxBytes)return {...file,readable:false,extraction:{status:'unavailable',code:'ATTACHMENT_SIZE_LIMIT',message:'附件超过文本提取大小上限。'}}
  try {return await runWorker({type:'extract',file:{...file,bytes:new Uint8Array(bytes)}},limits)}
  catch(error){return {...file,readable:false,extraction:{status:'unavailable',code:error.code||'DOCUMENT_PARSER_ERROR',message:error.message}}}
}

/** PDFKit embeds the tracked OFL CJK font. No browser, network, shell or macros. */
export async function renderBusinessPdf(content,options={}) {
  const limits=limitsFor(options)
  if(typeof content!=='string'||!content.trim()||content.length>limits.maxTextCharacters)throw new BusinessDocumentError('INVALID_PDF_TEXT','PDF 正文为空或超过长度上限。')
  return Buffer.from(await runWorker({type:'pdf',content},limits))
}
