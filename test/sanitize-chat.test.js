'use strict';

// Adversarial tests for the quick-chat sanitizer (room.js sanitizeChat) -- the only
// place a client-supplied string becomes a broadcast/rendered chat message. It shares
// cleanText() with sanitizeName, so the character-level attacks are covered by the
// name suite; what's distinct here is the cap policy: WORDS first (MAX_CHAT_WORDS),
// then code points (MAX_CHAT_LEN) so one giant unbroken "word" can't dodge the word
// cap. Goal: no input, however hostile, yields a message that is too long, has more
// than the allowed words, or carries layout-breaking/control/markup code points.

const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeChat } = require('../src/server/room.js');
const { MAX_CHAT_WORDS, MAX_CHAT_LEN } = require('../src/server/config.js');

// Mirror of the banned predicate in room.js (cleanText). Output must contain NONE.
function isBanned(cp) {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) ||        // C0 / C1 control
    cp === 0x22 || cp === 0x26 || cp === 0x27 ||            // " & '
    cp === 0x3c || cp === 0x3e || cp === 0x60 ||            // < > `
    (cp >= 0x200b && cp <= 0x200f) ||                       // zero-width + LRM / RLM
    cp === 0x2028 || cp === 0x2029 ||                       // line / paragraph separators
    (cp >= 0x202a && cp <= 0x202e) ||                       // bidi embeddings / overrides
    cp === 0x2060 || (cp >= 0x2066 && cp <= 0x2069) ||      // word joiner + bidi isolates
    cp === 0xfeff;                                          // BOM / zero-width no-break
}

// The invariants EVERY output must satisfy, regardless of input. This is the contract.
function assertSafe(out, input) {
  const tag = () => `input=${JSON.stringify(input)} out=${JSON.stringify(out)}`;
  assert.strictEqual(typeof out, 'string', `not a string: ${tag()}`);
  const cps = [...out];                                     // iterate by code point
  assert.ok(cps.length <= MAX_CHAT_LEN, `too long (${cps.length} > ${MAX_CHAT_LEN}): ${tag()}`);
  if (out !== '') {
    const words = out.split(' ');
    assert.ok(words.length <= MAX_CHAT_WORDS, `too many words (${words.length} > ${MAX_CHAT_WORDS}): ${tag()}`);
    assert.ok(words.every((w) => w !== ''), `empty word (double space?): ${tag()}`);
  }
  for (const ch of cps) {
    assert.ok(!isBanned(ch.codePointAt(0)), `banned U+${ch.codePointAt(0).toString(16)}: ${tag()}`);
  }
  // No lone UTF-16 surrogate survived the length clamp (would render as a broken glyph).
  assert.ok(!/[\ud800-\udfff]/.test(out.replace(/[\u{10000}-\u{10FFFF}]/gu, '')), `lone surrogate: ${tag()}`);
  // No Zalgo: at most one combining mark in a row, and never a leading mark.
  assert.ok(!/\p{M}{2,}/u.test(out), `combining tower: ${tag()}`);
  assert.ok(!/^\p{M}/u.test(out), `leading combining mark: ${tag()}`);
  // Whitespace normalized: trimmed, single spaces only, no raw control whitespace.
  assert.strictEqual(out, out.trim(), `untrimmed: ${tag()}`);
  assert.ok(!/\s{2,}/.test(out), `double whitespace: ${tag()}`);
  assert.ok(!/[\t\n\r\f\v]/.test(out), `raw control whitespace: ${tag()}`);
}

test('non-strings and empties -> empty string', () => {
  for (const v of [undefined, null, 42, 0, NaN, true, false, {}, [], '', '   ', '\n\t']) {
    assert.strictEqual(sanitizeChat(v), '', `value ${String(v)}`);
  }
});

test('clean short messages pass through unchanged', () => {
  for (const s of ['gg', 'nice one', 'watch the freeze portal', 'gl hf everyone']) {
    const out = sanitizeChat(s);
    assertSafe(out, s);
    assert.strictEqual(out, s, `mangled a clean message: ${s} -> ${out}`);
  }
});

test('exactly MAX_CHAT_WORDS words pass; the word after is dropped', () => {
  const atCap = Array.from({ length: MAX_CHAT_WORDS }, (_, i) => `w${i}`).join(' ');
  assert.strictEqual(sanitizeChat(atCap), atCap);
  const overCap = atCap + ' extra';
  assert.strictEqual(sanitizeChat(overCap), atCap, 'word #11 must be dropped');
  assertSafe(sanitizeChat(overCap), overCap);
});

