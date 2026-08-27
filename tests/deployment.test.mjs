import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('runtime container installs production dependencies so Sharp cannot silently disappear', async () => {
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const runtimeStage = dockerfile.substring(dockerfile.indexOf('FROM node:24-alpine\nWORKDIR /app'));

  assert.match(runtimeStage, /npm install --omit=dev/);
  assert.match(runtimeStage, /\/api\/health\/ready/);
});

test('Mihon workflow pins the 1.6 build base and separates unsigned PRs from protected signing', async () => {
  const workflow = await fs.readFile(
    new URL('../.github/workflows/build-mihon-extension.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /KEIYOUSHI_COMMIT: 5083ff5d06b9cb7736216ae0fbd0be3828bcce2c/);
  assert.match(workflow, /:src:all:folderlibrary:testDebugUnitTest/);
  assert.match(workflow, /:src:all:folderlibrary:assembleRelease/);
  assert.match(workflow, /platforms;android-37/);
  assert.match(workflow, /build-tools;37\.0\.0/);
  assert.match(workflow, /build-tools\/37\.0\.0\/apksigner/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /npm run test:e2e/);
  assert.match(workflow, /if: github\.event_name == 'push' && github\.ref_protected == true/);
  for (const secret of [
    'MIHON_KEYSTORE_BASE64',
    'MIHON_KEY_ALIAS',
    'MIHON_STORE_PASSWORD',
    'MIHON_KEY_PASSWORD',
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.match(workflow, /name: Verify unsigned APK/);
  assert.match(workflow, /apksigner verify --verbose --print-certs/);
  assert.match(workflow, /- "benchmarks\/\*\*"/);
  assert.match(workflow, /npm run benchmark:scan/);

  const runCount = (workflow.match(/^\s+run: \|$/gm) ?? []).length;
  const strictRunCount = (
    workflow.match(/^\s+run: \|\r?\n\s+\$ErrorActionPreference = 'Stop'$/gm) ?? []
  ).length;
  assert.ok(runCount > 0);
  assert.equal(strictRunCount, runCount);
});

test('Mihon JVM tests include the runtime dependencies that official modules compileOnly', async () => {
  const buildScript = await fs.readFile(
    new URL('../mihon/keiyoushi-module/build.gradle.kts', import.meta.url),
    'utf8',
  );

  assert.match(buildScript, /testImplementation\(libs\.bundles\.common\)/);
  assert.match(buildScript, /testImplementation\(libs\.tachiyomi\.lib\.v16\)/);
});

test('Web refresh coordinator checks lightweight revision before reloading catalog data', async () => {
  const source = await fs.readFile(
    new URL('../web/src/composables/useAppState.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /api\.getRuntimeState\(\)/);
  assert.match(source, /runtime\.revision !== state\.meta\.revision/);
  assert.match(source, /if \(catalogChanged\)/);
});
