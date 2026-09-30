/**
 * A software WebAuthn authenticator, for tests.
 *
 * This exists because `@simplewebauthn/server` does not ship one, and because its exports are
 * non-configurable getters -- so the verifier cannot be stubbed from outside. The two ways
 * around that were both worse than building a real authenticator:
 *
 *   * stub the verifier, which would mean adding a test-only injection seam to production
 *     code, on a path whose entire job is to not accept a forged assertion; or
 *   * hand-written fixtures, which only prove the library accepts bytes someone else wrote.
 *
 * Instead this performs the same steps a phone does: it holds a real P-256 private key, builds
 * the authenticator data and client data the spec describes, and signs with
 * `node:crypto`. The library then verifies a genuine signature. A test that passes here means
 * the whole path works, not that a mock was shaped correctly.
 *
 * The CBOR below is a hand-rolled encoder for the one shape `none` attestation needs: a map
 * with a text key, a nested empty map, and a byte string. That is deliberately the whole
 * encoder -- a general one would be untested code standing between a test and a result.
 */

'use strict';

const { createHash, generateKeyPairSync, randomBytes, sign } = require('node:crypto');
const simplewebauthn = require('@simplewebauthn/server');

const ORIGIN = 'https://rewardzone.test';
const RP_ID = 'rewardzone.test';

/** The AAGUID: 16 zero bytes, since this authenticator names no model. */
const AAGUID = Buffer.alloc(16);

/** SHA-256, as WebAuthn uses it everywhere. */
function sha256(buffer) {
    return createHash('sha256').update(buffer).digest();
}

/** Minimal CBOR: the subset a `none`-attestation object needs. */
function cbor(value) {
    if (typeof value === 'number') return cborInteger(value);
    if (typeof value === 'string') {
        const bytes = Buffer.from(value, 'utf8');
        return Buffer.concat([Buffer.from([0x60 | bytes.length]), bytes]);
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const bytes = Buffer.from(value);
        if (bytes.length < 24) return Buffer.concat([Buffer.from([0x40 | bytes.length]), bytes]);
        if (bytes.length < 256) return Buffer.concat([Buffer.from([0x58, bytes.length]), bytes]);
        // A 16-bit length. Signature counters are 32-bit in principle but never approach
        // that, and a public key coordinate is 32 bytes, so this is the widest form needed.
        return Buffer.concat([Buffer.from([0x59, bytes.length >> 8, bytes.length & 0xff]), bytes]);
    }
    if (Array.isArray(value)) {
        return Buffer.concat([Buffer.from([0x80 | value.length]), ...value.map(cbor)]);
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        const head = entries.length < 24 ? Buffer.from([0xa0 | entries.length]) : Buffer.from([0xb8, entries.length]);
        return Buffer.concat([head, ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)])]);
    }
    return Buffer.from([0xf6]); // null
}

/**
 * CBOR integers, in all three widths.
 *
 * A COSE key is mostly numbers -- key type, algorithm, curve -- so an encoder that omitted
 * them produced a map full of nulls and a decoder that reported "No data" with no hint as to
 * why. Everything numeric that reaches `cbor()` lands here.
 */
function cborInteger(value) {
    if (!Number.isInteger(value)) throw new TypeError(`CBOR integer expected, got ${value}`);
    if (value >= 0) {
        if (value < 24) return Buffer.from([value]);
        if (value < 256) return Buffer.from([0x18, value]);
        return Buffer.from([0x19, value >> 8, value & 0xff]);
    }
    // Major type 1 stores the value as -1 minus the encoded magnitude, so -7 (ES256) is
    // written as 6. Getting this backwards produces a key whose algorithm field is
    // meaningless, and the failure surfaces as an unsupported key type.
    const magnitude = -1 - value;
    if (magnitude < 24) return Buffer.from([0x20 | magnitude]);
    if (magnitude < 256) return Buffer.from([0x38, magnitude]);
    return Buffer.from([0x39, magnitude >> 8, magnitude & 0xff]);
}

