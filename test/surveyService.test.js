const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/config/db');
const { readOptions, answersAreValid, sanitiseAnswers, MAX_OPTIONS_PER_QUESTION } =
    require('../src/services/surveyService');

/**
 * The survey's questions moved from two hardcoded copies -- a literal array in the page
 * script and two `Set`s in the controller -- into the database. These cover the rules that
 * replace that: a malformed row must not become an unusable page, and an answer must be one
 * the question actually offered.
 */

test('a malformed option list is repaired by dropping it, not by inventing a value', () => {
    // Well-formed options pass through unchanged.
    assert.deepEqual(
        readOptions([{ value: 'games', label: 'Games' }, { value: 'daily', label: 'Daily' }]),
        [{ value: 'games', label: 'Games' }, { value: 'daily', label: 'Daily' }]
    );

    // An option with no value cannot be selected and cannot be matched on submit, so it is
    // dropped. Repairing it with an index would store an answer the user never chose.
    assert.deepEqual(
        readOptions([{ label: 'Games' }, { value: 'daily', label: 'Daily' }]),
        [{ value: 'daily', label: 'Daily' }]
    );

    // A label with no value is equally unusable.
    assert.deepEqual(readOptions([{ value: 'games' }]), []);

    // A non-array is not a list of options, whatever it contains.
    assert.deepEqual(readOptions({ value: 'games' }), []);
    assert.deepEqual(readOptions(null), []);
    assert.deepEqual(readOptions([null, 'nope', 7]), []);

    // Whitespace is trimmed so a value typed with padding still matches, and an all-whitespace
    // value is no value at all.
    assert.deepEqual(readOptions([{ value: '  games  ', label: ' Games ' }]), [
        { value: 'games', label: 'Games' }
    ]);
    assert.deepEqual(readOptions([{ value: '   ', label: 'Games' }]), []);

    // The option count is bounded so a bad row cannot produce a page with hundreds of radios.
    const many = Array.from({ length: 40 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    assert.equal(readOptions(many).length, MAX_OPTIONS_PER_QUESTION);
});

/** A survey stubbed as a set of questions, so these rules are tested without a database. */
function survey(...questions) {
    return questions;
}

test('an answer has to be one the question actually offered', async () => {
    const questions = survey(
        { key: 'favorite', required: true, options: [{ value: 'games' }, { value: 'shopping' }] },
        { key: 'frequency', required: true, options: [{ value: 'daily' }] }
    );

    assert.equal(await answersAreValid({ favorite: 'games', frequency: 'daily' }, questions), true);

    // A value from a different question's option list is refused. This is the drift the
    // move to the database exists to remove: the page can no longer offer an answer the
    // server will not take.
    assert.equal(await answersAreValid({ favorite: 'daily', frequency: 'daily' }, questions), false);

    // A missing required answer is a refusal, not a default.
    assert.equal(await answersAreValid({ favorite: 'games' }, questions), false);
    assert.equal(await answersAreValid({ favorite: 'games', frequency: '' }, questions), false);
    assert.equal(await answersAreValid({ frequency: 'daily' }, questions), false);

    // An unrecognised key does not invalidate the answers, because the page is not wrong to
    // send one -- the record is what must be trimmed, and `sanitiseAnswers` does that. So
    // validity ignores extras rather than refusing them, and only the stored payload is
    // narrowed to the questions that were asked.
    assert.equal(
        await answersAreValid({ favorite: 'games', frequency: 'daily', removed: 'x' }, questions),
        true
    );

    // An optional question may be skipped; a required one may not.
    const optional = survey({ key: 'age', required: false, options: [{ value: '18' }] });
    assert.equal(await answersAreValid({}, optional), true);
    assert.equal(await answersAreValid({ age: '18' }, optional), true);
    assert.equal(await answersAreValid({ age: '99' }, optional), false);

    // An empty survey cannot be answered, and a non-object is not an answer set.
    assert.equal(await answersAreValid({ a: 'b' }, survey()), false);
    assert.equal(await answersAreValid(null, questions), false);
    assert.equal(await answersAreValid(['games'], questions), false);
});

test('only the questions that were asked are stored', () => {
    const questions = survey(
        { key: 'favorite', required: true, options: [{ value: 'games' }] },
        { key: 'frequency', required: true, options: [{ value: 'daily' }] }
    );

    // An unrecognised key is dropped rather than written into the recorded response as
    // though it were an answer to a question that never existed.
    assert.deepEqual(
        sanitiseAnswers({ favorite: 'games', frequency: 'daily', injected: 'x' }, questions),
        { favorite: 'games', frequency: 'daily' }
    );

    // Values that are not strings are not answers, and are dropped too.
    assert.deepEqual(
        sanitiseAnswers({ favorite: 'games', frequency: { toString: () => 'daily' } }, questions),
        { favorite: 'games' }
    );
});
