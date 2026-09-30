const pool = require('../config/db');

// ---------------------------------------------------------------------------
// Profile: display name and picture
// ---------------------------------------------------------------------------
//
// Both fields are presentation-only. Neither is an identifier, neither is looked up to
// authorise anything, and neither is resolved against another account -- a rename cannot
// touch a ledger row, a deposit, or a session, because nothing reads these columns to
// decide what a user is allowed to do. That is the whole reason this is safe to let a user
// type freely into it.
//
// The validation below is deliberately strict, and it runs on the server rather than
// trusting the browser. A client-side check is a convenience for the person typing; a
// server-side check is the actual control, because the client is the untrusted side of
// this conversation. Every rule below is enforced here regardless of what the UI allowed.

/**
 * The longest display name stored.
 *
 * Sixty characters covers a full name, a handle, and a short "what should we call you"
 * without becoming a place to paste a paragraph. It is enforced after normalisation, so
 * the limit describes what is actually stored rather than what was typed before
 * whitespace was collapsed.
 */
const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * The largest decoded image accepted, in bytes.
 *
 * Sized against the deployment rather than picked round. The JSON body parser caps a
 * request at 32 KB and base64 inflates by 4/3, so 16 KB of decoded image is about 22 KB of
 * data URL -- which fits a request with room for the JSON envelope around it. The number
 * is what keeps a `users` row from being grown into a storage problem by a client posting
 * large pictures, and it is checked on the *decoded* length so the cap cannot be bypassed
 * by a longer encoding of the same bytes.
 */
const MAX_AVATAR_BYTES = 16 * 1024;

/**
 * The image types accepted.
 *
 * `svg+xml` is absent on purpose. SVG is a document format that can carry script, and
 * serving user-supplied SVG from a `data:` URL is a stored-XSS shape even when the
 * reference is an `<img>`, because the escaping rules differ from the raster formats and
 * have changed across engines. Raster formats here are decoded as images and cannot carry
 * executable content, so the allow-list is the boundary rather than a preference.
 *
 * The list is deliberately wider than the file picker suggests it needs to be. The browser
 * re-encodes whatever the user picks to PNG on a canvas before it is sent, so in practice
 * only PNG ever arrives -- but a client that sends the original bytes should not be refused
 * for being a format the server already knows how to verify, and adding a format here is
 * cheaper than debugging a rejection nobody expected.
 *
 * AVIF and HEIC are worth a note. AVIF is a real, increasingly common web format with a
 * stable container signature, so it is accepted. HEIC is *not*, despite being what an iPhone
 * camera produces: its container is an ISO-BMFF `ftyp` box whose brand string is what
 * distinguishes the variants, so a signature check would accept a large family of unrelated
 * files. Accepting an unverifiable type would defeat the check that makes this whole
 * function safe, and the browser cannot decode HEIC for the client to re-encode either
 * outside Safari. HEIC is refused with a message that says what to do instead.
 */
const AVATAR_TYPES = new Map([
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['image/jpeg', [0xff, 0xd8, 0xff]],
    ['image/gif', [0x47, 0x49, 0x46, 0x38]],
    ['image/webp', 'RIFF'],
    ['image/avif', null],
    ['image/bmp', [0x42, 0x4d]],
    ['image/x-icon', [0x00, 0x00, 0x01, 0x00]],
    ['image/vnd.microsoft.icon', [0x00, 0x00, 0x01, 0x00]]
]);

/**
 * Formats a person might plausibly pick that are refused, with what to do about it.
 *
 * Returned as a specific message rather than folded into the generic "must be a PNG, JPEG,
 * GIF, or WebP" rejection, because the two cases call for different actions: an unsupported
 * *type* is fixed by choosing another file, and a HEIC is fixed by the operating system.
 * Telling someone to "pick another image" when their camera only produces this one is a
 * dead end with no visible cause.
 */
const AVATAR_REJECTIONS = new Map([
    ['image/heic', 'That looks like a HEIC photo, which browsers outside Safari cannot open. In Photos, choose Export and pick JPEG, or take the screenshot.'],
    ['image/heif', 'That looks like a HEIC photo, which browsers outside Safari cannot open. In Photos, choose Export and pick JPEG, or take the screenshot.'],
    ['image/svg+xml', 'Profile pictures cannot be SVG files, because an SVG can contain code. Save or screenshot the image as a PNG or JPEG instead.']
]);

/**
 * Matches a base64 `data:` URL and captures the declared type and the payload.
 *
 * The payload pattern is the strict base64 alphabet with correct padding rather than
 * `[^,]+`. A loose pattern would accept a payload containing spaces, newlines, or URL
 * characters that `Buffer.from(..., 'base64')` silently discards, so a request could carry
 * bytes the length check never saw.
 */
