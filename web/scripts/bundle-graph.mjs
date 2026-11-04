/** Route cost includes the shell and every static JS/CSS dependency, counted once. */
export function routeAssets(manifest, routeKey) {
  const assets = new Set()
  const visited = new Set()
  function visit(key) {
    if (visited.has(key)) return
    visited.add(key)
    const chunk = manifest[key]
    if (!chunk) throw new Error(`Missing manifest entry: ${key}`)
    assets.add(chunk.file)
    for (const css of chunk.css ?? []) assets.add(css)
    for (const dependency of chunk.imports ?? []) visit(dependency)
  }
  visit('index.html')
  visit(routeKey)
  return assets
}
