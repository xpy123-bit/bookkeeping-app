/**
 * 生成 PWA 图标（PNG）。
 *
 * 用 Node 自带的 zlib 手写最小 PNG 编码器，避免为几张图标引入图像库依赖。
 * 图形为「圆角方块 + ¥ 符号」，与应用的深色主题一致。
 *
 * 用法：node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** CRC32 查表，PNG 每个 chunk 都需要。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32。
 *
 * @param {Buffer} buffer 输入字节。
 * @returns {number} CRC32 值。
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 组装一个 PNG chunk。
 *
 * @param {string} type 四字符类型，如 'IHDR'。
 * @param {Buffer} data 负载。
 * @returns {Buffer} 完整 chunk。
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * 把逐像素函数编码成 PNG。
 *
 * @param {number} size 边长（正方形）。
 * @param {(x: number, y: number) => [number, number, number, number]} shade 返回 RGBA。
 * @returns {Buffer} PNG 字节。
 */
function encodePng(size, shade) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // 过滤器类型 0（None）
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = shade(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 点到线段的距离，用于按距离绘制有粗细的线条。
 *
 * @returns {number} 距离。
 */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * 生成一个图标。
 *
 * @param {number} size 边长。
 * @returns {Buffer} PNG 字节。
 */
function makeIcon(size) {
  const s = size;
  const radius = s * 0.22;
  const stroke = Math.max(1.5, s * 0.052);

  // ¥ 符号的几何：两条斜线汇聚到中心，再竖直向下，另加两条横杠。
  const apex = { x: s * 0.5, y: s * 0.52 };
  const leftTop = { x: s * 0.3, y: s * 0.26 };
  const rightTop = { x: s * 0.7, y: s * 0.26 };
  const stemBottom = { x: s * 0.5, y: s * 0.78 };
  const barLeft = s * 0.33;
  const barRight = s * 0.67;
  const barY1 = s * 0.58;
  const barY2 = s * 0.69;

  return encodePng(s, (x, y) => {
    // 圆角矩形遮罩
    const cx = Math.min(Math.max(x, radius), s - radius);
    const cy = Math.min(Math.max(y, radius), s - radius);
    const inside =
      x >= 0 && y >= 0 && x < s && y < s && Math.hypot(x - cx, y - cy) <= radius;

    if (!inside) return [0, 0, 0, 0];

    // 背景渐变：从天空蓝到靛蓝
    const t = (x + y) / (2 * s);
    const bgR = Math.round(14 + t * 20);
    const bgG = Math.round(130 - t * 40);
    const bgB = Math.round(220 + t * 25);

    // 字形描边判定
    const distances = [
      distanceToSegment(x, y, leftTop.x, leftTop.y, apex.x, apex.y),
      distanceToSegment(x, y, rightTop.x, rightTop.y, apex.x, apex.y),
      distanceToSegment(x, y, apex.x, apex.y, stemBottom.x, stemBottom.y),
      distanceToSegment(x, y, barLeft, barY1, barRight, barY1),
      distanceToSegment(x, y, barLeft, barY2, barRight, barY2),
    ];
    const minimum = Math.min(...distances);

    // 抗锯齿：按到描边边界的距离做线性过渡
    const coverage = Math.max(0, Math.min(1, stroke * 0.5 - minimum + 0.5));

    const r = Math.round(bgR + (255 - bgR) * coverage);
    const g = Math.round(bgG + (255 - bgG) * coverage);
    const b = Math.round(bgB + (255 - bgB) * coverage);

    return [r, g, b, 255];
  });
}

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [192, 512]) {
  const buffer = makeIcon(size);
  const path = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, buffer);
  console.log(`wrote ${path} (${buffer.length} bytes)`);
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0ea5e9"/>
  <g stroke="#ffffff" stroke-width="3.4" stroke-linecap="round" fill="none">
    <path d="M19 17 L32 33 L45 17"/>
    <path d="M32 33 L32 49"/>
    <path d="M21 37 L43 37"/>
    <path d="M21 44 L43 44"/>
  </g>
</svg>
`;
writeFileSync(join(OUT_DIR, 'favicon.svg'), favicon);
console.log(`wrote ${join(OUT_DIR, 'favicon.svg')}`);
