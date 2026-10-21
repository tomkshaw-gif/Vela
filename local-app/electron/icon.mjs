import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The library's attributed Vela mark, with a padded dark application background.
const polygons = [[[0, 0], [32.91, 0], [77.52, 77.27], [61.06, 105.76]],
    [[161.66, 0], [128.75, 0], [84.14, 77.27], [100.59, 105.76]],
    [[80.83, 87.96], [95.85, 113.98], [80.83, 140], [65.81, 113.98]]];
function inside(x, y, points) {
    let found = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i]; const [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) found = !found;
    }
    return found;
}
function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, value) {
    const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(value.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, value])));
    return Buffer.concat([length, name, value, crc]);
}
export async function buildIcon(directory) {
    const size = 256; const scan = Buffer.alloc((1 + size * 4) * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let covered = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
            const px = (x + (sx + 0.5) / 4 - 42) / 1.06; const py = (y + (sy + 0.5) / 4 - 53) / 1.06;
            if (polygons.some(polygon => inside(px, py, polygon))) covered++;
        }
        const offset = y * (1 + size * 4) + 1 + x * 4;
        const color = Math.round(18 + (242 - 18) * covered / 16);
        scan.set([color, color, color, 255], offset);
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
    const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'icon.ico'), Buffer.concat([ico, png]));
}
