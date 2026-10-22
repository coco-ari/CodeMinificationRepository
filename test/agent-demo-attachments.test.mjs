import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ATTACHMENT_LIMITS, extractAttachment } from '../agent-demo/attachments.mjs'

// Synthetic fixtures contain no user data. text.pdf is the exact PDF from the
// October 21 real-model failure probe. scan/mixed were generated with ReportLab
// and an embedded image; password.pdf was encrypted with pypdf. Runtime tests
// require only Node and the production PDF.js dependency, not these generators.
async function pdf(name, options) {
  return extractAttachment(
    {
      id: `fixture-${name}`,
      name,
      mime: 'application/pdf',
      bytes: await readFile(new URL(`./fixtures/agent-demo-pdf/${name}`, import.meta.url)),
    },
    options,
  )
}

test('the real failure-probe PDF now produces reusable text with page provenance', async () => {
  const result = await pdf('text.pdf')
  assert.equal(result.readable, true)
  assert.equal(result.extraction.status, 'ready')
  assert.equal(result.extraction.format, 'pdf-text')
  assert.equal(result.extraction.pages, 1)
  assert.match(result.content, /\[第 1 页\]/)
  assert.match(result.content, /AutoOps live attachment probe/)
  assert.match(result.content, /Verification code: PDF-[a-f0-9]{16}/)
  assert.equal(result.extraction.textCharacters, result.content.length)
  assert.equal(result.data, undefined)
})

test('scanned PDF explicitly reports missing OCR instead of pretending its body was read', async () => {
  const result = await pdf('scan.pdf')
  assert.equal(result.readable, false)
  assert.equal(result.extraction.code, 'PDF_NO_TEXT_LAYER')
  assert.match(result.extraction.message, /OCR/)
  assert.equal(result.content, undefined)
})

test('mixed PDF identifies unread pages alongside the text that was actually extracted', async () => {
  const result = await pdf('mixed.pdf')
  assert.equal(result.readable, true)
  assert.equal(result.extraction.status, 'partial')
  assert.equal(result.extraction.code, 'PDF_PAGES_WITHOUT_TEXT')
  assert.deepEqual(result.extraction.pagesWithoutText, [2])
  assert.match(result.content, /First page has readable text/)
  assert.doesNotMatch(result.content, /SCANNED FIXTURE/)
})

test('Chinese PDF text uses the packaged CMaps without requiring system fonts', async () => {
  const result = await pdf('chinese.pdf')
  assert.equal(result.readable, true)
  assert.match(result.content, /跨轮附件：中文资料验证，第二行可继续读取。/)
})

