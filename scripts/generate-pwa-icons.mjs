/* global Buffer */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'apps', 'web', 'public', 'icons')

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const payload = Buffer.concat([typeBuffer, data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(payload))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, payload, checksum])
}

function iconPng(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size)
  const scale = size / 192
  const inside = (x, y, left, top, right, bottom) => x >= left * scale && x < right * scale && y >= top * scale && y < bottom * scale
  const center = 132 * scale
  const radius = 12 * scale

  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1)
    pixels[row] = 0
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4
      let color = [23, 54, 95, 255]
      if (inside(x, y, 48, 52, 144, 76) || inside(x, y, 48, 84, 112, 108) || inside(x, y, 48, 116, 144, 140)) color = [247, 249, 252, 255]
      else if ((x - center) ** 2 + (y - 96 * scale) ** 2 <= radius ** 2) color = [230, 162, 60, 255]
      pixels.set(color, offset)
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

await mkdir(outputDir, { recursive: true })
await Promise.all([
  writeFile(path.join(outputDir, 'icon-180.png'), iconPng(180)),
  writeFile(path.join(outputDir, 'icon-192.png'), iconPng(192)),
  writeFile(path.join(outputDir, 'icon-512.png'), iconPng(512)),
])
