/**
 * Generates the site icons from the same colours the stylesheet uses.
 *
 * Everything here is written by hand -- PNG chunks, CRC, the ICO container, and the glyph --
 * because the alternative is committing a binary that nobody can regenerate or tweak, and a
 * brand colour changing then means hunting for an image editor. The brand lives in this file
 * as numbers, so the icon can be redrawn by changing two constants.
 *
 * The mark matches the header: a rounded square in the lime gradient carrying an indigo "R",
 * which is the same `brand-mark` treatment used in the page header.
 *
 * Usage: node scripts/generate-icons.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// The brand ramp, matching `--lime-400` / `--lime-500` and `--indigo-900` in style.css.
const LIME_LIGHT = [212, 251, 82];
const LIME_DARK = [196, 238, 57];
const INK = [19, 28, 74];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    // The type is part of the checksum, so it is hashed alongside the data.
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([length, typed, crc]);
}

/** Encodes RGBA pixel data as a PNG. */
function encodePng(width, height, rgba) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;   // bit depth
    header[9] = 6;   // colour type: truecolour with alpha
    header[10] = 0;  // deflate
    header[11] = 0;  // adaptive filtering
    header[12] = 0;  // no interlace

    // Each scanline is prefixed with its filter byte. Filter 0 (none) throughout: the image
    // is tiny and the size difference is irrelevant next to the code a real filter needs.
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Signed distance from a point to a rounded rectangle, used to anti-alias the edges. */
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
    const dx = Math.max(left + radius - x, 0, x - (right - radius));
    const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
    return Math.hypot(dx, dy) - radius;
}

/**
 * Whether a point is inside the "R".
 *
 * Built from three primitives rather than a font: a stem, a bowl, and a leg. Drawing a
 * glyph procedurally keeps the icon at any size with no font file to embed and no rendering
 * difference between machines.
 */
function insideGlyph(x, y, size) {
    const u = (value) => (value / size) * 100;
    const px = u(x);
    const py = u(y);

    // Stem: the left vertical bar of the R.
    const inStem = px >= 24 && px <= 38 && py >= 22 && py <= 78;

    // Bowl: a rounded rectangle with a rounded hole cut from it, covering the upper half.
    const bowlOuter = roundedRectDistance(px, py, 36, 22, 66, 52, 15) <= 0;
    const bowlInner = roundedRectDistance(px, py, 46, 32, 56, 44, 5) > 0;
    const inBowl = bowlOuter && bowlInner;

    // Leg: a diagonal from the middle of the bowl down to the bottom right. Measured against
    // the distance to a line so the stroke keeps a constant width instead of thinning at the
    // end the way a triangle would.
    const legTopX = 46;
    const legTopY = 48;
    const legBottomX = 68;
    const legBottomY = 78;
    const ax = legBottomX - legTopX;
    const ay = legBottomY - legTopY;
    const lengthSquared = ax * ax + ay * ay;
    const t = Math.max(0, Math.min(1, ((px - legTopX) * ax + (py - legTopY) * ay) / lengthSquared));
    const distance = Math.hypot(px - (legTopX + t * ax), py - (legTopY + t * ay));
    const inLeg = distance <= 7;

    return inStem || inBowl || inLeg;
}

function mix(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t)
    ];
}

/**
 * Renders the icon at one size.
 *
 * Supersampled 4x4 per pixel: a 16px favicon is four pixels across per glyph stroke region,
 * and without it the mark turns to mush at exactly the sizes browsers ask for in tabs.
 */
