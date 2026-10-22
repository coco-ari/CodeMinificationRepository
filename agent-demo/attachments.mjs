import { Worker } from 'node:worker_threads'

// File authorization and storage belong to the caller. This module only receives
// authorized bytes and produces a reusable, runtime-independent text sidecar.
// Hermes keeps session-scoped file references (api/upload.py); OpenChamber checks
// attachment input capabilities (packages/ui/src/sync/attachment-files.ts).
export const ATTACHMENT_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxPages: 100,
  maxTextCharacters: 500_000,
  timeoutMs: 10_000,
})

const textMimes = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/toml',
  'application/x-toml',
  'application/yaml',
  'application/x-yaml',
  'image/svg+xml',
])
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function unavailable(file, code, message, details = {}) {
  return {
    ...file,
    readable: false,
    extraction: { status: 'unavailable', code, message, ...details },
  }
}

function limitsFor(options) {
  const limits = { ...ATTACHMENT_LIMITS }
  for (const key of Object.keys(limits)) {
    if (options[key] === undefined) continue
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > limits[key])
      throw new RangeError(`${key} must be a positive integer within the default limit`)
    limits[key] = options[key]
  }
  return limits
}

async function extractPdf(bytes, limits) {
  return new Promise((resolve) => {
    // PDF.js uses its in-process worker in Node. Isolate the entire parser in a
    // Node worker so a malformed document cannot block the HTTP event loop or
    // evade a Promise-only timeout. Only bytes and limits cross this boundary.
    const worker = new Worker(new URL('./attachment-pdf-worker.mjs', import.meta.url), {
      workerData: { bytes: new Uint8Array(bytes), limits },
      // The parser does not need CLI loaders, test hooks, or HTTP process flags.
      // Several of those flags are invalid in a Worker (including --input-type).
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Do not mark a timed-out extraction settled until its worker has exited.
      void worker.terminate().then(() => resolve(result))
    }
    const timer = setTimeout(
      () =>
        finish({
          status: 'unavailable',
          code: 'PDF_TIMEOUT',
          message: 'PDF 文本提取超时，请拆分文档后重试；尚未读取正文。',
        }),
      limits.timeoutMs,
    )
    worker.once('message', finish)
    worker.once('error', (error) =>
      finish({
        status: 'unavailable',
        code: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'PDF_RESOURCE_LIMIT' : 'PDF_PARSER_ERROR',
        message: 'PDF 文本提取失败，请检查文档或拆分后重试；尚未读取正文。',
      }),
    )
    worker.once('exit', () =>
      finish({
        status: 'unavailable',
        code: 'PDF_PARSER_ERROR',
        message: 'PDF 文本提取未完成；尚未读取正文。',
      }),
    )
  })
}

/**
 * Convert an already-authorized attachment into the run adapter's input.
 * Does not fetch URLs, open caller-supplied paths, or decide access permissions.
 * Failure returns explicit capability metadata and never a fabricated body.
 */
export async function extractAttachment({ id, name, mime, bytes }, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Attachment bytes must be a Uint8Array')
  const limits = limitsFor(options)
  const normalizedMime = String(mime || 'application/octet-stream')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  const file = { id, name, mime: normalizedMime, size: bytes.byteLength }
  if (bytes.byteLength > limits.maxBytes)
    return unavailable(file, 'ATTACHMENT_SIZE_LIMIT', '附件超过文本提取大小上限。')

  if (normalizedMime === 'application/pdf' || /\.pdf$/i.test(String(name))) {
    const result = await extractPdf(bytes, limits)
    const { content, ...extraction } = result
    if (typeof content !== 'string') return { ...file, readable: false, extraction }
    return { ...file, readable: true, content, extraction }
  }

  if (normalizedMime.startsWith('text/') || textMimes.has(normalizedMime)) {
    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return unavailable(
        file,
        'UNSUPPORTED_TEXT_ENCODING',
        '附件不是有效的 UTF-8 文本，请转换编码后上传。',
      )
    }
    if (content.includes('\u0000'))
      return unavailable(file, 'INVALID_TEXT_CONTENT', '附件包含二进制内容，无法作为文本读取。')
    if (content.length > limits.maxTextCharacters)
      return unavailable(
        file,
        'TEXT_CHARACTER_LIMIT',
        '附件文本过长，请拆分后上传；没有截取部分内容冒充全文。',
      )
    return {
      ...file,
      readable: true,
      content,
      extraction: { status: 'ready', format: 'text', textCharacters: content.length },
    }
  }

  if (imageMimes.has(normalizedMime))
    return {
      ...file,
      readable: true,
      data: Buffer.from(bytes).toString('base64'),
      extraction: {
        status: 'ready',
        format: 'image',
        message: '由运行器作为视觉输入读取，未提取文本。',
      },
    }

  return unavailable(
    file,
    'UNSUPPORTED_ATTACHMENT',
    '此文件格式尚不支持正文读取，可下载原文件；不得声称已读取正文。',
  )
}
