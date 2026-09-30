const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const app = require('../src/app');
const profile = require('../src/services/profile');

/**
 * The display name and profile picture, and the endpoint that writes them.
 *
 * These two fields are presentation-only, and the properties worth protecting follow from
 * that. Nothing reads them to decide what a user may do, so the interesting risks are
 * about what gets *stored* and rendered:
 *
 *   - the server validates, not the browser. A client-side check is a convenience for the
 *     person typing; the stored value is what ends up next to a balance, and the browser is
 *     the untrusted side of this connection. Every rule below is exercised through the HTTP
 *     endpoint with values a well-behaved client would never send.
 *   - the picture is an actual image of the type it claims to be. The media type in a
 *     `data:` URL is a claim by the sender and nothing checks it, so the leading bytes are
 *     verified against it. SVG is excluded outright because it can carry script.
 *   - a partial update touches only the field it names. Changing a name must not blank a
 *     picture, which is the failure mode a fixed two-column UPDATE would produce.
 */

/** Replaces the module's pool for the duration of a call, and puts the real one back. */
async function withPool(query, run) {
    const original = pool.query;
    pool.query = query;
    try {
        return await run();
    } finally {
        pool.query = original;
    }
}

let server;
let origin;
let priorJwt;
const jwtSecret = 'profile-endpoint-test-secret';

/** Mints a bearer token the auth middleware accepts. */
function signUserToken(subject) {
    return jwt.sign({ sub: String(subject) }, jwtSecret, { issuer: 'offer-network-api' });
}

function authHeaders(subject) {
    return { Authorization: `Bearer ${signUserToken(subject)}`, 'Content-Type': 'application/json' };
}

/**
 * A one-pixel PNG, as a data URL.
 *
 * Real bytes rather than a fabricated string, because the type check reads the signature:
 * a payload that is not actually a PNG is exactly the case the check exists to refuse.
 */
const ONE_PIXEL_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A data URL that declares PNG but contains JPEG magic bytes. */
const PNG_DECLARING_JPEG =
    'data:image/png;base64,' +
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

