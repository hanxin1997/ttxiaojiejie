import assert from 'node:assert/strict'
import test from 'node:test'
import { routeAssets } from '../scripts/bundle-graph.mjs'

test('route budgets include transitive imports and shared CSS exactly once', () => {
  const manifest = {
    'index.html': { file: 'shell.js', css: ['shell.css'], imports: ['shared'], dynamicImports: ['optional'] },
    library: { file: 'library.js', imports: ['shared', 'nested'] },
    detail: { file: 'detail.js', imports: ['nested'] },
    nested: { file: 'nested.js', css: ['shared.css'], imports: ['shared'] },
    shared: { file: 'shared.js', css: ['shared.css'] },
    optional: { file: 'settings.js' },
  }
  assert.deepEqual([...routeAssets(manifest, 'library')].sort(), ['library.js', 'nested.js', 'shared.css', 'shared.js', 'shell.css', 'shell.js'])
  assert.ok(routeAssets(manifest, 'detail').has('nested.js'))
  assert.throws(() => routeAssets(manifest, 'missing'), /Missing manifest/)
})
