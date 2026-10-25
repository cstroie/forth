'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Forth, EXAMPLES } = require('../forth.js');

function memoryStorage() {
    const m = new Map();
    return { get: k => m.get(k) ?? null, set: (k, v) => (m.set(k, v), true), remove: k => m.delete(k), keys: () => [...m.keys()] };
}

/** A Forth whose output is collected in `f.log`. */
function make(storage = memoryStorage()) {
    const f = new Forth((text, kind) => { f.log += kind === 'cls' ? '' : text; }, storage);
    f.log = '';
    return f;
}

/** Run lines and return the output of the last one, without " ok". */
function run(lines, f = make()) {
    let out = '';
    for (const line of [].concat(lines)) {
        const start = f.log.length;
        f.enter(line);
        for (let i = 0; f.runSlice(200) === 'running'; i++) {
            if (i > 50) { f.interrupt(); break; }
        }
        out = f.log.slice(start);
    }
    return out.replace(/\s*(ok|compiled)\n$/, '').trim();
}

test('arithmetic', () => {
    assert.equal(run('2 3 + .'), '5');
    assert.equal(run('-7 2 / . -7 2 mod .'), '-4 1');
    assert.equal(run('7 3 /mod . .'), '2 1');
    assert.equal(run('10 3 4 */ .'), '7');
    assert.equal(run('2147483647 1 + .'), '-2147483648');
});

test('stack words', () => {
    assert.equal(run('1 2 3 rot .s'), '<3> 2 3 1');
    assert.equal(run('1 2 3 -rot .s'), '<3> 3 1 2');
    assert.equal(run('1 2 3 2 pick .s'), '<4> 1 2 3 1');
    assert.equal(run('1 2 3 2 roll .s'), '<3> 2 3 1');
    assert.equal(run('1 2 nip 3 tuck .s'), '<3> 3 2 3');
});

test('flags are -1 and 0; invert is bitwise', () => {
    assert.equal(run('3 4 < . 3 4 > .'), '-1 0');
    assert.equal(run('5 invert .'), '-6');
});

test('multiple spaces between words', () => {
    assert.equal(run('10   20    + .'), '30');
});

test('number bases and prefixes', () => {
    assert.equal(run('hex ff . decimal $ff . %101 . \'A\' .'), 'FF 255 5 65');
});

test('colon definitions and see', () => {
    const f = make();
    run(': sq dup * ;', f);
    assert.equal(run('5 sq .', f), '25');
    assert.equal(run('see sq', f), ': sq dup * ;');
});

test('definitions spanning several lines', () => {
    const f = make();
    run([': twice', 'dup +', ';'], f);
    assert.equal(run('4 twice .', f), '8');
});

test('redefinition keeps old callers', () => {
    assert.equal(run(': f 1 + ; : f f f ; 1 f .'), '3');
});

test('if else then', () => {
    const f = make();
    run(': sign 0> if ." pos" else ." nonpos" then ;', f);
    assert.equal(run('5 sign -1 sign', f), 'posnonpos');
});

test('do loop, nested loops, leave, +loop', () => {
    assert.equal(run(': t 3 0 do i . loop ; t'), '0 1 2');
    assert.equal(run(': t 2 0 do 2 0 do j . i . loop loop ; t'), '0 0 0 1 1 0 1 1');
    assert.equal(run(': t 10 0 do i 5 = if leave then i . loop ; t'), '0 1 2 3 4');
    assert.equal(run(': t 10 0 do i . 3 +loop ; t'), '0 3 6 9');
    assert.equal(run(': t 0 10 do i . -2 +loop ; t'), '10 8 6 4 2 0');
    assert.equal(run(': t 0 0 ?do ." x" loop ." done" ; t'), 'done');
});

test('begin until and begin while repeat', () => {
    assert.equal(run(': t begin dup . 1- dup 0= until drop ; 3 t'), '3 2 1');
    assert.equal(run(': t begin dup while dup . 1- repeat drop ; 3 t'), '3 2 1');
});

test('recursion', () => {
    assert.equal(run(': fact dup 1 > if dup 1- recurse * else drop 1 then ; 10 fact .'), '3628800');
});

test('variables, constants, values', () => {
    assert.equal(run('variable v 5 v ! 3 v +! v @ .'), '8');
    assert.equal(run('42 constant k k .'), '42');
    assert.equal(run('10 value w 20 to w w . : set 99 to w ; set w .'), '20 99');
});

test('create allot does>', () => {
    assert.equal(run(': arr create cells allot does> swap cells + ; 5 arr a 7 3 a ! 3 a @ .'), '7');
});

test('strings, chars and comments', () => {
    assert.equal(run('." hello world"'), 'hello world');
    assert.equal(run('s" abc" type'), 'abc');
    assert.equal(run('char A emit : b [char] B emit ; b'), 'AB');
    assert.equal(run('( ignored ) 1 . \\ also ignored'), '1');
});

test("' and execute", () => {
    assert.equal(run(": sq dup * ; ' sq 6 swap execute ."), '36');
});

test('errors reset the stacks', () => {
    const f = make();
    assert.match(run('1 2 foo', f), /foo \? undefined word/);
    assert.equal(run('depth .', f), '0');
    assert.match(run('drop', f), /stack underflow/);
    assert.match(run(': z 1 0 / ; z', f), /division by zero/);
    assert.match(run(': deep recurse ; deep', f), /return stack overflow/);
});

test('an endless loop can be interrupted', () => {
    const f = make();
    run(': forever begin again ;', f);
    f.enter('forever');
    assert.equal(f.runSlice(5), 'running');
    f.interrupt();
    assert.equal(f.state, 'idle');
    assert.equal(run('1 .', f), '1');
});

test('save, cold, load', () => {
    const storage = memoryStorage();
    const f = make(storage);
    run([': sq dup * ;', 'save demo', 'cold'], f);
    assert.match(run('5 sq', f), /undefined word/);
    run('load demo', f);
    assert.equal(run('5 sq .', f), '25');
});

test('programs saved by the original jsforth still load', () => {
    const storage = memoryStorage();
    storage.set('jsforth_program_old', JSON.stringify({ stack: [], definitions: { plus: '+' } }));
    const f = make(storage);
    run('load old', f);
    assert.equal(run('3 4 plus .', f), '7');
});

test('every example runs without error', () => {
    for (const [id, ex] of Object.entries(EXAMPLES)) {
        const f = make();
        run(ex.src.split('\n'), f);
        const out = run(ex.try, f);
        assert.ok(!/Error/.test(f.log), `${id} failed:\n${f.log}`);
        assert.ok(out.length > 0, `${id} printed nothing`);
    }
});

test('Towers of Hanoi makes 2^n - 1 moves', () => {
    const f = make();
    run(EXAMPLES.hanoi.src.split('\n'), f);
    run('0 moves ! 5 1 3 2 hanoi', f);
    assert.equal(run('moves ?', f), '31');
});
