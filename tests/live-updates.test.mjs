import test from 'node:test';
import assert from 'node:assert/strict';

import { createAcceptValue, decodeFrames, encodeFrame } from '../server/live-updates.mjs';

test('createAcceptValue matches websocket handshake example', () => {
  assert.equal(
    createAcceptValue('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  );
});

test('encodeFrame and decodeFrames roundtrip ping payloads', () => {
  const frame = encodeFrame(0x9, Buffer.from('ping'));
  const decoded = decodeFrames(frame);
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].opcode, 0x9);
  assert.equal(decoded.frames[0].payload.toString('utf8'), 'ping');
});

test('decodeFrames rejects frames larger than the configured resource limit', () => {
  const frame = encodeFrame(0x1, Buffer.alloc(1025));
  assert.throws(() => decodeFrames(frame, { maxFrameBytes: 1024 }), /too large/i);
});