before(async () => {
    priorJwt = process.env.JWT_SECRET;
    process.env.JWT_SECRET = jwtSecret;
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (priorJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = priorJwt;
});

/**
 * Serves the session lookup and captures every write.
 *
 * `requireAuth` reads `token_version` and `is_banned`, so the stub has to answer that query
 * as well as the profile write -- otherwise these tests would fail as authentication errors
 * and read as a broken endpoint.
 */
function withUserRow(stored, run) {
    const writes = [];
    return withPool(async (query, params) => {
        const sql = String(query).replace(/\s+/g, ' ').trim();
        if (/FROM users WHERE id = \$1$/.test(sql) && /SELECT/.test(sql)) {
            return { rows: [{ token_version: 0, is_banned: false, ...stored }], rowCount: 1 };
        }
        if (/UPDATE users SET/.test(sql)) {
            writes.push({ sql, params });
            return { rows: [{ ...stored, ...paramsToStored(sql, params) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }, async () => {
        const result = await run();
        return { result, writes };
    });
}

/**
 * Reconstructs what the row would hold from the UPDATE's positional parameters.
 *
 * The column each parameter belongs to is read out of the statement rather than assumed to
 * be `display_name` first. A partial update writes only the column it names, so on an
 * avatar-only save the first parameter is the picture -- assuming the order would quietly
 * put a data URL in a name column and make the round-trip assertions test nothing.
 */
function paramsToStored(sql, params) {
    const stored = {};
    const assignments = [...sql.matchAll(/(display_name|avatar_data) = \$(\d+)/g)];
    for (const [, column, index] of assignments) {
        stored[column] = params[Number(index) - 1];
    }
    return stored;
}

// ---------------------------------------------------------------------------
// Display name
// ---------------------------------------------------------------------------

test('a display name is trimmed, and internal spacing is collapsed', () => {
    // Two people whose names differ only in spacing render identically if it is stored
    // verbatim, so `trim()` alone is not enough -- the runs between words matter too. A
    // pasted non-breaking space survives `trim()` entirely.
    assert.equal(profile.normaliseDisplayName('  Ada   Lovelace  ').value, 'Ada Lovelace');
    assert.equal(profile.normaliseDisplayName('Ada\u00a0Lovelace').value, 'Ada Lovelace');
    // Tab, newline, and carriage return are whitespace, so a name pasted with a line break
    // in it is folded to a space rather than refused. Refusing it would describe a paste
    // artefact as an attempt to smuggle a control character.
    assert.equal(profile.normaliseDisplayName('Ada\tLovelace').value, 'Ada Lovelace');
    assert.equal(profile.normaliseDisplayName('Ada\nLovelace').value, 'Ada Lovelace');
    assert.equal(profile.normaliseDisplayName('Ada\r\nLovelace').value, 'Ada Lovelace');
});

test('an empty name clears the field rather than being an error', () => {
    // This is how the "remove" affordance works. Treating it as invalid would mean the only
    // way to clear a name is for the client to send something the server dislikes.
    assert.equal(profile.normaliseDisplayName('').value, null);
    assert.equal(profile.normaliseDisplayName('   ').value, null);
    assert.equal(profile.normaliseDisplayName(null).value, null);
});

test('accents, apostrophes, and non-Latin scripts are kept as typed', () => {
    // The whole point of a display name is that it holds what a person actually calls
    // themselves. A validation rule that strips these would rename the user for them.
    for (const name of ['Zoë', "O'Brien", 'Иван', '日本語', 'Ω']) {
        assert.equal(profile.normaliseDisplayName(name).value, name);
    }
});

test('control characters are refused rather than silently stripped', () => {
    // Stripping would store something different from what was typed, and the user would be
    // shown a name they did not enter with no indication anything happened.
    assert.equal(profile.normaliseDisplayName('Ada\u0000Lovelace').ok, false);
    assert.equal(profile.normaliseDisplayName('Ada\u0007').ok, false);
    assert.equal(profile.normaliseDisplayName('Ada\u007f').ok, false);
    assert.equal(profile.normaliseDisplayName('Ada\u009f').ok, false);
});

test('a lone surrogate is refused, because it cannot be stored as typed', () => {
    // `Buffer.from` replaces these with U+FFFD rather than throwing, so without this check
    // the row would hold a different character from the one submitted -- and the interface
    // would show the replacement, not the name.
    assert.equal(profile.normaliseDisplayName('Ada\uD800Lovelace').ok, false);
});

test('the length limit is applied to what is stored, not to what was typed', () => {
    const long = 'x'.repeat(profile.MAX_DISPLAY_NAME_LENGTH);
    assert.equal(profile.normaliseDisplayName(long).value, long);
    assert.equal(profile.normaliseDisplayName(`${long}y`).ok, false);

    // A name that is over the limit only because of the whitespace around it is not over it
    // once the whitespace is gone. The limit describes the stored value.
    assert.equal(profile.normaliseDisplayName(`   ${long}   `).value, long);
});

test('a non-string name is refused', () => {
    for (const value of [42, true, {}, []]) {
        assert.equal(profile.normaliseDisplayName(value).ok, false);
    }
});

// ---------------------------------------------------------------------------
// Profile picture
// ---------------------------------------------------------------------------

test('a real image of the declared type is accepted', () => {
    const result = profile.normaliseAvatar(ONE_PIXEL_PNG);
    assert.equal(result.ok, true);
    // Returned unchanged rather than re-encoded, so the bytes the user chose are stored.
    assert.equal(result.value, ONE_PIXEL_PNG);
});

test('an image of a type outside the allow-list is refused', () => {
    // SVG can carry script, and its escaping rules differ from the raster formats. The
    // allow-list is the boundary, not a preference. The message has to say what to do about
    // it, because "pick another file" is unhelpful when the file is a perfectly good image
    // in a format that was not accepted.
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const result = profile.normaliseAvatar(svg);
    assert.equal(result.ok, false);
    assert.match(result.error, /PNG or JPEG/i, 'the message should say what to save it as');
});

test('AVIF is accepted, and only a real AVIF', () => {
    // AVIF is an ISO-BMFF file: bytes 4-7 are `ftyp` and bytes 8-11 are the brand. A bare
    // `ftyp` covers a whole family of MP4 derivatives that are not images, so the brand has
    // to be checked too -- otherwise this is a video format wearing an image's name.
    const avif = 'data:image/avif;base64,' +
        Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypavif', 'ascii'), Buffer.alloc(8)])
            .toString('base64');
    assert.equal(profile.normaliseAvatar(avif).ok, true);

    const mp4 = 'data:image/avif;base64,' +
        Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypmp42', 'ascii'), Buffer.alloc(8)])
            .toString('base64');
    assert.equal(profile.normaliseAvatar(mp4).ok, false, 'an MP4 must not pass as an AVIF');
});

test('BMP and ICO are accepted', () => {
    const bmp = 'data:image/bmp;base64,' +
        Buffer.concat([Buffer.from('BM', 'ascii'), Buffer.alloc(8)]).toString('base64');
    assert.equal(profile.normaliseAvatar(bmp).ok, true);

    const ico = 'data:image/x-icon;base64,' +
        Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(8)]).toString('base64');
    assert.equal(profile.normaliseAvatar(ico).ok, true);
});

test('HEIC is refused with a message that says what to do instead', () => {
    // HEIC is what an iPhone camera produces. It is not accepted because its container is
    // an ISO-BMFF `ftyp` box whose brand distinguishes a whole family of files, so there is
    // no signature to check that says "this is a picture" -- accepting it would defeat the
    // check that makes the whole function safe. But the rejection has to be actionable:
    // "pick another image" is a dead end when the camera only makes this one.
    const heic = 'data:image/heic;base64,' +
        Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(8)])
            .toString('base64');
    const result = profile.normaliseAvatar(heic);
    assert.equal(result.ok, false);
    assert.match(result.error, /Export/i, 'the message should name the way out');
    assert.match(result.error, /JPEG/i);
});

test('a payload that does not match its declared type is refused', () => {
    // The media type in a `data:` URL is a claim by the sender and nothing checks it.
    assert.equal(profile.normaliseAvatar(PNG_DECLARING_JPEG).ok, false);
});

test('a RIFF file that is not WebP is refused', () => {
    // WebP is checked structurally, because a WebP file is a RIFF container and `RIFF` on
    // its own is also the start of a WAV.
    const wav = 'data:image/webp;base64,' +
        Buffer.from('RIFF....WAVEfmt ', 'ascii').toString('base64');
    assert.equal(profile.normaliseAvatar(wav).ok, false);
});

test('a non-image data URL is refused', () => {
    // A `data:text/html` URL in an `img` is inert, but the same string served from any
    // content-sniffing context is not, and there is no reason to store it here.
    const html = 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
    assert.equal(profile.normaliseAvatar(html).ok, false);
    assert.equal(profile.normaliseAvatar('data:application/javascript,alert(1)').ok, false);
});

test('a remote URL is not accepted as a picture', () => {
    // The column holds image bytes, not a link to somebody else's server. Accepting a URL
    // would make every page that renders the avatar a request to a host the user chose,
    // which leaks their IP and page view to a third party.
    assert.equal(profile.normaliseAvatar('https://example.com/avatar.png').ok, false);
    assert.equal(profile.normaliseAvatar('//example.com/avatar.png').ok, false);
    assert.equal(profile.normaliseAvatar('javascript:alert(1)').ok, false);
});

test('an oversized picture is refused before it is decoded', () => {
    // The point of the cap is not to spend the memory, so the encoded length is what gets
    // checked first. A megabyte of base64 is refused without ever being turned into bytes.
    const oversized = 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024);
    assert.equal(profile.normaliseAvatar(oversized).ok, false);
});

