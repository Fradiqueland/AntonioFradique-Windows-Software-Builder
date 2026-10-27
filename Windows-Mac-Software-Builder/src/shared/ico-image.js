'use strict';

// Electron opens ICO paths on Windows only. Decode the standard uncompressed
// DIB frames on other hosts; PNG frames still use Electron's image decoder.
function frames(bytes) {
  if (bytes.length < 6 || bytes.length > 16 * 1024 ** 2 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error('Ícone ICO inválido.');
  const count = bytes.readUInt16LE(4), tableEnd = 6 + 16 * count;
  if (!count || count > 1024 || tableEnd > bytes.length) throw new Error('Ícone ICO inválido.');
  const result = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i, size = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
    if (!size || offset < tableEnd || offset + size > bytes.length) throw new Error('Ícone ICO incompleto.');
    result.push({ width: bytes[entry] || 256, height: bytes[entry + 1] || 256, bytes: bytes.subarray(offset, offset + size) });
  }
  return result.sort((a, b) => b.width * b.height - a.width * a.height);
}

function bitmap(frame) {
  const b = frame.bytes;
  if (b.length < 40 || b.readUInt32LE(0) !== 40 || b.readUInt16LE(12) !== 1 || b.readUInt32LE(16) !== 0) throw new Error('Imagem ICO não suportada.');
  const width = b.readInt32LE(4), storedHeight = b.readInt32LE(8), height = Math.abs(storedHeight) / 2, depth = b.readUInt16LE(14);
  if (width !== frame.width || height !== frame.height || ![1, 4, 8, 16, 24, 32].includes(depth)) throw new Error('Dimensões ICO inválidas.');
  const colors = depth <= 8 ? b.readUInt32LE(32) || 2 ** depth : 0;
  if (colors > 256) throw new Error('Paleta ICO inválida.');
  const pixels = 40 + colors * 4, stride = Math.ceil(width * depth / 32) * 4;
  const mask = pixels + stride * height, maskStride = Math.ceil(width / 32) * 4;
  if (mask > b.length || (depth !== 32 && mask + maskStride * height > b.length)) throw new Error('Imagem ICO incompleta.');
  const data = Buffer.alloc(width * height * 4);
  let hasAlpha = false;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = pixels + (storedHeight > 0 ? height - 1 - y : y) * stride, to = (y * width + x) * 4;
    if (depth <= 8) {
      const bit = x * depth, index = (b[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      if (index >= colors) throw new Error('Paleta ICO incompleta.');
      b.copy(data, to, 40 + index * 4, 43 + index * 4);
    } else if (depth === 16) {
      const rgb = b.readUInt16LE(row + 2 * x);
      data[to] = Math.round((rgb & 31) * 255 / 31); data[to + 1] = Math.round(((rgb >> 5) & 31) * 255 / 31); data[to + 2] = Math.round(((rgb >> 10) & 31) * 255 / 31);
    } else b.copy(data, to, row + x * depth / 8, row + x * depth / 8 + 3);
    data[to + 3] = depth === 32 ? b[row + x * 4 + 3] : 255;
    if (data[to + 3]) hasAlpha = true;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = (y * width + x) * 4 + 3;
    if (depth === 32 && !hasAlpha) data[alpha] = 255;
    if (mask + maskStride * height <= b.length && (b[mask + (storedHeight > 0 ? height - 1 - y : y) * maskStride + (x >> 3)] & (0x80 >> (x & 7)))) data[alpha] = 0;
    // NativeImage's bitmap input uses premultiplied BGRA channels.
    for (let channel = 1; channel <= 3; channel++) data[alpha - channel] = Math.round(data[alpha - channel] * data[alpha] / 255);
  }
  return { data, width, height };
}

module.exports = { frames, bitmap };
