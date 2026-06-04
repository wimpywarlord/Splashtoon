'use strict';

// Bot round-end quips (bot-ai.js) are broadcast through the SAME {t:'chat'}
// surface as human messages, but they bypass sanitizeChat (server-authored, not
// client input). These tests pin the contract that makes that safe: every pool
// line must already BE a fixed point of the sanitizer -- within the word/length
// caps and free of banned characters -- so a quip can never render anything a
// sanitized human message could not.

const { test } = require('node:test');
const assert = require('node:assert');
const { pickQuip, QUIPS_WON, QUIPS_LOST } = require('../src/server/bot-ai.js');
const { sanitizeChat } = require('../src/server/room.js');
const { MAX_CHAT_WORDS, MAX_CHAT_LEN } = require('../src/server/config.js');

test('every quip is a fixed point of sanitizeChat (caps + banned chars)', () => {
  for (const q of [...QUIPS_WON, ...QUIPS_LOST]) {
    assert.strictEqual(sanitizeChat(q), q, `quip would be mutated by the sanitizer: ${JSON.stringify(q)}`);
    assert.ok(q.split(' ').length <= MAX_CHAT_WORDS, `too many words: ${q}`);
    assert.ok([...q].length <= MAX_CHAT_LEN, `too long: ${q}`);
  }
});

test('pickQuip draws from the matching mood pool', () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(QUIPS_WON.includes(pickQuip(true, null)), 'won quip outside pool');
    assert.ok(QUIPS_LOST.includes(pickQuip(false, null)), 'lost quip outside pool');
  }
});

test('pickQuip never returns the avoided (previous) line', () => {
  for (const pool of [QUIPS_WON, QUIPS_LOST]) {
    for (const avoid of pool) {
      for (let i = 0; i < 50; i++) {
        const q = pickQuip(pool === QUIPS_WON, avoid);
        assert.notStrictEqual(q, avoid, `repeated the avoided quip: ${avoid}`);
        assert.ok(q !== '', 'pool large enough that avoid never empties it');
      }
    }
  }
});