test('base64 outside the strict alphabet is refused', () => {
    // A loose pattern would accept spaces and newlines that the decoder silently discards,
    // so a request could carry bytes the length check never saw.
    assert.equal(profile.normaliseAvatar('data:image/png;base64,AAAA AAAA').ok, false);
    assert.equal(profile.normaliseAvatar('data:image/png;base64,AAAA\nAAAA').ok, false);
    assert.equal(profile.normaliseAvatar('data:image/png;base64,****').ok, false);
});

test('an empty picture clears the field, and so does null', () => {
    assert.equal(profile.normaliseAvatar('').value, null);
    assert.equal(profile.normaliseAvatar('   ').value, null);
    assert.equal(profile.normaliseAvatar(null).value, null);
});

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

test('the profile endpoint requires a session', async () => {
    // A profile is per-user. An unauthenticated read has to be refused outright rather than
    // returning an empty profile that the interface would render as "this is your account".
    const response = await fetch(`${origin}/api/user/profile`);
    assert.equal(response.status, 401);
});

test('a profile with nothing set reads as nulls rather than as missing', async () => {
    await withUserRow({ id: 4101, display_name: null, avatar_data: null, email: 'quiet@example.com' }, async () => {
        const response = await fetch(`${origin}/api/user/profile`, {
            headers: authHeaders(4101)
        });
        assert.equal(response.status, 200);
        // "You have not chosen a name" is a normal state with a fallback, not a 404.
        assert.deepEqual(await response.json(), {
            id: 4101,
            displayName: null,
            avatarData: null,
            email: 'quiet@example.com'
        });
    });
});