function renderIcon(size) {
    const rgba = Buffer.alloc(size * size * 4);
    const samples = 4;
    const radius = size * 0.22;
    const inset = size * 0.045;

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            let backgroundHits = 0;
            let glyphHits = 0;

            for (let sy = 0; sy < samples; sy += 1) {
                for (let sx = 0; sx < samples; sx += 1) {
                    const px = x + (sx + 0.5) / samples;
                    const py = y + (sy + 0.5) / samples;
                    const inside = roundedRectDistance(
                        px, py, inset, inset, size - inset, size - inset, radius
                    ) <= 0;
                    if (!inside) continue;
                    backgroundHits += 1;
                    if (insideGlyph(px, py, size)) glyphHits += 1;
                }
            }

            const total = samples * samples;
            const offset = (y * size + x) * 4;

            if (backgroundHits === 0) continue;

            // Vertical gradient across the tile, matching the header's diagonal lime.
            const t = y / (size - 1);
            const base = mix(LIME_LIGHT, LIME_DARK, t * 0.85 + 0.05);
            const colour = mix(base, INK, glyphHits / backgroundHits);

            rgba[offset] = colour[0];
            rgba[offset + 1] = colour[1];
            rgba[offset + 2] = colour[2];
            // The corner alpha comes from the same supersampled coverage, so the rounded
            // corners stay smooth instead of stepping.
            rgba[offset + 3] = Math.round((backgroundHits / total) * 255);
        }
    }

    return encodePng(size, size, rgba);
}

// ---------------------------------------------------------------------------
// ICO container
// ---------------------------------------------------------------------------

/**
 * Packs PNGs into a Windows icon.
 *
 * PNG-compressed entries are valid from Vista onward and every current browser reads them,
 * which is why this does not need a hand-written BMP encoder for the older formats.
 */
function encodeIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);  // reserved
    header.writeUInt16LE(1, 2);  // type: icon
    header.writeUInt16LE(images.length, 4);

    const directory = Buffer.alloc(16 * images.length);
    let offset = header.length + directory.length;

    images.forEach((image, index) => {
        const at = index * 16;
        // 0 in this byte means 256, so it is used deliberately rather than truncated.
        directory[at] = image.size >= 256 ? 0 : image.size;
        directory[at + 1] = image.size >= 256 ? 0 : image.size;
        directory[at + 2] = 0;  // palette size: truecolour
        directory[at + 3] = 0;  // reserved
        directory.writeUInt16LE(1, at + 4);   // colour planes
        directory.writeUInt16LE(32, at + 6);  // bits per pixel
        directory.writeUInt32LE(image.data.length, at + 8);
        directory.writeUInt32LE(offset, at + 12);
        offset += image.data.length;
    });

    return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function write(name, data) {
    const target = path.join(PUBLIC_DIR, name);
    fs.writeFileSync(target, data);
    console.log(`wrote public/${name} (${data.length} bytes)`);
}

const sizes = [16, 32, 48, 64, 128, 256];
const rendered = sizes.map((size) => ({ size, data: renderIcon(size) }));

write('favicon.ico', encodeIco(rendered));
for (const size of [192, 512]) {
    write(`icon-${size}.png`, renderIcon(size));
}
write('favicon-32.png', rendered.find((image) => image.size === 32).data);
write('apple-touch-icon.png', renderIcon(180));

/**
 * A vector twin of the raster mark.
 *
 * Browsers that support it render the tab icon at the display's real density, so a 32px tab
 * is drawn from curves rather than upscaled from 32 raster pixels. The letterform is written
 * as a path -- the same stem, bowl, and leg the rasterizer draws -- so both stay in step when
 * the shape is changed.
 */
write('favicon.svg', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="RewardZone">
  <defs>
    <linearGradient id="rz" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb(${LIME_LIGHT.join(',')})"/>
      <stop offset="1" stop-color="rgb(${LIME_DARK.join(',')})"/>
    </linearGradient>
  </defs>
  <rect x="4.5" y="4.5" width="91" height="91" rx="22" fill="url(#rz)"/>
  <g fill="rgb(${INK.join(',')})">
    <path d="M24 22h22a15 15 0 0 1 0 30H24z"/>
    <path d="M46 22h-4v8h4a4 4 0 0 0 0-8z" fill="url(#rz)"/>
    <path d="M44 48h10.5L68 78H56.5z"/>
  </g>
</svg>
`, 'utf8'));
write('site.webmanifest', Buffer.from(`${JSON.stringify({
    name: 'RewardZone',
    short_name: 'RewardZone',
    description: 'Browse available offers and track your rewards.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f5f2ea',
    theme_color: '#2449d8',
    icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
}, null, 2)}\n`, 'utf8'));
