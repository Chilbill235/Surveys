/* Builds public/brand.gif, the animated mark used in email and on the site.
 *
 * Written by hand rather than pulled from an image library for one reason: every encoder
 * available as an npm dependency pulls in a native build or a second copy of a canvas
 * implementation, and this project deliberately has no image toolchain. A GIF89a file is a
 * header, a palette, and LZW-compressed index runs, so the whole thing is a few hundred lines
 * and has nothing to keep up to date.
 *
 * The mark is drawn from arithmetic rather than from glyphs: a rounded badge with three arcs
 * turning at different rates. Rasterising a letterform would mean embedding a font, and the
 * animation would be invisible anyway in most inboxes, so the arcs carry the movement and the
 * badge carries the identity.
 *
 * Run: node scripts/generate-brand-gif.js
 */
const fs = require('fs');
const path = require('path');

const WIDTH = 160;
const HEIGHT = 160;
const FRAMES = 24;
const FRAME_DELAY_CS = 6; // Hundredths of a second. 24 frames x 6 = 1.44s per loop.

/**
 * The palette.
 *
 * A fixed 64-entry table rather than per-frame quantisation, for two reasons: the frames have
 * to agree with each other or the mark flickers as the palette shifts, and holding colours
 * still lets LZW reuse long runs, which is most of why a 24-frame animation stays small.
 * Index 0 is reserved for transparency, so nothing may draw with it.
 */
const PALETTE_SIZE = 64;
const TRANSPARENT = 0;

function buildPalette() {
    // 0: transparent
    const palette = [[0, 0, 0]];

    const push = (r, g, b) => {
        palette.push([
            Math.max(0, Math.min(255, Math.round(r))),
            Math.max(0, Math.min(255, Math.round(g))),
            Math.max(0, Math.min(255, Math.round(b)))
        ]);
    };

    // Badge gradient, navy to accent, 18 steps. This is the only large area of flat-ish
    // colour, so it takes the most of the palette and is where a quantiser would spend its
    // budget too.
    for (let i = 0; i < 18; i += 1) {
        const t = i / 17;
        push(19 + (36 - 19) * t, 28 + (73 - 28) * t, 74 + (216 - 74) * t);
    }

    // Arcs: gold, near-white, and a light blue. 15 steps each, used along a swept angle so
    // each arc is a short gradient rather than one flat colour.
    const arcRamps = [
        [245, 181, 61],
        [255, 255, 255],
        [143, 171, 255]
    ];
    for (const [r, g, b] of arcRamps) {
        for (let i = 0; i < 15; i += 1) {
            const t = i / 14;
            // Brighten toward the leading end of the sweep.
            const k = 0.45 + 0.55 * t;
            push(r * k + (255 - r) * (1 - k) * 0.35, g * k + (255 - g) * (1 - k) * 0.35, b * k + (255 - b) * (1 - k) * 0.35);
        }
    }

    while (palette.length < PALETTE_SIZE) palette.push([0, 0, 0]);
    return palette;
}

const PALETTE = buildPalette();

const IDX_BADGE = (i) => 1 + Math.max(0, Math.min(17, Math.round(i)));
const arcIndex = (ramp, t) => 19 + ramp * 15 + Math.max(0, Math.min(14, Math.round(t * 14)));

// --------------------------------------------------------------------- drawing