test('a stored profile is read back as the user set it', async () => {
    await withUserRow(
        { id: 4102, display_name: 'Ada Lovelace', avatar_data: ONE_PIXEL_PNG, email: 'ada@example.com' },
        async () => {
            const response = await fetch(`${origin}/api/user/profile`, {
                headers: authHeaders(4102)
            });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
                id: 4102,
                displayName: 'Ada Lovelace',
                avatarData: ONE_PIXEL_PNG,
                email: 'ada@example.com'
            });
        }
    );
});

test('a save answers with the same shape as a read', async () => {
    // A `PATCH` that returned only the two columns it wrote would be a second, smaller
    // version of this resource. The client's next move after a save is to repaint the whole
    // thing, so the two answers have to agree about what a profile is.
    await withUserRow(
        { id: 4113, display_name: 'Old', avatar_data: null, email: 'shape@example.com' },
        async () => {
            const read = await (await fetch(`${origin}/api/user/profile`, {
                headers: authHeaders(4113)
            })).json();
            const written = await (await fetch(`${origin}/api/user/profile`, {
                method: 'PATCH',
                headers: authHeaders(4113),
                body: JSON.stringify({ displayName: 'New' })
            })).json();

            assert.deepEqual(Object.keys(written).sort(), Object.keys(read).sort());
        }
    );
});

test('the email comes from the database, not from what the client believes', async () => {
    // The account menu says who is signed in. Reading the address from session storage
    // would show a claim made at sign-in time, which is wrong after a password change and
    // on a shared device where two accounts have signed in in turn. One request answers
    // everything the menu draws.
    await withUserRow({ display_name: null, avatar_data: null, email: 'real@example.com' },
        async () => {
            const response = await fetch(`${origin}/api/user/profile`, {
                headers: authHeaders(4112)
            });
            assert.equal((await response.json()).email, 'real@example.com');
        }
    );
});

