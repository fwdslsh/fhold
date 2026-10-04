// Code-native f/hold mark: one geometry drives SVG source and the PNG packaging asset.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const size = 512;
const rectangles = [[124, 128, 128, 36], [124, 128, 36, 256], [124, 228, 112, 36]];
const slash = [[334, 128], [376, 128], [284, 384], [242, 384]];
const foreground = [192, 222, 216];
const background = [29, 39, 49];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>f/hold</title><rect width="512" height="512" rx="96" fill="#1d2731"/><g fill="#c0ded8">${rectangles.map(([x,y,width,height]) => `<rect x="${x}" y="${y}" width="${width}" height="${height}"/>`).join('')}<polygon points="${slash.map(([x,y]) => `${x},${y}`).join(' ')}"/></g></svg>\n`;

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
	const name = Buffer.from(type);
	const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
	return Buffer.concat([length, name, bytes, crc]);
}
function insidePolygon(x, y) {
	let inside = false;
	for (let i = 0, j = slash.length - 1; i < slash.length; j = i++) {
		const [xi, yi] = slash[i], [xj, yj] = slash[j];
		if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
const raster = Buffer.alloc(size * (1 + size * 4));
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
	let coverage = 0;
	for (const dx of [0.25, 0.75]) for (const dy of [0.25, 0.75]) {
		const px = x + dx, py = y + dy;
		if (rectangles.some(([rx,ry,w,h]) => px >= rx && px < rx+w && py >= ry && py < ry+h) || insidePolygon(px, py)) coverage += 0.25;
	}
	const offset = y * (1 + size * 4) + 1 + x * 4;
	for (let channel = 0; channel < 3; channel++) raster[offset+channel] = Math.round(background[channel] * (1-coverage) + foreground[channel] * coverage);
	const cx = x < 96 ? 96 : x > size-96 ? size-96 : x;
	const cy = y < 96 ? 96 : y > size-96 ? size-96 : y;
	raster[offset+3] = Math.hypot(x-cx,y-cy) <= 96 ? 255 : 0;
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(raster)), chunk('IEND',Buffer.alloc(0))]);
writeFileSync(join(import.meta.dirname, '../assets/icon.svg'), svg);
writeFileSync(join(import.meta.dirname, '../assets/icon.png'), png);
