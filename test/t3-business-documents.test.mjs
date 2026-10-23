import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {zipSync,strToU8} from 'fflate'
import {extractBusinessAttachment,renderBusinessPdf} from '../agent-demo/t3-adapters/business-documents.mjs'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
const fixture=async name=>({id:name,name,mime:'application/octet-stream',bytes:await readFile(new URL(`./t3-business-documents-fixtures/${name}`,import.meta.url))})
for(const [name,needles] of [
 ['release.docx',['发布检查文档','林涛','检查项','备份','通过']],
 ['resources.xlsx',['工作表：服务器资源','demo-157','demo-154','16','32','工作表：备注','禁止生产发布']],
 ['review.pptx',['工作台发布评审','回滚方案','第二页','人工审批']],
])test(`real ${name} extracts Chinese text and structure`,async()=>{
 const result=await extractBusinessAttachment(await fixture(name));assert.equal(result.readable,true);assert.equal(result.extraction.engine,'officeparser@8.2.0');
 for(const text of needles)assert.ok(result.content.includes(text),text);assert.deepEqual(result.extraction.warnings,[]);
})
test('Office parser refuses malformed, macro and oversized expanded archives without fabricated text',async()=>{
 const bad=await extractBusinessAttachment({id:'bad',name:'bad.docx',mime:'application/octet-stream',bytes:Buffer.from('not an office file')});assert.equal(bad.readable,false);assert.equal(bad.content,undefined);
 const macro=await extractBusinessAttachment({id:'macro',name:'macro.docx',mime:'application/octet-stream',bytes:zipSync({'word/vbaProject.bin':strToU8('unexecuted macro')})});assert.equal(macro.extraction.code,'OFFICE_MACRO_UNSUPPORTED');
 const huge=await extractBusinessAttachment({id:'huge',name:'huge.docx',mime:'application/octet-stream',bytes:zipSync({'word/document.xml':strToU8('x'.repeat(2048))})},{maxExpandedBytes:1024});assert.equal(huge.extraction.code,'OFFICE_ARCHIVE_LIMIT');
 const partial=await extractBusinessAttachment(await fixture('release.docx'),{maxTextCharacters:10});assert.equal(partial.readable,false);assert.equal(partial.content,undefined);assert.equal(partial.extraction.code,'TEXT_CHARACTER_LIMIT');
})
test('worker timeout terminates parser and never returns partial text',async()=>{
 const result=await extractBusinessAttachment(await fixture('release.docx'),{timeoutMs:1});assert.equal(result.extraction.code,'DOCUMENT_TIMEOUT');assert.equal(result.content,undefined);
})
test('existing text/PDF readers remain available through the same authorized-byte adapter',async()=>{
 const result=await extractBusinessAttachment({id:'t',name:'notes.txt',mime:'text/plain',bytes:Buffer.from('真实文本附件')});assert.equal(result.content,'真实文本附件');
})
test('Chinese PDF has real embedded searchable glyphs, no footer-only pages and bounded pages',async()=>{
 const content='# AutoOps 发布准备报告\n\n## 检查结果\n'+Array.from({length:85},(_,i)=>`检查记录 ${i+1}：核对附件、环境快照、备份和回滚步骤，保留真实数据与审计依据。`).join('\n');
 const bytes=await renderBusinessPdf(content);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>1000);
 const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,isEvalSupported:false});const doc=await task.promise;let text='';assert.ok(doc.numPages>1 && doc.numPages<6);
 for(let p=1;p<=doc.numPages;p++){const page=await doc.getPage(p);const pageText=(await page.getTextContent()).items.map(x=>x.str||'').join('');assert.ok(pageText.includes('检查记录'),`page ${p} must contain body`);assert.ok(pageText.includes(`${p} / ${doc.numPages}`));text+=pageText}
 assert.ok(text.includes('AutoOps 发布准备报告'));assert.ok(text.includes('检查记录 85'));await task.destroy();
 await mkdir('.test-artifacts/t3-business-documents',{recursive:true});await writeFile('.test-artifacts/t3-business-documents/chinese-report.pdf',bytes);
 const reread=await extractBusinessAttachment({id:'pdf',name:'report.pdf',mime:'application/pdf',bytes});assert.equal(reread.readable,true);assert.ok(reread.content.includes('检查记录 85'));
 await assert.rejects(renderBusinessPdf(content,{maxPages:1}),{code:'PDF_PAGE_LIMIT'});
})
test('font provenance hash matches deployed OFL licensed asset',async()=>{
 const sources=JSON.parse(await readFile(new URL('../agent-demo/t3-adapters/business-documents.sources.json',import.meta.url)));
 const font=await readFile(new URL('../agent-demo/t3-adapters/business-documents.font.otf',import.meta.url));assert.equal(createHash('sha256').update(font).digest('hex'),sources.font.sha256);
 const license=await readFile(new URL('../agent-demo/t3-adapters/business-documents.font.LICENSE',import.meta.url),'utf8');assert.match(license,/SIL OPEN FONT LICENSE Version 1.1/);
})


test('各入口共享文档处理总并发预算，忙时保留原件并允许之后重试', async () => {
 const input = { id:'并发资料', name:'资料.txt', mime:'text/plain', bytes:Buffer.from('工作区资料') }
 const first = extractBusinessAttachment(input)
 const second = renderBusinessPdf('共享资料与问答报告的解析预算')
 const busy = await extractBusinessAttachment(input)
 assert.equal(busy.readable,false)
 assert.equal(busy.extraction.code,'DOCUMENT_BUSY')
 assert.equal(busy.content,undefined)
 const [text,pdf] = await Promise.all([first,second])
 assert.equal(text.content,'工作区资料')
 assert.equal(pdf.subarray(0,5).toString(),'%PDF-')
 assert.equal((await extractBusinessAttachment(input)).content,'工作区资料')
})