test('a name saved through the endpoint is persisted, and normalised on the way in', async () => {
    const { writes } = await withUserRow(
        { display_name: null, avatar_data: null },
        async () => {
            const response = await fetch(`${origin}/api/user/profile`, {
                method: 'PATCH',
                headers: authHeaders(4103),
                body: JSON.stringify({ displayName: '  Ada   Lovelace  ' })
            });
            assert.equal(response.status, 200);
            // Reported back normalised, so the interface shows what is actually stored.
            assert.equal((await response.json()).displayName, 'Ada Lovelace');
        }
    );

    // Only the named column is written. A fixed two-column UPDATE would also blank the
    // picture, which the client cannot avoid: it does not know the current value it is not
    // sending, and reading it first is a race between two open tabs.
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /SET display_name = \$1/);
    assert.doesNotMatch(writes[0].sql, /avatar_data =/);
    // `requireAuth` builds `req.user.id` as a string (`String(rawUserId)`), so the id
    // reaching the query is a string. Asserted as it actually arrives rather than as the
    // number the token was signed with, because a driver that changed the parameter type
    // would then fail a query that works perfectly well.
    assert.deepEqual(writes[0].params, ['Ada Lovelace', '4103']);
});

test('changing a name leaves the picture alone, and vice versa', async () => {
    const { writes } = await withUserRow(
        { display_name: 'Old Name', avatar_data: ONE_PIXEL_PNG },
        async () => {
            const response = await fetch(`${origin}/api/user/profile`, {
                method: 'PATCH',
                headers: authHeaders(4104),
                body: JSON.stringify({ displayName: 'New Name' })
            });
            assert.equal(response.status, 200);
        }
    );
    assert.doesNotMatch(writes[0].sql, /avatar_data =/);
});

test('an explicit null clears a field', async () => {
    const { writes } = await withUserRow(
        { display_name: 'Ada Lovelace', avatar_data: ONE_PIXEL_PNG },
        async () => {
            const response = await fetch(`${origin}/api/user/profile`, {
                method: 'PATCH',
                headers: authHeaders(4105),
                body: JSON.stringify({ displayName: null })
            });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).displayName, null);
        }
    );
    assert.deepEqual(writes[0].params, [null, '4105']);
});

