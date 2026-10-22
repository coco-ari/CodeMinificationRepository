import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
const {job,limits,resourcesDirectory}=workerData
const fail=(code,message)=>{throw Object.assign(new Error(message),{code})}
const formats={
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
 'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
}
async function extract(file) {
 const mime=String(file.mime||'application/octet-stream').split(';',1)[0].trim().toLowerCase()
 const extension=/\.([^.]+)$/u.exec(String(file.name))?.[1]?.toLowerCase()
 const format=formats[mime] || (['docx','xlsx','pptx'].includes(extension)?extension:null)
 if(!format) {
  const {extractAttachment}=await import('../attachments.mjs')
  return extractAttachment(file,{maxBytes:limits.maxBytes,maxPages:limits.maxPages,maxTextCharacters:limits.maxTextCharacters,timeoutMs:Math.min(10_000,limits.timeoutMs)})
 }
 const bytes=Buffer.from(file.bytes)
 if(bytes.readUInt32LE(0)!==0x04034b50)fail('INVALID_OFFICE_ARCHIVE','Office 文件不是有效的未加密 OOXML 文档。')
 // Mature ZIP reader inspects metadata without inflating anything. The parser
 // never extracts files to disk or evaluates embedded VBA/formulas/scripts.
 const {unzipSync}=await import('fflate')
 let expanded=0,entries=0,slides=0
 unzipSync(bytes,{filter:entry=>{
  expanded+=entry.originalSize;entries++
  if(/^ppt\/slides\/slide\d+\.xml$/u.test(entry.name))slides++
  if(slides>limits.maxPages)fail('OFFICE_PAGE_LIMIT','演示文稿页数超过上限，请拆分文件。')
  if(expanded>limits.maxExpandedBytes || entries>limits.maxArchiveEntries)fail('OFFICE_ARCHIVE_LIMIT','Office 压缩包展开后过大或条目过多，请拆分文档。')
  if(/(?:^|\/)vbaProject\.bin$/iu.test(entry.name))fail('OFFICE_MACRO_UNSUPPORTED','请将含宏文档另存为不含宏的 DOCX、XLSX 或 PPTX。')
  return false
 }})
 const {parseOffice}=await import('officeparser')
 const ast=await parseOffice(bytes,{fileType:format,allowRemoteAssets:false,ocr:false,extractAttachments:false,includeRawContent:false,serializeRawContent:false,ignoreNotes:false,ignoreComments:false,decompressionLimits:{maxUncompressedBytes:limits.maxExpandedBytes,maxZipEntries:limits.maxArchiveEntries,maxTableCells:100000,maxXmlElements:200000,maxRepeatedContent:limits.maxTextCharacters}})
 // Preserve workbook boundaries that the upstream flat text renderer omits.
 for(const node of ast.content) if(node.type==='sheet'&&node.metadata?.sheetName) node.children=[{type:'paragraph',children:[{type:'text',text:`[工作表：${node.metadata.sheetName}]`}]},...(node.children||[])]
 const generated=await ast.to('text',{includeImages:'none',textConfig:{preserveLayout:true,renderNotes:true}})
 const content=generated.value
 if(typeof content!=='string'||!content.trim())fail('OFFICE_NO_TEXT','文档没有可提取的正文；图片未运行 OCR。')
 if(content.length>limits.maxTextCharacters)fail('TEXT_CHARACTER_LIMIT','文档正文超过长度上限，请拆分后重试；没有截取内容冒充全文。')
 const warnings=[...(ast.warnings||[]),...(generated.messages||[])].map(item=>({code:String(item.code||'PARSER_NOTICE'),message:String(item.message||item)}))
 if(warnings.some(item=>/LIMIT|TRUNCAT|REPEATED_CONTENT/u.test(item.code)))fail('OFFICE_PARTIAL_EXTRACTION','文档超过解析范围；没有将部分正文冒充全文，请拆分后重试。')
 const {bytes:_bytes,...metadata}=file
 return {...metadata,mime,readable:true,content,extraction:{status:'ready',format,engine:'officeparser@8.2.0',textCharacters:content.length,warnings,coverage:'正文、表格及库可提取的备注；不执行宏、公式、外部链接，不对图片做 OCR。'}}
}
async function pdf(content) {
 const {PDFDocument}=await import('pdfkit')
 const font=join(resourcesDirectory,'business-documents.font.otf')
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true,font,info:{Title:'AutoOps 工作台报告',Creator:'AutoOps / PDFKit 0.20.2'}})
  const chunks=[];let bytes=0,pages=1
  doc.on('data',chunk=>{bytes+=chunk.length;if(bytes>limits.maxExpandedBytes)doc.destroy(Object.assign(new Error('PDF 文件超过大小上限。'),{code:'PDF_SIZE_LIMIT'}));else chunks.push(chunk)})
  doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)))
  doc.on('pageAdded',()=>{pages++;if(pages>limits.maxPages)throw Object.assign(new Error('PDF 页数超过上限，请拆分报告。'),{code:'PDF_PAGE_LIMIT'})})
  try {
   doc.font(font).fontSize(10.5).fillColor('#17202a')
   for(const paragraph of content.replace(/\r\n?/gu,'\n').split('\n')) {
    const heading=/^(#{1,3}) (.+)$/u.exec(paragraph)
    if(heading)doc.fontSize(heading[1].length===1?19:heading[1].length===2?14:12).text(heading[2],{paragraphGap:8,lineGap:3}).fontSize(10.5)
    else if(paragraph.trim())doc.text(paragraph,{paragraphGap:4,lineGap:3})
    else doc.moveDown(0.35)
   }
   const range=doc.bufferedPageRange()
   for(let i=range.start;i<range.start+range.count;i++){
    doc.switchToPage(i);doc.fontSize(8).fillColor('#687180')
    const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0
    doc.text(`AutoOps  ·  ${i+1} / ${range.count}`,48,doc.page.height-30,{width:doc.page.width-96,align:'center',lineBreak:false});doc.page.margins.bottom=bottom
   }
   doc.end()
  }catch(error){doc.destroy();reject(error)}
 })
}
try {
 const value=job.type==='pdf'?await pdf(job.content):await extract(job.file)
 parentPort.postMessage({value})
}catch(error){parentPort.postMessage({error:{code:error.code||'DOCUMENT_PARSER_ERROR',message:error.code?error.message:'文档解析失败，请检查格式、密码或内容。'}})}
