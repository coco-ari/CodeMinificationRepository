import { parentPort, workerData } from 'node:worker_threads'
import { dirname, join, sep } from 'node:path'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

// PDF parsing is provided by Mozilla PDF.js, Apache-2.0. This follows its Node
// getinfo.mjs example: getDocument -> getPage -> getTextContent. We do not execute
// PDF JavaScript, render images, use network URLs, or attempt OCR.
const require = createRequire(import.meta.url)

async function extract() {
  let task
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const packageRoot = dirname(require.resolve('pdfjs-dist/package.json'))
    const { bytes, limits } = workerData
    // Use PDF.js's asset-factory extension point. Only packaged parser resources
    // are readable; a PDF-provided name cannot become a URL or arbitrary path.
    class PackagedPdfAssets {
      async fetch({ kind, filename }) {
        const directory = {
          cMapUrl: 'cmaps',
          standardFontDataUrl: 'standard_fonts',
          wasmUrl: 'wasm',
        }[kind]
        if (
          !directory ||
          typeof filename !== 'string' ||
          filename.length > 256 ||
          !/^[A-Za-z0-9_.-]+$/.test(filename) ||
          filename.includes('..')
        )
          throw new Error('Invalid PDF parser resource')
        return new Uint8Array(await readFile(join(packageRoot, directory, filename)))
      }
    }
    task = getDocument({
      data: bytes,
      BinaryDataFactory: PackagedPdfAssets,
      isEvalSupported: false,
      enableXfa: false,
      useWasm: false,
      disableAutoFetch: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableFontFace: true,
      stopAtErrors: true,
      verbosity: 0,
      cMapUrl: join(packageRoot, 'cmaps') + sep,
      cMapPacked: true,
      standardFontDataUrl: join(packageRoot, 'standard_fonts') + sep,
      wasmUrl: join(packageRoot, 'wasm') + sep,
    })
    const document = await task.promise
    if (document.numPages > limits.maxPages)
      return {
        status: 'unavailable',
        code: 'PDF_PAGE_LIMIT',
        pages: document.numPages,
        message: `PDF 超过 ${limits.maxPages} 页提取上限，请拆分后重试；尚未读取正文。`,
      }
    const pages = []
    const pagesWithoutText = []
    let characters = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const textContent = await page.getTextContent()
      let text = ''
      for (const item of textContent.items) {
        if (typeof item.str !== 'string') continue
        const fragment = item.str + (item.hasEOL ? '\n' : ' ')
        characters += fragment.length
        if (characters > limits.maxTextCharacters)
          return {
            status: 'unavailable',
            code: 'PDF_TEXT_LIMIT',
            pages: document.numPages,
            message: 'PDF 文本超过提取上限，请拆分后重试；没有截取部分内容冒充全文。',
          }
        text += fragment
      }
      page.cleanup()
      text = text.trim()
      if (!text) pagesWithoutText.push(pageNumber)
      else pages.push(`[第 ${pageNumber} 页]\n${text}`)
    }
    if (!pages.length)
      return {
        status: 'unavailable',
        code: 'PDF_NO_TEXT_LAYER',
        pages: document.numPages,
        message: 'PDF 没有可提取的文字层，可能是扫描件或空白页；当前未启用 OCR，尚未读取正文。',
      }
    const content = pages.join('\n\n')
    if (content.length > limits.maxTextCharacters)
      return {
        status: 'unavailable',
        code: 'PDF_TEXT_LIMIT',
        pages: document.numPages,
        message: 'PDF 文本超过提取上限，请拆分后重试；没有截取部分内容冒充全文。',
      }
    return {
      status: pagesWithoutText.length ? 'partial' : 'ready',
      format: 'pdf-text',
      pages: document.numPages,
      textCharacters: content.length,
      ...(pagesWithoutText.length
        ? {
            code: 'PDF_PAGES_WITHOUT_TEXT',
            pagesWithoutText,
            message: `第 ${pagesWithoutText.join('、')} 页没有可提取文字，可能为扫描页或空白页；这些页面未读取，不得当作已读全文。`,
          }
        : {}),
      content,
    }
  } catch (error) {
    if (error.name === 'PasswordException')
      return {
        status: 'unavailable',
        code: 'PDF_PASSWORD_REQUIRED',
        message: 'PDF 受密码保护，请先解密再上传；尚未读取正文。',
      }
    if (error.name === 'InvalidPDFException' || error.name === 'FormatError')
      return {
        status: 'unavailable',
        code: 'PDF_INVALID',
        message: 'PDF 已损坏或格式无效，无法提取正文。',
      }
    return {
      status: 'unavailable',
      code: 'PDF_PARSER_ERROR',
      message: 'PDF 文本提取失败，尚未读取正文；请检查文档后重试。',
    }
  } finally {
    await task?.destroy().catch(() => {})
  }
}

parentPort.postMessage(await extract())