test('the server refuses what the browser would have allowed through', async () => {
    // Every one of these is a value a well-behaved client cannot produce, because the client
    // applies the same rules. They are sent directly to prove the rule lives on the server,
    // which is the side of the connection that cannot be trusted.
    const rejected = [
        { displayName: 'x'.repeat(profile.MAX_DISPLAY_NAME_LENGTH + 1) },
        { displayName: 'Ada\u0000Lovelace' },
        { displayName: 42 },
        { avatarData: 'https://example.com/avatar.png' },
        { avatarData: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
        { avatarData: PNG_DECLARING_JPEG }
    ];

    for (const body of rejected) {
        const { result, writes } = await withUserRow(
            { display_name: null, avatar_data: null },
            async () => {
                const response = await fetch(`${origin}/api/user/profile`, {
                    method: 'PATCH',
                    headers: authHeaders(4106),
                    body: JSON.stringify(body)
                });
                return { status: response.status, body: await response.json() };
            }
        );
        assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        // A message the person who typed it can act on, not a status code alone.
        assert.equal(typeof result.body.error, 'string');
        assert.ok(result.body.error.length > 0);
        // And nothing was written: a rejected value must not reach the row.
        assert.equal(writes.length, 0);
    }
});

test('an unknown field is refused rather than silently dropped', async () => {
    // A misspelled field that was ignored would produce a 200 reporting success while
    // changing nothing, and the user would be told their picture was saved.
    const { writes } = await withUserRow(
        { display_name: null, avatar_data: null },
        async () => {
            const response = await fetch(`${origin}/api/user/profile`, {
                method: 'PATCH',
                headers: authHeaders(4107),
                body: JSON.stringify({ displayname: 'Ada' })
            });
            assert.equal(response.status, 400);
        }
    );
    assert.equal(writes.length, 0);
});

test('an empty update is refused, and writes nothing', async () => {
    const { writes } = await withUserRow(
        { display_name: null, avatar_data: null },
        async () => {
            const response = await fetch(`${origin}/api/user/profile`, {
                method: 'PATCH',
                headers: authHeaders(4108),
                body: JSON.stringify({})
            });
            assert.equal(response.status, 400);
        }
    );
    // The guard matters: with no columns to set, the UPDATE would be `SET` with an empty
    // list, which is a syntax error rather than a no-op.
    assert.equal(writes.length, 0);
});

test('a write that reaches no row is reported rather than reported as saved', async () => {
    await withPool(async (query) => {
        const sql = String(query).replace(/\s+/g, ' ').trim();
        if (/SELECT/.test(sql)) return { rows: [{ token_version: 0, is_banned: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    }, async () => {
        const response = await fetch(`${origin}/api/user/profile`, {
            method: 'PATCH',
            headers: authHeaders(4109),
            body: JSON.stringify({ displayName: 'Ada' })
        });
        // The session check passed a moment ago, so this is the account disappearing in
        // between. A 200 here would claim a change that did not happen.
        assert.equal(response.status, 404);
    });
});

test('a profile picture survives the round trip through storage', async () => {
    await withUserRow({ display_name: 'Ada', avatar_data: null }, async () => {
        const response = await fetch(`${origin}/api/user/profile`, {
            method: 'PATCH',
            headers: authHeaders(4110),
            body: JSON.stringify({ avatarData: ONE_PIXEL_PNG })
        });
        assert.equal(response.status, 200);
        // Byte-identical, so the rendering path is not re-encoding an image on every save.
        assert.equal((await response.json()).avatarData, ONE_PIXEL_PNG);
    });
});

test('the endpoint is registered so a wrong verb is a 405, not a 404', async () => {
    // The registry exists so an operator can tell "wrong URL" from "wrong verb". A profile
    // path that was left out of it would answer `{"error":"API route not found."}` for a
    // `PUT` that is genuinely a typo rather than a missing route.
    const response = await fetch(`${origin}/api/user/profile`, {
        method: 'DELETE',
        headers: authHeaders(4111)
    });
    assert.equal(response.status, 405);
    assert.match(response.headers.get('allow') || '', /GET/);
    assert.match(response.headers.get('allow') || '', /PATCH/);
});

test('ending every session needs a session to end', async () => {
    const response = await fetch(`${origin}/api/user/sessions/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(response.status, 401);
});

test('ending every session bumps the token version', async () => {
    // `token_version` is the whole mechanism: `requireAuth` compares it against the `ver`
    // claim on every request, so a bump invalidates every token ever signed. Anything else
    // -- a session table, a blacklist -- would be a second source of truth about who is
    // signed in, and the two would eventually disagree.
    const updates = [];
    const originalQuery = pool.query;
    pool.query = async (query, params) => {
        const sql = String(query).replace(/\s+/g, ' ').trim();
        if (/FROM users WHERE id = \$1$/.test(sql) && /SELECT/.test(sql)) {
            return { rows: [{ token_version: 0, is_banned: false }], rowCount: 1 };
        }
        if (/UPDATE users SET token_version = token_version \+ 1/.test(sql)) {
            updates.push({ sql, params });
            return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    };

    try {
        const response = await fetch(`${origin}/api/user/sessions/revoke`, {
            method: 'POST',
            headers: authHeaders(4120),
            body: '{}'
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        // The caller is signed out too, and the response has to say so: a bare 200 reads as
        // "you are still signed in, something else was revoked".
        assert.equal(body.signedOutEverywhere, true);
        assert.match(body.message, /this one/i);
    } finally {
        pool.query = originalQuery;
    }

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].params, ['4120']);
});

test('ending every session is POST-only', async () => {
    // It is a state change. A `GET` that ends every session would fire from a prefetch, a
    // crawler, or a link preview in a chat client.
    const response = await fetch(`${origin}/api/user/sessions/revoke`, {
        headers: authHeaders(4121)
    });
    assert.equal(response.status, 405);
    assert.match(response.headers.get('allow') || '', /POST/);
});
