import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.resolve(webRoot, '..', 'public')
const maximumChunkBytes = 900 * 1024
const maximumInitialBytes = 1200 * 1024

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

const indexHtml = await fs.readFile(path.join(outputRoot, 'index.html'), 'utf8')
const initialNames = [...indexHtml.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map((match) => match[1])
const initialBytes = assets
  .filter((asset) => initialNames.includes(path.relative(outputRoot, asset.file).replaceAll('\\', '/')))
  .reduce((sum, asset) => sum + asset.size, 0)

if (initialBytes > maximumInitialBytes) {
  throw new Error(`Initial route is ${initialBytes} bytes; budget is ${maximumInitialBytes}`)
}

console.log(JSON.stringify({ initialBytes, maximumInitialBytes, maximumChunkBytes, assetCount: assets.length }))
