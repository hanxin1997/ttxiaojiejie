import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeAssets } from './bundle-graph.mjs'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.resolve(webRoot, '..', 'public')
const maximumChunkBytes = 900 * 1024
const maximumRouteBytes = 1200 * 1024

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(target)))
    else files.push(target)
  }
  return files
}

const files = await walk(outputRoot)
const assets = []
for (const file of files.filter((item) => /\.(?:js|css)$/.test(item))) {
  const stats = await fs.stat(file)
  assets.push({ file, size: stats.size })
  if (stats.size > maximumChunkBytes) {
    throw new Error(`${path.relative(outputRoot, file)} is ${stats.size} bytes; chunk budget is ${maximumChunkBytes}`)
  }
}

const manifest = JSON.parse(await fs.readFile(path.join(outputRoot, '.vite/manifest.json'), 'utf8'))
const routeBytes = {}
for (const [name, key] of Object.entries({ library: 'src/components/LibraryPanel.vue', detail: 'src/components/DetailPanel.vue' })) {
  const dependencies = routeAssets(manifest, key)
  let bytes = 0
  for (const file of dependencies) bytes += (await fs.stat(path.join(outputRoot, file))).size
  routeBytes[name] = bytes
  if (bytes > maximumRouteBytes) throw new Error(`${name} route is ${bytes} bytes; budget is ${maximumRouteBytes}`)
}

console.log(JSON.stringify({ routeBytes, maximumRouteBytes, maximumChunkBytes, assetCount: assets.length }))
