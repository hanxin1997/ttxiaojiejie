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
  // SDK 组件交给 AGP 按底座的 compileSdk 自己下载：workflow 里再写死版本号，
  // 底座一升级就会去装不存在的包（platforms;android-37 就是这么炸的）。
  assert.doesNotMatch(workflow, /sdkmanager/);
  assert.doesNotMatch(workflow, /build-tools[;/]\d/);
  assert.match(workflow, /"APKSIGNER=\$apksigner"/);
  assert.match(workflow, /if: github\.event_name == 'push' && github\.ref_protected == true/);
  for (const secret of [
    'MIHON_KEYSTORE_BASE64',
    'MIHON_KEY_ALIAS',
    'MIHON_STORE_PASSWORD',
    'MIHON_KEY_PASSWORD',
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.match(workflow, /name: Report staging APK signature state/);
  assert.match(workflow, /\$env:APKSIGNER verify --verbose --print-certs/);

  // 签名状态由底座构建期有没有 signingkey.jks 决定，两个方向的断言都会误报：
  // 断言"必须未签名"会在配了密钥时炸，断言"必须已签名"会在没配时炸。只守生产密钥不外泄。
  assert.doesNotMatch(workflow, /unexpectedly signed/);
  assert.doesNotMatch(workflow, /folder-library-1\.6-unsigned\.apk/);
  assert.match(workflow, /Signer #\\d\+ certificate DN: \(\.\+\)/);
  assert.match(workflow, /\$_ -notmatch 'CN=Android Debug'/);
  assert.match(workflow, /::error title=Production key leaked into staging APK/);

  // 扩展编译不得依赖其他 job：一旦挂上 needs，上游失败会让 APK 构建变成 skipped 而不是失败。
  assert.doesNotMatch(workflow, /^\s+needs:/m);

  const runCount = (workflow.match(/^\s+run: \|$/gm) ?? []).length;
  const strictRunCount = (
    workflow.match(/^\s+run: \|\r?\n\s+\$ErrorActionPreference = 'Stop'$/gm) ?? []
  ).length;
  assert.ok(runCount > 0);
  assert.equal(strictRunCount, runCount);

  // GitHub check annotations expose only 4096 decoded characters. Preserve the log tail,
  // where Gradle and Kotlin print the actionable failure, instead of the task-list prefix.
  assert.match(
    workflow,
    /\$report\.Substring\(\[Math\]::Max\(0, \$report\.Length - 4000\)\)/,
  );
  assert.doesNotMatch(
    workflow,
    /\$report\.Substring\(0, \[Math\]::Min\(40000, \$report\.Length\)\)/,
  );

  // 4096 字符的预算不能被单个用例的协程栈吃光：按 XML 结构逐用例提取，只留自家栈帧。
  assert.match(workflow, /function Get-TestFailureSummary/);
  assert.doesNotMatch(workflow, /Select-String -Pattern '<\(failure\|error\)/);
  assert.match(workflow, /\$_ -match \'\^\\s\*at \.\*folderlibrary\'/);
  assert.match(workflow, /\$budget = 4000 - \$failures\.Length/);
});

test('Mihon JVM tests include the runtime dependencies that official modules compileOnly', async () => {
  const buildScript = await fs.readFile(
    new URL('../mihon/keiyoushi-module/build.gradle.kts', import.meta.url),
    'utf8',
  );

  assert.match(buildScript, /testImplementation\(libs\.bundles\.common\)/);
  assert.match(buildScript, /testImplementation\(libs\.tachiyomi\.lib\.v16\)/);

  // 底座对每个编译单元都跑 SourceProcessor 并全局传 kei_sources，而 test/ 里结构上不可能有
  // @Source，KSP 会硬报错。这个模块是唯一带 test 源集的扩展，所以必须自己停掉测试端 KSP。
  assert.match(
    buildScript,
    /tasks\.matching \{ it\.name\.startsWith\("ksp"\) && it\.name\.contains\("UnitTest"\) \}/,
  );
});

test('Mihon list conversion avoids a prohibited member-extension callable reference', async () => {
  const source = await fs.readFile(
    new URL(
      '../mihon/keiyoushi-module/src/eu/kanade/tachiyomi/extension/all/folderlibrary/FolderLibrary.kt',
      import.meta.url,
    ),
    'utf8',
  );

  // Kotlin cannot create a callable reference to an extension function declared as a class member.
  assert.doesNotMatch(source, /\bSeriesListItemDto::toSManga\b/);
  assert.match(source, /items\.map\s*\{\s*item\s*->\s*item\.toSManga\(\)\s*\}/);
});

test('Mihon API requests stay off the stubbed host helpers so JVM tests can run', async () => {
  const source = await fs.readFile(
    new URL(
      '../mihon/keiyoushi-module/src/eu/kanade/tachiyomi/extension/all/folderlibrary/FolderLibraryApi.kt',
      import.meta.url,
    ),
    'utf8',
  );

  // extensions-lib 是桩：await()/awaitSuccess() 就是 throw Exception("Stub!")，
  // jsonInstance 是 Injekt.get()。两条路都只有 Mihon 进程里有实现，JVM 测试必挂。
  assert.doesNotMatch(source, /^import keiyoushi\./m);
  assert.match(source, /private val json = Json \{ ignoreUnknownKeys = true \}/);

  // 读 body 必须在挂起状态里完成，取消才能立刻拆 socket；resume 后再阻塞读就晚了。
  assert.match(source, /suspendCancellableCoroutine \{ continuation ->/);
  assert.match(source, /continuation\.invokeOnCancellation \{ call\.cancel\(\) \}/);
  assert.match(source, /call\.enqueue\(ParseOnResponse\(continuation, deserializer\)\)/);
  assert.match(source, /response\.use \{ json\.decodeFromBufferedSource\(deserializer, it\.body\.source\(\)\) \}/);
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