test('word flooding is capped no matter the count', () => {
  for (const n of [MAX_CHAT_WORDS + 1, 50, 1000]) {
    const out = sanitizeChat(Array.from({ length: n }, () => 'x').join(' '));
    assertSafe(out, `${n} words`);
    assert.strictEqual(out.split(' ').length, MAX_CHAT_WORDS);
  }
});

test('whitespace runs collapse BEFORE the word count (no smuggling via exotic spaces)', () => {
  // 5 real words padded with space runs + a Unicode space must still count as 5
  // words. Control "whitespace" (\t \n \r) is a BANNED code point, stripped before
  // the collapse -- so it merges its neighbors instead of separating them (same
  // contract as the name sanitizer); 'c\r\nd' below is one word, by design.
  const out = sanitizeChat('  a   b 　 c     d  e  ');
  assertSafe(out, 'whitespace-padded');
  assert.strictEqual(out, 'a b c d e');
  assert.strictEqual(sanitizeChat('c\r\nd'), 'cd', 'control ws strips, not separates');
});

test('one giant unbroken word is clamped by code points', () => {
  const out = sanitizeChat('a'.repeat(500));
  assertSafe(out, 'a x500');
  assert.strictEqual([...out].length, MAX_CHAT_LEN);
});

test('code-point clamp counts by code point; emoji never split into surrogates', () => {
  const out = sanitizeChat('😀'.repeat(500));
  assertSafe(out, 'emoji flood');
  assert.strictEqual([...out].length, MAX_CHAT_LEN);
});

test('HTML / injection characters are stripped', () => {
  for (const a of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a"b\'c`d', 'Bob & Co says hi']) {
    const out = sanitizeChat(a);
    assertSafe(out, a);
    for (const c of ['<', '>', '&', '"', "'", '`']) assert.ok(!out.includes(c), `kept ${c} from ${a}`);
  }
});

test('bidi / zero-width / control sweeps stay safe under chat caps', () => {
  let controls = '';
  for (let cp = 0; cp <= 0x9f; cp++) controls += String.fromCodePoint(cp);
  const hostiles = [
    'Z' + controls + 'Z',
    'a‮kcatta‬ b',                       // RLO reorder attempt
    'a​‌‍﻿b c',                // zero-width stuffing
    'q́̂̃̄ zalgo tower',       // mark stack
    ('é '.repeat(40)),                       // many accented words
  ];
  for (const h of hostiles) assertSafe(sanitizeChat(h), h);
});

test('multi-megabyte paste/scripted payloads are gated BEFORE normalization', () => {
  // The raw prefix cut (MAX_RAW_TEXT_UNITS) must keep the sanitizer effectively
  // O(1): a multi-MB string may not cost multi-MB of NFC/strip work.
  const big = 'word '.repeat(500000) + '<script>'.repeat(100000);   // ~3.3M units
  const t0 = process.hrtime.bigint();
  const out = sanitizeChat(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assertSafe(out, '3.3MB payload');
  assert.strictEqual(out.split(' ').length, MAX_CHAT_WORDS);
  assert.ok(ms < 50, `sanitize took ${ms.toFixed(1)}ms -- raw gate not working?`);
});

test('raw prefix cut never strands a lone surrogate at the boundary', () => {
  // Position an astral char so the 400-unit cut lands mid-surrogate-pair; the
  // gate must back off a unit rather than admit half a pair into the pipeline.
  for (const lead of [399, 398]) {
    const input = 'a'.repeat(lead) + '\u{1F600}'.repeat(300);
    assertSafe(sanitizeChat(input), `boundary lead=${lead}`);
  }
  // All-zero-width flood + trailing pair half: nothing printable may survive as
  // a broken glyph either.
  assertSafe(sanitizeChat('​'.repeat(399) + '\u{1F600}'.repeat(10)), 'zw flood boundary');
});

test('banned-char stripping cannot merge words past the cap', () => {
  // Words separated by banned chars collapse into neighbors -- output must still
  // respect both caps whatever the merge produces.
  const tricky = Array.from({ length: 30 }, (_, i) => `w${i}​`).join(' ');
  assertSafe(sanitizeChat(tricky), 'zero-width word merge');
});
