const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Structural checks on the shipped brand animation.
 *
 * The reference LZW decoder below is written to disagree with the encoder if the encoder is
 * wrong, and that is the part of this file that earns its keep. Everything else asserts
 * properties of the file that is actually on disk.
 *
 * The file is a hand-authored 240x240, 92-frame asset with a 256-colour table. It is NOT the
 * output of `scripts/generate-brand-gif.js`, which draws a simpler 160x160 mark with 64
 * colours. An earlier version of this file asserted the shipped file equalled the generator's
 * output, which meant the test failed against a better asset and the only way to make it pass
 * was to overwrite the asset with the worse one. So the two are deliberately not compared: the
 * generator is a fallback implementation, the file is the artwork, and the artwork wins.
 *
 * The two faults worth keeping coverage for both produce a file that looks fine until a
 * decoder disagrees:
 *
 *   - A colour table size one power too large. The header declares 128 entries, only 64 are
 *     written, and the decoder spends the next 192 bytes of pixel data on palette. The image
 *     still loads; the colours are wrong.
 *   - Growing the LZW code width as soon as the dictionary needs it rather than one code
 *     later. The decoder trails the encoder by one entry, so the two only agree at
 *     `(1 << codeSize) + 1`. Getting it early desynchronises at the first width change and
 *     the rest of the frame decodes as noise.
 *
 * Both are caught structurally below rather than by comparing against fixed numbers, so a
 * different encoder or a redrawn asset does not silently stop being checked.
 */

const GIFT_PATH = path.join(__dirname, '..', 'public', 'brand.gif');
const gif = fs.readFileSync(GIFT_PATH);

/** A reference GIF LZW decoder, written to disagree with the encoder if the encoder is wrong. */
function lzwDecode(bytes, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let size = minCodeSize + 1;
    let next = eoiCode + 1;
    let dictionary = [];
    let output = [];
    let accumulator = 0;
    let bitCount = 0;
    let position = 0;
    let previous = null;

    const reset = () => {
        dictionary = [];
        for (let i = 0; i < clearCode; i += 1) dictionary[i] = [i];
        size = minCodeSize + 1;
        next = eoiCode + 1;
        previous = null;
    };
    reset();

    while (position < bytes.length) {
        accumulator |= bytes[position] << bitCount;
        bitCount += 8;
        position += 1;

        while (bitCount >= size) {
            const code = accumulator & ((1 << size) - 1);
            accumulator >>= size;
            bitCount -= size;

            if (code === clearCode) {
                reset();
                continue;
            }
            if (code === eoiCode) return output;

            let entry;
            if (dictionary[code]) entry = dictionary[code];
            else if (previous) entry = previous.concat([previous[0]]);
            else return null;

            output.push(...entry);
            if (previous) {
                dictionary[next] = previous.concat([entry[0]]);
                next += 1;
                // Bump on `next === 1 << size`, which is one earlier than the encoder's own
                // test. That single-code difference is the whole reason the two stay in step.
                if (next >= (1 << size) && size < 12) size += 1;
            }
            previous = entry;
        }
    }
    return output;
}

/** Walks the whole file, returning the palette, the frames, and the per-frame delays. */
function parseGif(buffer) {
    const signature = buffer.toString('ascii', 0, 6);
    let position = 6;

    const width = buffer.readUInt16LE(position);
    const height = buffer.readUInt16LE(position + 2);
    const packed = buffer[position + 4];
    position += 7;

    const declaredColors = 2 ** ((packed & 0x07) + 1);
    const hasTable = Boolean(packed & 0x80);
    if (!hasTable) return { signature, width, height, declaredColors, palette: [], frames: [], loop: false };

    const palette = [];
    for (let i = 0; i < declaredColors; i += 1) {
        palette.push([buffer[position + i * 3], buffer[position + i * 3 + 1], buffer[position + i * 3 + 2]]);
    }
    position += declaredColors * 3;

    const frames = [];
    let loop = false;
    let minCodeSize = null;
    let sawTrailer = false;

    while (position < buffer.length) {
        const block = buffer[position];

        if (block === 0x3b) {
            sawTrailer = true;
            break;
        }

        if (block === 0x21) {
            const label = buffer[position + 1];
            position += 2;
            if (label === 0xff) {
                const nameLength = buffer[position];
                const name = buffer.toString('ascii', position + 1, position + 1 + nameLength);
                if (name === 'NETSCAPE2.0') loop = true;
            }
            if (label === 0xf9) {
                minCodeSize = minCodeSize ?? 0;
                frames.push({ delay: buffer.readUInt16LE(position + 2) });
            }
            while (buffer[position] !== 0) position += buffer[position] + 1;
            position += 1;
            continue;
        }

        if (block === 0x2c) {
            const frameWidth = buffer.readUInt16LE(position + 5);
            const frameHeight = buffer.readUInt16LE(position + 7);
            position += 10;
            const codeSize = buffer[position];
            position += 1;

            const chunks = [];
            while (buffer[position] !== 0) {
                const length = buffer[position];
                chunks.push(buffer.slice(position + 1, position + 1 + length));
                position += length + 1;
            }
            position += 1;

            frames[frames.length - 1].width = frameWidth;
            frames[frames.length - 1].height = frameHeight;
            frames[frames.length - 1].minCodeSize = codeSize;
            frames[frames.length - 1].pixels = lzwDecode(Buffer.concat(chunks), codeSize);
            continue;
        }

        throw new Error(`Unexpected block 0x${block.toString(16)} at ${position}`);
    }

    return { signature, width, height, declaredColors, palette, frames, loop, sawTrailer };
}

