// 本地生成 QR Code Model 2（字节模式、L 级纠错）；不向外部服务发送机柜地址。
const BLOCKS = [
  null,
  [[1, 26, 19]],
  [[1, 44, 34]],
  [[1, 70, 55]],
  [[1, 100, 80]],
  [[1, 134, 108]],
  [[2, 86, 68]],
  [[2, 98, 78]],
  [[2, 121, 97]],
  [[2, 146, 116]],
  [
    [2, 86, 68],
    [2, 87, 69],
  ],
]
const ALIGN = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

function multiply(x, y) {
  let product = 0
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((y >>> bit) & 1) * x
  }
  return product
}

function reedSolomon(data, degree) {
  const divisor = Array(degree).fill(0)
  divisor[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < divisor.length; j++) {
      divisor[j] = multiply(divisor[j], root)
      if (j + 1 < divisor.length) divisor[j] ^= divisor[j + 1]
    }
    root = multiply(root, 2)
  }
  const remainder = Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder.shift()
    remainder.push(0)
    for (let i = 0; i < remainder.length; i++) remainder[i] ^= multiply(divisor[i], factor)
  }
  return remainder
}

export function qrMatrix(value) {
  const bytes = new TextEncoder().encode(value)
  let version = 1
  while (version <= 10) {
    const capacity = BLOCKS[version].reduce((sum, [count, , data]) => sum + count * data, 0)
    if (bytes.length * 8 + 4 + (version < 10 ? 8 : 16) <= capacity * 8) break
    version++
  }
  if (version > 10) throw new Error('二维码链接过长，请缩短目标地址（最多 271 个 UTF-8 字节）')
  const blocks = BLOCKS[version].flatMap(([count, total, data]) =>
    Array.from({ length: count }, () => ({ total, data })),
  )
  const dataCapacity = blocks.reduce((sum, block) => sum + block.data, 0)
  const bits = []
  const append = (number, count) => {
    for (let bit = count - 1; bit >= 0; bit--) bits.push((number >>> bit) & 1)
  }
  append(4, 4)
  append(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) append(byte, 8)
  append(0, Math.min(4, dataCapacity * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0))
  while (data.length < dataCapacity)
    data.push(data.length % 2 === Math.ceil(bits.length / 8) % 2 ? 0xec : 0x11)
  let offset = 0
  const codeBlocks = blocks.map((block) => {
    const content = data.slice(offset, offset + block.data)
    offset += block.data
    return { content, correction: reedSolomon(content, block.total - block.data) }
  })
  const codewords = []
  for (let i = 0; i < Math.max(...blocks.map((block) => block.data)); i++) {
    for (const block of codeBlocks) if (i < block.content.length) codewords.push(block.content[i])
  }
  for (let i = 0; i < codeBlocks[0].correction.length; i++)
    for (const block of codeBlocks) codewords.push(block.correction[i])
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => Array(size).fill(false))
  const set = (x, y, dark) => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      modules[y][x] = Boolean(dark)
      fixed[y][x] = true
    }
  }
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, distance !== 2 && distance !== 4)
      }
  }
  const positions = ALIGN[version]
  for (let i = 0; i < positions.length; i++)
    for (let j = 0; j < positions.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0)
      )
        continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  // L 级纠错 + mask 0，格式字的 BCH 码经 0x5412 异或。
  const format = 0x77c4
  const bit = (number, index) => (number >>> index) & 1
  for (let i = 0; i <= 5; i++) set(8, i, bit(format, i))
  set(8, 7, bit(format, 6))
  set(8, 8, bit(format, 7))
  set(7, 8, bit(format, 8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i))
  set(8, size - 8, true)
  if (version >= 7) {
    let remainder = version
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const versionBits = (version << 12) | remainder
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, bit(versionBits, i))
      set(b, a, bit(versionBits, i))
    }
  }
  let dataBit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      const upward = ((right + 1) & 2) === 0
      const y = upward ? size - 1 - vertical : vertical
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (!fixed[y][x]) {
          const dark =
            dataBit < codewords.length * 8 ? bit(codewords[dataBit >>> 3], 7 - (dataBit & 7)) : 0
          modules[y][x] = Boolean(dark ^ ((x + y) % 2 === 0))
          dataBit++
        }
      }
    }
  }
  return modules
}

export function cabinetQrPng(url, imei, targetName) {
  const matrix = qrMatrix(url)
  const scale = 7
  const quiet = 4
  const width = (matrix.length + quiet * 2) * scale
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(width, 420)
  canvas.height = width + 84
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const left = Math.floor((canvas.width - width) / 2)
  context.fillStyle = '#111111'
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) context.fillRect(left + (x + quiet) * scale, (y + quiet) * scale, scale, scale)
    }),
  )
  context.textAlign = 'center'
  context.font = '18px sans-serif'
  context.fillText(imei, canvas.width / 2, width + 22, canvas.width - 24)
  context.font = '16px sans-serif'
  context.fillText(targetName, canvas.width / 2, width + 52, canvas.width - 24)
  return canvas.toDataURL('image/png')
}