const AVATAR_PATTERN = /^data:(image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|heic|heif|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/;

// ---------------------------------------------------------------------------
// Display name
// ---------------------------------------------------------------------------

/**
 * Collapses whitespace runs to single spaces and trims the ends.
 *
 * Written as a replace over `\s` rather than a trim alone because the interesting case is
 * not a leading space, it is a name typed with a double space or a pasted non-breaking
 * space. Those survive `trim()` (for the non-breaking one) and are stored verbatim, so two
 * users whose names differ only in spacing render identically and look identical in the
 * interface.
 */
function collapseWhitespace(value) {
    return value.replace(/\s+/g, ' ');
}

/**
 * Validates and normalises a display name.
 *
 * Returns `{ ok: true, value }` where `value` is the string to store or `null` to clear
 * it, or `{ ok: false, error }` with a message written for the person who typed it.
 *
 * An empty name is not an error: it is how the user removes the one they set. The UI has a
 * "Remove" affordance that submits an empty string, and treating that as invalid would
 * mean the only way to clear a name is for the server to be lied to.
 *
 * Whitespace -- including tab and newline -- is folded to single spaces, because a name
 * pasted with a line break in it is a paste artefact rather than an attempt to smuggle a
 * control character. Control characters that whitespace does not cover are rejected rather
 * than stripped: stripping would silently change what the user typed, and a name that
 * comes back different from what they entered is its own bug report.
 */
function normaliseDisplayName(input) {
    if (input === null) return { ok: true, value: null };
    if (typeof input !== 'string') {
        return { ok: false, error: 'Display name must be text.' };
    }

    // Collapsed *before* the character checks rather than after, which is the part that has
    // to be in this order. Tab, newline, and carriage return are control characters and are
    // rejected below -- but they are also whitespace, so a name pasted with a line break in
    // it is a paste artefact rather than an attempt to smuggle one, and the useful answer
    // is to fold it to a space. Checking first would refuse a name that the user simply
    // copied badly, with an "invalid character" message that describes the problem as
    // something it is not.
    const value = collapseWhitespace(input.trim());
    if (value.length === 0) return { ok: true, value: null };

    for (const character of value) {
        const code = character.codePointAt(0);
        if (code >= 0xd800 && code <= 0xdfff) {
            return { ok: false, error: 'Display name contains an invalid character.' };
        }
        // C0 controls, DEL, and the C1 range. Tab, newline, and carriage return were folded
        // into spaces by the collapse above, so what reaches here is a control character
        // with no rendering and no legitimate appearance in a name.
        if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
            return { ok: false, error: 'Display name contains an invalid character.' };
        }
    }

    if (value.length > MAX_DISPLAY_NAME_LENGTH) {
        return { ok: false, error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.` };
    }
    return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

/**
 * Whether the decoded bytes actually begin with the signature of the declared type.
 *
 * The declared media type in a `data:` URL is a claim by whoever sent it, and nothing
 * checks it. A payload that says `image/png` and is not one is a polyglot: harmless in an
 * `<img>` today, and a problem the moment the same string is served from a context that
 * sniffs content -- a `Content-Disposition` download, a proxy, an email client. Checking
 * the leading bytes is a few comparisons and makes the stored value honest about what it
 * is.
 *
 * Three shapes, because the formats do not agree on a magic number:
 *   - `webp` is a RIFF container: bytes 0-3 are `RIFF` and bytes 8-11 are `WEBP`, with the
 *     container size between them. Both halves are required, because `RIFF` on its own is
 *     also the start of a WAV.
 *   - `avif` is an ISO-BMFF file: bytes 4-7 are the `ftyp` box type. The `ftyp` brand is
 *     checked too (`avif` or `avis`), since a bare `ftyp` covers a whole family of MP4
 *     derivatives that are not images.
 *   - everything else has a fixed byte signature and is compared directly.
 */
function matchesDeclaredType(buffer, declaredType) {
    // Membership, not truthiness. The container formats below are mapped to `null` to mean
    // "no fixed byte signature, check this one structurally", and testing the value for
    // truthiness rejected them as unknown -- which is exactly the bug this shape invites.
    if (!AVATAR_TYPES.has(declaredType)) return false;
    const signature = AVATAR_TYPES.get(declaredType);

    if (declaredType === 'image/webp') {
        return buffer.length >= 12 &&
            buffer.toString('ascii', 0, 4) === 'RIFF' &&
            buffer.toString('ascii', 8, 12) === 'WEBP';
    }

    if (declaredType === 'image/avif') {
        if (buffer.length < 12) return false;
        if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
        const brand = buffer.toString('ascii', 8, 12);
        return brand === 'avif' || brand === 'avis';
    }

    if (buffer.length < signature.length) return false;
    return signature.every((byte, index) => buffer[index] === byte);
}

/**
 * Validates a `data:` URL avatar and returns it unchanged, or `null` to clear it.
 *
 * Returns the URL rather than a re-encoded version so the bytes the user chose are the
 * bytes stored; re-encoding would change the length and would be a lossy step for no gain.
 *
 * The length is checked twice, and the order matters. The encoded length is rejected
 * first, before any decode, because a caller can send a multi-megabyte string and the
 * point of the cap is to not spend the memory. Only once the string is known to be small
 * is it decoded, and the decoded length is checked as well so a longer encoding of the
 * same bytes cannot slip past.
 */
function normaliseAvatar(input) {
    if (input === null) return { ok: true, value: null };
    if (typeof input !== 'string') {
        return { ok: false, error: 'Profile picture must be an image.' };
    }

    const trimmed = input.trim();
    if (trimmed.length === 0) return { ok: true, value: null };

    const match = AVATAR_PATTERN.exec(trimmed);
    if (!match) {
        return { ok: false, error: 'Profile picture must be a PNG, JPEG, GIF, WebP, AVIF, or BMP image.' };
    }

    // A recognised type that is deliberately refused gets its own message, because the fix
    // differs: an SVG means "save it as a raster image", a HEIC means "export from Photos".
    // Both are things the person can actually do, and neither is served by "pick another
    // file" when the camera only ever produces that file.
    const specific = AVATAR_REJECTIONS.get(match[1]);
    if (specific) return { ok: false, error: specific };

    // 4 base64 characters per 3 bytes, plus the `data:<type>;base64,` prefix. Checked
    // against the raw string so an oversized upload is refused without being decoded.
    const prefixLength = trimmed.length - match[2].length;
    const maxEncodedLength = Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + prefixLength;
    if (match[2].length > maxEncodedLength) {
        return { ok: false, error: 'Profile picture must be 16 KB or smaller.' };
    }

    let buffer;
    try {
        buffer = Buffer.from(match[2], 'base64');
    } catch {
        // The pattern already restricts the alphabet, so this is unreachable in practice.
        // It is handled rather than left to propagate because a throw here would be
        // reported as a 500, and a malformed picture is a client error, not a server one.
        return { ok: false, error: 'Profile picture could not be read.' };
    }

    if (buffer.length === 0) {
        return { ok: false, error: 'Profile picture could not be read.' };
    }
    if (buffer.length > MAX_AVATAR_BYTES) {
        return { ok: false, error: 'Profile picture must be 16 KB or smaller.' };
    }
    if (!matchesDeclaredType(buffer, match[1])) {
        return { ok: false, error: 'Profile picture is not a valid image.' };
    }

    return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Reads one user's stored profile.
 *
 * Returns `null` when the account does not exist, so a caller cannot mistake "no such
 * user" for "user is fine, with no name set" -- the two need different handling and a
 * `|| {}` would collapse them.
 *
 * The email is read here rather than pulled from wherever the client happens to have it
 * cached. The account menu has to say *who* is signed in, and `sessionStorage` holds an
 * address that is correct from the moment of sign-in and never checked again -- so after a
 * password change, or on a shared device where two accounts have signed in in turn, it is
 * a claim about the past rather than a fact about the present. Reading it alongside
 * everything else means the whole menu is painted from one answer to one request.
 */
async function loadProfile(userId) {
    const result = await pool.query(
        'SELECT id, display_name, avatar_data, email FROM users WHERE id = $1',
        [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
        // The id is the account's own number, returned to the account that owns it. It grants
        // nothing -- every route still resolves the user from the session token -- and it is
        // what a support agent needs to find the right row.
        id: row.id ?? userId,
        displayName: row.display_name || null,
        avatarData: row.avatar_data || null,
        email: row.email || null
    };
}

/**
 * Writes the fields that were supplied, leaving the others alone.
 *
 * The set is built dynamically from the keys actually present rather than written as one
 * fixed statement, because a `PATCH` that always writes both columns would blank the
 * picture every time someone changed only their name -- the client cannot know the current
 * value it is not sending, and a read-modify-write on the client is a race with two tabs
 * open. Only the fields the caller named are written, so an update touches exactly what was
 * asked for.
 *
 * The values written are read back from the row rather than echoed from the arguments, so
 * what the caller is told matches what the database holds.
 */
async function saveProfile(userId, patch) {
    const columns = [];
    const values = [];
    if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) {
        values.push(patch.displayName);
        columns.push(`display_name = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'avatarData')) {
        values.push(patch.avatarData);
        columns.push(`avatar_data = $${values.length}`);
    }

    if (columns.length === 0) return { updated: false, profile: null };

    values.push(userId);
    const result = await pool.query(
        `UPDATE users SET ${columns.join(', ')} WHERE id = $${values.length}
         RETURNING id, email, display_name, avatar_data`,
        values
    );

    const row = result.rows[0];
    if (!row) return { updated: false, profile: null };
    return {
        updated: true,
        // The same shape `loadProfile` returns. A `PATCH` that answered with only the two
        // fields it wrote would be a second, smaller version of this resource, and the
        // client's next move after a save is to paint the whole thing again -- at which point
        // the two answers disagree about what a profile is.
        profile: {
            id: row.id ?? userId,
            displayName: row.display_name || null,
            avatarData: row.avatar_data || null,
            email: row.email || null
        }
    };
}

module.exports = {
    MAX_DISPLAY_NAME_LENGTH,
    MAX_AVATAR_BYTES,
    AVATAR_TYPES,
    collapseWhitespace,
    normaliseDisplayName,
    normaliseAvatar,
    loadProfile,
    saveProfile
};