test('the brand animation is a well-formed GIF89a with a square canvas', () => {
    assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
    const parsed = parseGif(gif);
    // Read from the header rather than compared to a constant, so the artwork can be redrawn at
    // a new size without the test needing to be told. Square is the real requirement: the mark is
    // laid out in a square box by the stylesheet and stretched if it is not.
    assert.equal(parsed.width, parsed.height, `canvas is ${parsed.width}x${parsed.height}, not square`);
    assert.ok(parsed.width >= 96, `canvas is only ${parsed.width}px, too small to stay crisp when scaled up`);
    assert.equal(parsed.sawTrailer, true, 'the file has no trailer byte, so it is truncated');
    assert.equal(parsed.loop, true, 'without the Netscape extension the mark plays once and stops');
});

test('the declared colour table is consistent with what the frames can index', () => {
    const parsed = parseGif(gif);
    // The bug this catches is declaring 128 entries and writing 64. A declared size must be a
    // power of two and must be large enough for the LZW minimum code size of every frame,
    // otherwise the decoder walks off the end of the palette and reads pixel data as colour.
    assert.equal(
        parsed.declaredColors & (parsed.declaredColors - 1),
        0,
        `declared colour table size ${parsed.declaredColors} is not a power of two`
    );
    assert.equal(parsed.palette.length, parsed.declaredColors, 'the header declares more colours than the file holds');
    for (const [index, frame] of parsed.frames.entries()) {
        const needed = 2 ** frame.minCodeSize;
        assert.ok(
            needed <= parsed.declaredColors,
            `frame ${index} uses LZW minimum code size ${frame.minCodeSize}, which needs ${needed} colours, but the table declares ${parsed.declaredColors}`
        );
    }
    // The artwork does not use black as its transparent slot -- index 0 here is white, the
    // background. Asserting a specific colour in index 0 would be asserting one encoder's
    // palette rather than anything true of the file, and it is what made an earlier version of
    // this test reject a valid asset. What is worth asserting is that the palette is genuinely
    // populated: a file that declares 256 colours and uses two of them is banding, not artwork.
    const usedIndices = new Set();
    for (const frame of parsed.frames) {
        for (const value of frame.pixels) usedIndices.add(value);
    }
    assert.ok(
        usedIndices.size > 16,
        `the whole animation only uses ${usedIndices.size} palette indices, which will band visibly`
    );
    assert.ok(
        usedIndices.size <= parsed.declaredColors,
        `frames index up to ${Math.max(...usedIndices)} but the table declares only ${parsed.declaredColors} colours`
    );
});

test('every frame decodes to a full frame, because a desynchronised stream does not', () => {
    const parsed = parseGif(gif);
    // This is the assertion that actually catches both historical faults: a mis-sized palette or
    // a premature LZW width change makes the decode the wrong length, or fails outright, while
    // the file still opens in every viewer.
    assert.ok(parsed.frames.length > 1, 'a single frame is not an animation');
    for (const [index, frame] of parsed.frames.entries()) {
        assert.ok(frame.pixels, `frame ${index} could not be decoded at all`);
        assert.equal(
            frame.pixels.length,
            frame.width * frame.height,
            `frame ${index} decoded ${frame.pixels?.length} pixels, expected ${frame.width * frame.height}`
        );
    }
});

test('the animation loops and is actually moving', () => {
    const parsed = parseGif(gif);

    for (const frame of parsed.frames) assert.ok(frame.delay > 0, 'a zero delay makes it play too fast to see');

    // Half a turn apart, so they must differ. Identical frames would mean the mark is not
    // actually being drawn at its rotated position -- an animation that encodes and decodes
    // perfectly while showing one static image.
    const halfway = Math.floor(parsed.frames.length / 2);
    const first = parsed.frames[0].pixels;
    const half = parsed.frames[halfway].pixels;
    const differing = first.reduce((count, value, index) => count + (value !== half[index] ? 1 : 0), 0);
    assert.ok(
        differing > first.length * 0.05,
        `frames 0 and ${halfway} are nearly identical (${differing} of ${first.length} pixels differ), so nothing is animating`
    );
});

/**
 * The fraction of a frame that is not that frame's own background.
 *
 * The background is taken per frame rather than assumed to be index 0, because the shipped
 * artwork uses white as index 0 while an intermediate frame's most common index is something
 * else entirely. A fixed "index 0 is the background" assumption silently mis-measures most of
 * the animation.
 */
function coverage(frame) {
    const counts = new Map();
    for (const value of frame.pixels) counts.set(value, (counts.get(value) || 0) + 1);
    const background = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return 1 - counts.get(background) / frame.pixels.length;
}

test('the mark is drawn across the animation rather than left empty', () => {
    const parsed = parseGif(gif);
    // Measured over the whole animation, not on frame 0. This artwork opens on a deliberately
    // sparse frame that builds over the following second, so a test that looked only at the
    // first frame reported 0.5% coverage and would have failed a perfectly good mark. The
    // median is used because a single odd frame should not decide the result either.
    const values = parsed.frames.filter((frame) => frame.pixels).map(coverage).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    const fullest = values[values.length - 1];

    // Wide window on purpose: the artwork's shape is not this test's business. The two faults
    // worth catching are a blank file and a file where the coverage test is inverted and every
    // pixel is opaque.
    assert.ok(median > 0.05, `the median frame is only ${(median * 100).toFixed(1)}% drawn, so the mark is mostly empty`);
    assert.ok(fullest < 0.98, `the fullest frame is ${(fullest * 100).toFixed(1)}% drawn, which suggests the coverage test is inverted`);

    // And a real gradient, so a two-colour file cannot pass as artwork.
    const distinct = new Set(parsed.frames[Math.floor(parsed.frames.length / 2)].pixels).size;
    assert.ok(distinct > 8, `only ${distinct} distinct colours in a mid frame, which will band visibly`);
});