/** Signed distance to a rounded rectangle centred on the origin. Negative is inside. */
function roundedRectDistance(px, py, halfW, halfH, radius) {
    const qx = Math.abs(px) - halfW + radius;
    const qy = Math.abs(py) - halfH + radius;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Wraps an angle into (-PI, PI].
 *
 * Signed, deliberately. The obvious `((a % tau) + tau) % tau` gives [0, 2PI), and an arc
 * measured against that is never centred on the angle it is meant to sweep around: it is
 * clipped to wherever zero happens to fall, so the mark ends up with short slivers near angle
 * zero instead of visible arcs. Everything here needs a signed distance from a centre angle.
 */
function signedAngle(a) {
    const tau = Math.PI * 2;
    let value = a % tau;
    if (value > Math.PI) value -= tau;
    if (value <= -Math.PI) value += tau;
    return value;
}

/**
 * Renders one frame to a buffer of palette indices.
 *
 * Anti-aliasing is done by supersampling the coverage test rather than by blending, because
 * the palette is fixed: a blended edge colour does not exist in the table, so it would have to
 * be dithered, and dithering a 160px badge in an email is noise nobody benefits from.
 */
function renderFrame(frameIndex) {
    const pixels = new Uint8Array(WIDTH * HEIGHT);
    const tau = Math.PI * 2;
    const phase = (frameIndex / FRAMES) * tau;

    // Supersample grid. 3x3 is enough to keep a 2px arc from looking like a staircase.
    const SS = 3;
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2;
    const badgeHalf = 62;
    const badgeRadius = 26;

    // Three arcs, each with its own radius, sweep length, and speed. Coprime-ish speeds keep
    // the combination from visibly repeating before the loop restarts, and no two speeds
    // share a ratio, so the loop point is the only place the motion is not continuous.
    //
    // Sweeps are given in radians of a full turn. A third of a turn per arc is the smallest
    // that still reads as a sweeping comet rather than a dot; past two thirds the arcs start
    // to overlap into an indistinct ring.
    const arcs = [
        { radius: 42, half: 1.15, speed: 1.0, ramp: 0, width: 8 },
        { radius: 30, half: 0.95, speed: -1.6, ramp: 1, width: 6 },
        { radius: 18, half: 1.45, speed: 2.4, ramp: 2, width: 5 }
    ];

    for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
            let badgeCoverage = 0;
            const arcHits = [0, 0, 0];
            const arcWeights = [0, 0, 0];

            for (let sy = 0; sy < SS; sy += 1) {
                for (let sx = 0; sx < SS; sx += 1) {
                    const px = x + (sx + 0.5) / SS - cx;
                    const py = y + (sy + 0.5) / SS - cy;

                    if (roundedRectDistance(px, py, badgeHalf, badgeHalf, badgeRadius) > 0) continue;
                    badgeCoverage += 1;

                    const dist = Math.hypot(px, py);
                    const angle = Math.atan2(py, px);

                    for (let a = 0; a < arcs.length; a += 1) {
                        const arc = arcs[a];
                        const ringGap = Math.abs(dist - arc.radius);
                        if (ringGap > arc.width) continue;
                        // Signed distance from the arc's leading angle, so the sweep is
                        // centred on where the arc actually is rather than on angle zero.
                        const delta = signedAngle(angle - phase * arc.speed);
                        const reach = Math.abs(delta) / arc.half;
                        if (reach >= 1) continue;
                        // Where in the sweep this pixel sits, 0 at the trailing end, 1 at the
                        // leading end. Drives the brightness ramp along the arc.
                        const along = 1 - reach;
                        const edge = 1 - ringGap / arc.width;
                        arcHits[a] += 1;
                        arcWeights[a] += along * edge;
                    }
                }
            }

            const samples = SS * SS;
            const badge = badgeCoverage / samples;
            if (badge <= 0) continue;

            // Badge gradient runs top to bottom, then the arcs are composited over it.
            const gradient = (y / (HEIGHT - 1)) * 17;
            let index = IDX_BADGE(gradient);

            for (let a = 0; a < arcs.length; a += 1) {
                const coverage = arcHits[a] / samples;
                if (coverage <= 0) continue;
                const along = arcWeights[a] / arcHits[a];
                const arcPixel = arcIndex(arcs[a].ramp, along);
                // Composite by replacing rather than alpha-blending: the arc colour is already
                // the final colour for that position, and mixing it with the badge would
                // produce a colour that is not in the palette.
                if (coverage > 0.34) index = arcPixel;
            }

            // The badge edge is the one place a partial coverage is worth keeping, because a
            // hard corner on a rounded square is the difference between a badge and a blob.
            pixels[y * WIDTH + x] = badge < 0.999 ? (badge > 0.5 ? index : TRANSPARENT) : index;
        }
    }

    return pixels;
}

// ------------------------------------------------------------------ GIF writing

/** Packs values least-significant bit first, as GIF's LZW stream requires. */
class BitWriter {
    constructor() {
        this.bytes = [];
        this.accumulator = 0;
        this.bitCount = 0;
    }

    write(code, size) {
        this.accumulator |= code << this.bitCount;
        this.bitCount += size;
        while (this.bitCount >= 8) {
            this.bytes.push(this.accumulator & 0xff);
            this.accumulator >>= 8;
            this.bitCount -= 8;
        }
    }

    /** Pads the final partial byte and returns the stream. */
    finish() {
        if (this.bitCount > 0) {
            this.bytes.push(this.accumulator & 0xff);
            this.accumulator = 0;
            this.bitCount = 0;
        }
        return this.bytes;
    }
}

/**
 * LZW compression, GIF variant.
 *
 * The dictionary is a Map keyed by `parent * 256 + next` rather than a string, because
 * string keys made this measurably slower on a 25600-pixel frame and the numeric key cannot
 * collide for any palette size GIF allows.
 *
 * The code width grows exactly when the dictionary outgrows the current width, and the growth
 * is checked after the code that caused it has already been written. Getting that order wrong
 * desynchronises the decoder, which is the single most common way to produce a GIF that looks
 * fine until the first frame ends and then turns to noise.
 */
