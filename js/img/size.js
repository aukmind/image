import { jpegHeaderSize } from './meta.js';

// Image size from the first bytes of a JPEG, PNG or WebP, as displayed: { width, height, rotated } where
// `rotated` means a JPEG Exif orientation applies. Null when the header doesn't say (or `head` stops short).

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32le = (b, o) => (u16le(b, o) | (u16le(b, o + 2) << 16)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const text = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function webpSize(b) {
    const chunk = text(b, 12, 4);
    if (chunk === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, rotated: false };
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, rotated: false };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
        const bits = u32le(b, 21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, rotated: false };
    }
    return null;
}

export function headerSize(b) {
    if (b.length < 30) return null;
    if (b[0] === 0xff && b[1] === 0xd8) return jpegHeaderSize(b);
    if (b[0] === 0x89 && text(b, 1, 3) === 'PNG' && text(b, 12, 4) === 'IHDR') return { width: u32be(b, 16), height: u32be(b, 20), rotated: false };
    if (text(b, 0, 4) === 'RIFF' && text(b, 8, 4) === 'WEBP') return webpSize(b);
    return null;
}

// 32×16 JPEG, red left half and blue right half, Exif orientation 6: shown 16×32 with red on top.
export const ORIENTATION_PROBE = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAACQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCDgJERhFwC6i6f/9k=';
