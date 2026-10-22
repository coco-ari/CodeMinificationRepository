// 原型导出使用真实文件格式，PDF 使用标准 CJK 字体而非伪装扩展名。
export function createReportPDF(title, lines) {
  const hex = (text) =>
    String(text)
      .split('')
      .map((char) => char.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('')
      .toUpperCase()
  const rows = [title, ...lines.flatMap((line) => line.match(/.{1,38}/gu) || [''])]
  const stream = [
    'BT',
    '/F1 12 Tf',
    '48 790 Td',
    '20 TL',
    ...rows.slice(0, 35).flatMap((line, index) => [index ? 'T*' : '', `<${hex(line)}> Tj`]),
    'ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return `data:application/pdf;base64,${btoa(pdf)}`
}

export function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

export function downloadChatFile(file) {
  let url = file.dataUrl
  let release = false
  if (!url) {
    url = URL.createObjectURL(
      new Blob([file.content || ''], { type: file.mime || 'text/plain;charset=utf-8' }),
    )
    release = true
  }
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  if (release) setTimeout(() => URL.revokeObjectURL(url), 1000)
}
