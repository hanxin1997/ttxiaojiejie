import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

// Run the actual TypeScript implementation without a browser or an installed test framework.
function load(relativePath, modules = {}, suffix = '') {
  let source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  if (relativePath.endsWith('.vue')) source = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  return new Function('require', 'exports', 'localStorage', `${output}\n${suffix || 'return exports'}`)(
    (name) => modules[name] ?? {}, exports, { getItem: () => null },
  )
}

const vue = { reactive: (value) => value, readonly: (value) => value, ref: (value) => ({ value }), computed: (fn) => ({ get value() { return fn() } }), watch() {}, onUnmounted() {} }
function app(api) {
  return load('../src/composables/useAppState.ts', { vue, '../api': { api }, '../router': { router: { push: async () => {} } } }).useAppState()
}

test('a newer detail request aborts the old response body after headers arrive', async () => {
  const originalFetch = globalThis.fetch
  const body = deferred()
  let signal
  let calls = 0
  globalThis.fetch = async (_url, options) => {
    if (++calls > 1) return { ok: true, json: async () => ({ id: 'B' }) }
    signal = options.signal
    return { ok: true, json: () => body.promise }
  }
  try {
    const { api } = load('../src/api/index.ts')
    const first = api.getSeriesDetail('A')
    await Promise.resolve()
    await api.getSeriesDetail('B')
    assert.equal(signal.aborted, true)
    body.resolve({ id: 'A' })
    await first
  } finally { body.resolve({ id: 'A' }); globalThis.fetch = originalFetch }
})

test('an aborted background refresh cannot clear a newly navigated detail', async () => {
  const old = deferred()
  const stateApi = app({ getSeriesDetail: (id) => id === 'A' ? old.promise : Promise.resolve({ id: 'B' }) })
  stateApi.state.activeSeriesId = 'A'
  stateApi.state.activeSeries = { id: 'A' }
  const refresh = stateApi.restoreActiveDetail()
  await stateApi.loadSeriesDetail('B')
  old.reject(new DOMException('Cancelled', 'AbortError'))
  await refresh
  assert.equal(stateApi.state.activeSeriesId, 'B')
  assert.equal(stateApi.state.activeSeries.id, 'B')
  assert.equal(stateApi.state.loadingDetail, false)
})

test('same-series refreshes commit only their newest generation', async () => {
  const old = deferred()
  let calls = 0
  const stateApi = app({ getSeriesDetail: () => ++calls === 1 ? old.promise : Promise.resolve({ id: 'A', title: 'new' }) })
  stateApi.state.activeSeriesId = 'A'
  const refresh = stateApi.restoreActiveDetail()
  await stateApi.loadSeriesDetail('A')
  old.resolve({ id: 'A', title: 'stale' })
  await refresh
  assert.equal(stateApi.state.activeSeries.title, 'new')
})

test('metadata and recommendations cannot commit after switching series', async () => {
  const oldMeta = deferred()
  const oldRecommendations = deferred()
  const state = { activeSeriesId: 'A', activeSeries: { id: 'A' } }
  const component = load('../src/components/DetailPanel.vue', {
    vue, 'naive-ui': { useMessage: () => ({}) },
    '../api': { api: { getSeriesMetadata: () => oldMeta.promise, getSeriesRecommendations: () => oldRecommendations.promise } },
    '../composables/useAppState': { useAppState: () => ({ state }) },
  }, 'return { loadMetadataEditor, loadRecommendations, metaTitle, recommendations }')
  const pending = [component.loadMetadataEditor('A'), component.loadRecommendations('A')]
  state.activeSeriesId = 'B'
  state.activeSeries = { id: 'B' }
  oldMeta.resolve({ override: { title: 'A title' } })
  oldRecommendations.resolve({ items: [{ series: { id: 'A-related' } }] })
  await Promise.all(pending)
  assert.equal(component.metaTitle.value, '')
  assert.deepEqual(component.recommendations.value, [])
})
