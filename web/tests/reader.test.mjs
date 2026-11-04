import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const output = ts.transpileModule(fs.readFileSync(new URL('../src/utils/reader.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const { readerImageUrl, createReaderPrefetcher } = new Function('exports', `${output}\nreturn exports`)({})
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

test('reader modes preserve URL identity and select only server-side transformations', () => {
  assert.equal(readerImageUrl('/media/1?token=x#page', 'eink'), '/media/1?token=x&variant=reader-lite-mono#page')
  assert.equal(readerImageUrl('/media/1?variant=reader-lite', 'original'), '/media/1')
  assert.equal(readerImageUrl('/media/1', 'balanced'), '/media/1?variant=reader-balanced')
  assert.equal(readerImageUrl('https://example.test/media/1', 'lite'), 'https://example.test/media/1?variant=reader-lite')
})

test('rapid 30-page jumps keep one request active and close cancels the remaining request', async () => {
  const calls = []
  let active = 0
  let peak = 0
  const prefetch = createReaderPrefetcher((_url, { signal }) => new Promise((_resolve, reject) => {
    calls.push(signal)
    peak = Math.max(peak, ++active)
    signal.addEventListener('abort', () => { --active; reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
  }))
  prefetch.update(['/page/1', '/page/2'])
  for (let index = 2; index <= 30; index++) prefetch.update([`/page/${index}`, `/page/${index + 1}`])
  await flush()
  assert.equal(peak, 1)
  assert.equal(active, 1)
  assert.equal(calls.length, 2)
  prefetch.clear()
  await flush()
  assert.equal(active, 0)
  assert.ok(calls.every((signal) => signal.aborted))
})

test('lookahead drains streams sequentially and caps the retained window at two URLs', async () => {
  const calls = []
  let drained = 0
  const prefetch = createReaderPrefetcher(async (url) => {
    calls.push(url)
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32)); controller.close(); drained++ } }))
  })
  prefetch.update(['/a', '/b', '/c'])
  await flush()
  assert.deepEqual(calls, ['/a', '/b'])
  assert.equal(drained, 2)
  prefetch.update(['/a', '/b'])
  await flush()
  assert.equal(calls.length, 2)
  prefetch.clear()
})
