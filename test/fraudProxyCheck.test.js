const test = require('node:test');
const assert = require('node:assert/strict');

const { isPubliclyRoutableAddress } = require('../src/middlewares/fraudDetection');

/**
 * Why a local click was answered "Fraud checks are temporarily unavailable."
 *
 * proxycheck.io has no verdict for a private, loopback, link-local or reserved address, and it
 * does not say so politely. It rejects them as malformed input:
 *
 *     GET https://proxycheck.io/v2/127.0.0.1?key=...
 *     -> {"status":"error","message":"No valid IP Addresses supplied."}
 *
 * That is a refusal to answer, not an answer, and the middleware's `checkProxyVerdict` folds it
 * into `verdict: 'unknown'` alongside a quota exhaustion and an invalid key. With
 * `PROXYCHECK_REQUIRED=true` every one of those becomes a 503, so the catalog was down for
 * anyone whose `req.ip` was not a public address -- which is every local developer, every
 * container on a private network, and any deployment where `trust proxy` leaves the address as
 * the proxy's own.
 *
 * The fix is to recognise that there is nothing to look up. No VPN hides behind `127.0.0.1`.
 * The velocity check still runs, so this skips the one control that cannot produce a result,
 * rather than skipping the middleware.
 */

test('a loopback address is not treated as checkable', () => {
    // The case that produced the report. `req.ip` on a local Express server is this, after
    // `normaliseAddress` has stripped the IPv4-mapped IPv6 form.
    assert.equal(isPubliclyRoutableAddress('127.0.0.1'), false);
    assert.equal(isPubliclyRoutableAddress('::ffff:127.0.0.1'), false);
    assert.equal(isPubliclyRoutableAddress('::1'), false);
    assert.equal(isPubliclyRoutableAddress('0.0.0.0'), false);
});

test('a private-network address is not treated as checkable', () => {
    for (const address of [
        '10.0.0.1',
        '10.255.255.254',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.1.5',
        '169.254.1.1',
        '100.64.0.1',
    ]) {
        assert.equal(isPubliclyRoutableAddress(address), false, `${address} was treated as public`);
    }
});

test('a reserved or multicast address is not treated as checkable', () => {
    // 224.0.0.0/4 is multicast, 240.0.0.0/4 is reserved for future use, and 255.255.255.255
    // is the broadcast address. None of them can be a client.
    for (const address of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
        assert.equal(isPubliclyRoutableAddress(address), false, `${address} was treated as public`);
    }
});

test('an IPv6 private range is not treated as checkable', () => {
    // fc00::/7 is unique-local and fe80::/10 is link-local. Both are private; the second is
    // matched explicitly because its leading byte overlaps the first range's pattern.
    assert.equal(isPubliclyRoutableAddress('fc00::1'), false);
    assert.equal(isPubliclyRoutableAddress('fd12:3456:789a::1'), false);
    assert.equal(isPubliclyRoutableAddress('fe80::1'), false);
    assert.equal(isPubliclyRoutableAddress('::'), false);
});

test('a public address is still checkable', () => {
    // The other half of the contract. If this ever returned false, the proxy control would be
    // silently dead in production while every test still passed.
    for (const address of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
        assert.equal(isPubliclyRoutableAddress(address), true, `${address} was treated as private`);
    }
});

test('172.32.0.0 is public, because the private range stops at 172.31', () => {
    // The private block is 172.16.0.0/12, which ends at 172.31.255.255. A prefix test that
    // stopped at "172." would take a public address out of the check.
    assert.equal(isPubliclyRoutableAddress('172.32.0.1'), true);
    assert.equal(isPubliclyRoutableAddress('172.15.0.1'), true);
});

test('a value that is not an address at all is not sent to the provider', () => {
    // `req.ip` is undefined when no proxy reports one and the socket has no peer address. The
    // middleware already handles that with its own guard, but a hostname must not reach the
    // provider either -- it is not malformed input the provider can answer.
    assert.equal(isPubliclyRoutableAddress('example.com'), false);
    assert.equal(isPubliclyRoutableAddress('localhost'), false);
    assert.equal(isPubliclyRoutableAddress(''), false);
    assert.equal(isPubliclyRoutableAddress(null), false);
    assert.equal(isPubliclyRoutableAddress(undefined), false);
});