test('PDF URI actions and embedded JavaScript are not executed during extraction', async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.end('External content must never become document text')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const bytes = await readFile(
      new URL('./fixtures/agent-demo-pdf/external-actions.pdf', import.meta.url),
    )
    // Preserve the byte lengths and xref offsets while pointing both actions at
    // this test's observable HTTP endpoint.
    const placeholder = '\\07200000\\057'
    assert.equal(bytes.toString('latin1').split(placeholder).length - 1, 2)
    const fixture = Buffer.from(
      bytes
        .toString('latin1')
        .replaceAll(placeholder, `\\072${String(server.address().port).padStart(5, '0')}\\057`),
      'latin1',
    )
    assert.equal(fixture.length, bytes.length)
    await fetch(`http://127.0.0.1:${server.address().port}/probe`)
    assert.equal(requests, 1, 'the request observer must see a control request')
    requests = 0
    const result = await extractAttachment({
      id: 'actions',
      name: 'actions.pdf',
      mime: 'application/pdf',
      bytes: fixture,
    })
    assert.equal(result.readable, true)
    assert.match(result.content, /AutoOps live attachment probe/)
    assert.doesNotMatch(result.content, /External content/)
    assert.equal(requests, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('password-protected PDF reports decryption requirement', async () => {
  const result = await pdf('password.pdf')
  assert.equal(result.readable, false)
  assert.equal(result.extraction.code, 'PDF_PASSWORD_REQUIRED')
  assert.equal(result.content, undefined)
})

test('damaged PDF rejects extraction without returning any body', async () => {
  const result = await extractAttachment({
    id: 'damaged',
    name: 'damaged.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('%PDF-1.7\ninvalid document, no objects\n%%EOF'),
  })
  assert.equal(result.readable, false)
  assert.equal(result.extraction.code, 'PDF_INVALID')
  assert.equal(result.content, undefined)
})

test('PDF page and text limits do not silently return an incomplete document', async () => {
  const pages = await pdf('mixed.pdf', { maxPages: 1 })
  assert.equal(pages.readable, false)
  assert.equal(pages.extraction.code, 'PDF_PAGE_LIMIT')
  assert.equal(pages.extraction.pages, 2)
  assert.equal(pages.content, undefined)
  const text = await pdf('text.pdf', { maxTextCharacters: 10 })
  assert.equal(text.readable, false)
  assert.equal(text.extraction.code, 'PDF_TEXT_LIMIT')
  assert.equal(text.content, undefined)
})

test('parser timeout terminates its worker and returns a clear failure', async () => {
  const started = performance.now()
  const portsBefore = process
    .getActiveResourcesInfo()
    .filter((type) => type === 'MessagePort').length
  const result = await pdf('text.pdf', { timeoutMs: 1 })
  assert.equal(result.readable, false)
  assert.equal(result.extraction.code, 'PDF_TIMEOUT')
  assert.ok(
    performance.now() - started < 2_000,
    'worker timeout must not wait for parser completion',
  )
  assert.ok(
    process.getActiveResourcesInfo().filter((type) => type === 'MessagePort').length <= portsBefore,
    'timed-out worker message ports must be closed before returning',
  )
})

test('extraction leaves caller-owned bytes intact and is independent of file IDs', async () => {
  const bytes = await readFile(new URL('./fixtures/agent-demo-pdf/text.pdf', import.meta.url))
  const original = Buffer.from(bytes)
  const result = await extractAttachment({
    id: 'allowed-by-caller',
    name: 'text.pdf',
    mime: 'application/pdf',
    bytes,
  })
  assert.equal(result.readable, true)
  assert.deepEqual(bytes, original)
  assert.equal(result.id, 'allowed-by-caller')
})

test('UTF-8 attachments preserve all text for subsequent turns', async () => {
  const text = '第一行：随机标记\n第二行：后续追问才允许回答\n'
  const result = await extractAttachment({
    id: 'txt',
    name: 'notes.txt',
    mime: 'text/plain; charset=utf-8',
    bytes: Buffer.from(text),
  })
  assert.equal(result.readable, true)
  assert.equal(result.content, text)
  assert.equal(result.mime, 'text/plain')
  assert.equal(result.extraction.format, 'text')
})

test('invalid encoding, binary disguised as text and oversize data have explicit capability failures', async () => {
  for (const [bytes, code] of [
    [Buffer.from([0xc3, 0x28]), 'UNSUPPORTED_TEXT_ENCODING'],
    [Buffer.from('text\0binary'), 'INVALID_TEXT_CONTENT'],
    [Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1), 'ATTACHMENT_SIZE_LIMIT'],
  ]) {
    const result = await extractAttachment({
      id: 'invalid',
      name: 'file.txt',
      mime: 'text/plain',
      bytes,
    })
    assert.equal(result.readable, false)
    assert.equal(result.extraction.code, code)
    assert.equal(result.content, undefined)
  }
})

test('images retain the existing native-vision payload and unknown binaries stay unavailable', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const image = await extractAttachment({
    id: 'image',
    name: 'pixel.png',
    mime: 'image/png',
    bytes,
  })
  assert.equal(image.readable, true)
  assert.equal(image.data, bytes.toString('base64'))
  assert.equal(image.extraction.format, 'image')
  assert.equal(image.content, undefined)
  const unknown = await extractAttachment({
    id: 'unknown',
    name: 'file.bin',
    mime: 'application/octet-stream',
    bytes,
  })
  assert.equal(unknown.readable, false)
  assert.equal(unknown.extraction.code, 'UNSUPPORTED_ATTACHMENT')
  assert.equal(unknown.content, undefined)
})