/** base64url, which is the wire format and also what the library consumes. */
function b64url(buffer) {
    return Buffer.from(buffer).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function clientDataJSON(type, challenge, origin) {
    return Buffer.from(JSON.stringify({
        type,
        challenge,
        origin,
        crossOrigin: false
    }), 'utf8');
}

/**
 * The authenticator data blob.
 *
 * `flags` is a single byte whose bits are: bit 0 user present, bit 2 user verified, bit 6
 * attested credential data included. The library reads the user-verified bit and will refuse
 * a response without it, because this code asks for `userVerification: 'required'` and a
 * passkey that does not verify the user is weaker than the password it replaces.
 *
 * `attestedCredentialData` is the raw credential id, the 16-byte credential public key, and
 * its 4-byte little-endian signature counter.
 */
function authenticatorData(counter, { includeAttested, credentialId, cosePublicKey, rpId }) {
    const rpIdHash = sha256(Buffer.from(rpId, 'utf8'));

    let flags = 0x01; // user present
    flags |= 0x04;    // user verified

    const parts = [rpIdHash, Buffer.from([flags])];
    const counterBytes = Buffer.alloc(4);
    // Big-endian, per the spec. `writeUInt32LE` is the habit, and a counter of 0 hides the
    // mistake because both encodings are four zero bytes -- it only shows up once the
    // authenticator has signed a few times.
    counterBytes.writeUInt32BE(counter, 0);
    parts.push(counterBytes);

    if (includeAttested) {
        flags |= 0x40; // attested credential data included
        parts[1] = Buffer.from([flags]);
        // The AAGUID, which identifies the *model* of authenticator. It is 16 bytes and comes
        // before the credential id length -- and leaving it out is a genuinely nasty omission
        // to debug, because every field after it is then read 16 bytes early. The credential
        // id length is read out of the middle of the public key, the id comes out as
        // garbage, and the CBOR decoder eventually runs off the end of the buffer and reports
        // "No data" with no hint that a 16-byte field went missing.
        //
        // All zeros is what a virtual authenticator with no model to name reports, and it is
        // what a platform authenticator sends under `none` attestation.
        parts.push(AAGUID);
        const idLength = Buffer.alloc(2);
        // Big-endian, like the counter. Writing this little-endian is the single most
        // effective way to make an authenticator unusable: the verifier reads a length of
        // 8192 instead of 32, skips clean off the end of the buffer, and the CBOR decoder
        // reports "No data" rather than a bad credential id length.
        idLength.writeUInt16BE(credentialId.length, 0);
        parts.push(idLength, credentialId, cosePublicKey);
    }

    return Buffer.concat(parts);
}

/** The COSE_Key encoding an ES256 public key needs. A P-256 key is always 65 uncompressed bytes. */
function cosePublicKey(publicKey) {
    const raw = publicKey.export({ type: 'spki', format: 'der' });
    // The SPKI DER ends with the 65-byte uncompressed point; that is the COSE x, y.
    const point = raw.subarray(raw.length - 65);
    const x = point.subarray(1, 33);
    const y = point.subarray(33, 65);

    const bstr = (bytes) => Buffer.concat([Buffer.from([0x58, bytes.length]), bytes]);

    // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    //
    // Encoded here rather than handed to `cbor()`, because `map()` already produces finished
    // CBOR. Passing its output back through `cbor()` wraps the whole thing in an extra byte
    // string header (`58 4d ...`), and the verifier then reads a byte string where it expects
    // a map and fails with "decodedPublicKey.get is not a function" -- an error that names a
    // method on the wrong type and says nothing about the extra header.
    const head = Buffer.from([0xa0 | 5]);
    return Buffer.concat([
        head,
        Buffer.from([0x01]), cbor(2),
        Buffer.from([0x03]), cbor(-7),
        Buffer.from([0x20]), cbor(1),
        Buffer.from([0x21]), bstr(x),
        Buffer.from([0x22]), bstr(y)
    ]);
}

/**
 * An authenticator that can register a credential and then assert with it.
 *
 * `counter` is exposed and settable because the counter's behaviour under reuse and under a
 * race is one of the things worth testing, and a real authenticator refusing to re-sign at
 * the same counter is exactly the situation a cloned key produces.
 */
class VirtualAuthenticator {
    /**
     * @param origin  The origin the client data will claim. Must match what the service under
     *                test expects, which for an HTTP request is that request's own origin.
     * @param rpId    The relying party, i.e. the host part of that origin.
     */
    constructor({ origin = ORIGIN, rpId = RP_ID } = {}) {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.credentialId = randomBytes(32);
        this.counter = 0;
        this.origin = origin;
        this.rpId = rpId;
    }

    /**
     * The registration response, in the shape that crosses the wire.
     *
     * Base64url strings, not ArrayBuffers. That is what the browser posts, what
     * `passkey-shared.js` builds, and what `verifyRegistrationResponse` reads -- it decodes
     * `clientDataJSON` and `rawId` itself. Building ArrayBuffers here instead was a genuinely
     * confusing way to fail: the library's own `decodeClientDataJSON` received a buffer where
     * it wanted a string, parsed zero bytes, and reported "Unexpected end of JSON input" with
     * nothing pointing at the type mismatch.
     */
    register(challenge) {
        const authData = authenticatorData(0, {
            includeAttested: true,
            credentialId: this.credentialId,
            cosePublicKey: cosePublicKey(this.publicKey),
            rpId: this.rpId
        });
        const attestationObject = cbor({
            fmt: 'none',
            attStmt: {},
            authData
        });

        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(clientDataJSON('webauthn.create', challenge, this.origin)),
                attestationObject: b64url(attestationObject)
            },
            clientExtensionResults: {}
        };
    }

    /** The assertion response, in the same wire shape. */
    assert(challenge, { atCounter } = {}) {
        if (atCounter !== undefined) this.counter = atCounter;
        else this.counter += 1;

        const authData = authenticatorData(this.counter, { includeAttested: false, rpId: this.rpId });
        const client = clientDataJSON('webauthn.get', challenge, this.origin);
        // The signature covers the authenticator data concatenated with the SHA-256 of the
        // client data. That ordering is what stops an assertion being replayed against a
        // different origin's client data.
        const signature = sign('sha256', Buffer.concat([authData, sha256(client)]), {
            // `this.privateKey` is already a KeyObject from `generateKeyPairSync`. Re-wrapping
            // it with `createPrivateKey` is redundant and, in Node 24, an outright error.
            key: this.privateKey,
            dsaEncoding: 'der'
        });

        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(client),
                authenticatorData: b64url(authData),
                signature: b64url(signature)
            },
            clientExtensionResults: {}
        };
    }

    /** What a `passkeys` row would hold for this authenticator. */
    stored() {
        return {
            credential_id: this.credentialIdBase64,
            public_key: this.storedPublicKey,
            counter: this.counter,
            transports: 'internal',
            device_type: 'singleDevice'
        };
    }

    /**
     * The COSE key as the library's verifier would have re-serialised it.
     *
     * Computed by verifying a registration rather than by re-encoding locally, on purpose:
     * the stored value has to be byte-identical to what `verifyRegistrationResponse` hands
     * back, because the service stores and replays it unchanged. A test that re-encoded the
     * key itself would be testing its own encoder, and any difference would show up as an
     * assertion that inexplicably fails to verify.
     */
    async primeVerification() {
        const options = await simplewebauthn.generateRegistrationOptions({
            rpName: 'RewardZone',
            rpID: this.rpId,
            userID: Buffer.from('1'),
            userName: 'ada@example.com',
            userDisplayName: 'Ada',
            attestationType: 'none',
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
        });
        const verified = await simplewebauthn.verifyRegistrationResponse({
            response: this.register(options.challenge),
            expectedChallenge: options.challenge,
            expectedOrigin: this.origin,
            expectedRPID: this.rpId,
            requireUserVerification: true
        });
        this.storedPublicKey = verified.registrationInfo.credential.publicKey;
        this.credentialIdBase64 = verified.registrationInfo.credential.id;
        return verified;
    }

    /**
     * The public key as the `passkeys.public_key` column holds it.
     *
     * base64url text, because that is what the column is. The service converts in both
     * directions; `storedPublicKey` stays as the library's `Uint8Array` so nothing here has
     * to pretend to be the service.
     */
    get publicKeyColumn() {
        return Buffer.from(this.storedPublicKey).toString('base64url');
    }
}

module.exports = { VirtualAuthenticator, ORIGIN, RP_ID, b64url };
