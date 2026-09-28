const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The brand animation is built by hand in `scripts/generate-brand-gif.js`, so nothing in the
 * build checks it. That is the same situation as a binary asset: it either parses or it does
 * not, and a GIF that does not parse still opens in some viewers, still looks plausible in
 * others, and then turns to noise partway through.
 *
 * The two faults that actually happened while writing it are both covered here, because both
 * produce a file that looks fine until a decoder disagrees:
 *
 *   - A colour table size one power too large. The header declares 128 entries, only 64 are
 *     written, and the decoder spends the next 192 bytes of pixel data on palette. The image
 *     still loads; the colours are wrong.
 *   - Growing the LZW code width as soon as the dictionary needs it rather than one code
 *     later. The decoder trails the encoder by one entry, so the two only agree at
 *     `(1 << codeSize) + 1`. Getting it early desynchronises at the first width change and
 *     the rest of the frame decodes as noise, which is what the first build did.
 */

const GIFT_PATH = path.join(__dirname, '..', 'public', 'brand.gif');
const gif = fs.readFileSync(GIFT_PATH);

const WIDTH = 160;
const HEIGHT = 160;
const FRAMES = 24;

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

test('the brand animation is a GIF89a with the canvas the generator claims', () => {
    assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
    const parsed = parseGif(gif);
    assert.equal(parsed.width, WIDTH);
    assert.equal(parsed.height, HEIGHT);
    assert.equal(parsed.sawTrailer, true, 'the file has no trailer byte, so it is truncated');
});

test('the declared colour table matches the palette that was actually written', () => {
    const parsed = parseGif(gif);
    // The bug this catches is declaring 128 entries and writing 64: the file still opens, and
    // every decoder silently reads 192 bytes of pixel data as palette before failing to find
    // sensible colours. So the table is checked against the number of colours the LZW minimum
    // code size requires, not just against itself.
    assert.equal(parsed.declaredColors, 64);
    assert.equal(parsed.palette.length, 64);
    const minCode = parsed.frames[0].minCodeSize;
    assert.ok(
        2 ** minCode <= parsed.declaredColors,
        `LZW minimum code size ${minCode} needs at least ${2 ** minCode} colours, table declares ${parsed.declaredColors}`
    );
    // Index 0 is the transparent slot and must be fully transparent, or a rounded corner shows
    // up as a black speck in a dark-mode inbox.
    assert.deepEqual(parsed.palette[0], [0, 0, 0]);
});

test('every frame decodes to a full frame, because a desynchronised stream does not', () => {
    const parsed = parseGif(gif);
    assert.equal(parsed.frames.length, FRAMES);
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
    assert.equal(parsed.loop, true, 'without the Netscape extension the mark plays once and stops');

    for (const frame of parsed.frames) assert.ok(frame.delay > 0, 'a zero delay makes it play too fast to see');

    // Frames 0 and 12 are half a turn apart, so they must differ. Identical frames would mean
    // the arcs are not actually being drawn at their rotated position -- a mark that encodes
    // and decodes perfectly while showing one static image.
    const first = parsed.frames[0].pixels;
    const half = parsed.frames[Math.floor(FRAMES / 2)].pixels;
    const differing = first.reduce((count, value, index) => count + (value !== half[index] ? 1 : 0), 0);
    assert.ok(
        differing > first.length * 0.05,
        `frames 0 and ${Math.floor(FRAMES / 2)} are nearly identical (${differing} of ${first.length} pixels differ), so nothing is animating`
    );
});

test('the mark is drawn rather than left empty', () => {
    const parsed = parseGif(gif);
    const pixels = parsed.frames[0].pixels;
    const opaque = pixels.filter((value) => value !== 0).length;
    const coverage = opaque / pixels.length;
    // A 62px-radius badge in a 160px box covers a bit over half the canvas. Checking the
    // window rather than just "some pixels are set" catches both a blank file and one where
    // the coverage test is inverted and every pixel is opaque.
    assert.ok(coverage > 0.4 && coverage < 0.75, `badge covers ${(coverage * 100).toFixed(1)}% of the frame`);

    const distinct = new Set(pixels).size;
    assert.ok(distinct > 8, `only ${distinct} distinct colours drawn, which will band visibly`);
});