function lzwCompress(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let dictionary = new Map();
    const writer = new BitWriter();

    writer.write(clearCode, codeSize);

    if (indices.length === 0) {
        writer.write(eoiCode, codeSize);
        return writer.finish();
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
        const next = indices[i];
        const key = prefix * 256 + next;
        const existing = dictionary.get(key);
        if (existing !== undefined) {
            prefix = existing;
            continue;
        }
        writer.write(prefix, codeSize);
        if (nextCode < 4096) {
            dictionary.set(key, nextCode);
            nextCode += 1;
            // The width grows one code *later* than the dictionary actually needs it to. A
            // decoder adds its entry one code behind this encoder, so bumping as soon as the
            // next code would overflow reads one code too narrow and the rest of the frame
            // decodes as noise. The two sides only stay in step at `(1 << codeSize) + 1`, which
            // is verified by a round-trip in the test suite rather than trusted to the comment.
            if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
        } else {
            // Dictionary full. A clear code is cheaper than growing past 12 bits, and it keeps
            // the stream from degrading on frames with a lot of noise.
            writer.write(clearCode, codeSize);
            dictionary = new Map();
            codeSize = minCodeSize + 1;
            nextCode = eoiCode + 1;
        }
        prefix = next;
    }

    writer.write(prefix, codeSize);
    writer.write(eoiCode, codeSize);
    return writer.finish();
}

/** Splits a byte stream into GIF sub-blocks, each prefixed with its length. */
function toSubBlocks(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 255) {
        const chunk = bytes.slice(i, i + 255);
        out.push(chunk.length, ...chunk);
    }
    out.push(0);
    return out;
}

function buildGif() {
    // 64 colours, so the LZW minimum code size is 6. Log2(64) is 6, and GIF stores that
    // directly.
    const minCodeSize = 6;
    const bytes = [];

    const pushString = (text) => {
        for (const character of text) bytes.push(character.charCodeAt(0));
    };
    const push16 = (value) => {
        bytes.push(value & 0xff, (value >> 8) & 0xff);
    };

    pushString('GIF89a');

    // Logical screen descriptor. The low three bits are N, where the table holds 2^(N+1)
    // entries, so a 64-colour table is N=5. Writing 6 here declares 128 colours, and a
    // decoder that believes it will read the next 192 bytes of image data as palette -- the
    // file still opens, and the colours come out wrong, which is the worst way for this to
    // fail. The colour-resolution field above it is independent and stays at 7.
    push16(WIDTH);
    push16(HEIGHT);
    bytes.push(0x80 | 0x70 | 0x05);
    bytes.push(TRANSPARENT);
    bytes.push(0);

    for (const [r, g, b] of PALETTE) bytes.push(r, g, b);

    // Netscape looping extension, so the animation repeats forever instead of playing once.
    bytes.push(0x21, 0xff, 0x0b);
    pushString('NETSCAPE2.0');
    bytes.push(0x03, 0x01);
    push16(0); // Loop forever.
    bytes.push(0x00);

    for (let frame = 0; frame < FRAMES; frame += 1) {
        const pixels = renderFrame(frame);

        // Graphic control extension. The disposal method is left at 0 and the transparent
        // index set, because every frame is a full-canvas image that overwrites the last: there
        // is nothing to restore, and a restore would cost bandwidth for no visual gain.
        bytes.push(0x21, 0xf9, 0x04, 0x04);
        push16(FRAME_DELAY_CS);
        bytes.push(TRANSPARENT, 0x00);

        // Image descriptor, full frame, no local colour table, not interlaced.
        bytes.push(0x2c);
        push16(0);
        push16(0);
        push16(WIDTH);
        push16(HEIGHT);
        bytes.push(0x00);

        bytes.push(minCodeSize);
        bytes.push(...toSubBlocks(lzwCompress(pixels, minCodeSize)));
    }

    bytes.push(0x3b);
    return Buffer.from(bytes);
}

const output = path.join(__dirname, '..', 'public', 'brand.gif');
const gif = buildGif();
fs.writeFileSync(output, gif);

console.log(
    `Wrote ${path.relative(process.cwd(), output)} -- ${gif.length} bytes, ` +
    `${WIDTH}x${HEIGHT}, ${FRAMES} frames, ${PALETTE_SIZE} colours, ${FRAME_DELAY_CS}cs delay.`
);
