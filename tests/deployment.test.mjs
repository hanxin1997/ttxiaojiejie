import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('runtime container installs production dependencies so Sharp cannot silently disappear', async () => {
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const runtimeStage = dockerfile.substring(dockerfile.indexOf('FROM node:24-alpine\nWORKDIR /app'));

  assert.match(runtimeStage, /npm install --omit=dev/);
  assert.match(runtimeStage, /\/api\/health\/ready/);
});

test('Mihon workflow pins the 1.6 build base and signs the APK with the in-repo keystore', async () => {
  const workflow = await fs.readFile(
    new URL('../.github/workflows/build-mihon-extension.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /KEIYOUSHI_COMMIT: 5083ff5d06b9cb7736216ae0fbd0be3828bcce2c/);
  assert.match(workflow, /:src:all:folderlibrary:testDebugUnitTest/);
  assert.match(workflow, /:src:all:folderlibrary:assembleRelease/);

  // spotless 插件只把 spotlessCheck 挂到 check 上，这里跑的两个任务都不经过 check，
  // 不显式列出就等于不检查格式。也不能在 CI 里 spotlessApply——那会掩盖源码是否干净。
  assert.match(workflow, /:src:all:folderlibrary:spotlessCheck/);
  assert.doesNotMatch(workflow, /spotlessApply/);
  // SDK 组件交给 AGP 按底座的 compileSdk 自己下载：workflow 里再写死版本号，
  // 底座一升级就会去装不存在的包（platforms;android-37 就是这么炸的）。
  assert.doesNotMatch(workflow, /sdkmanager/);
  assert.doesNotMatch(workflow, /build-tools[;/]\d/);
  assert.match(workflow, /"APKSIGNER=\$apksigner"/);

  // 签名交回底座的构建期签名路径：APK 必须在 Gradle 跑之前就能看到 signingkey.jks。
  // 先前那个 signingConfig = null 补丁是产出装不上的未签名包的直接原因，不能回来。
  assert.doesNotMatch(workflow, /signingConfig = null/);
  assert.match(
    workflow,
    /Copy-Item -LiteralPath 'mihon\/signingkey\.p12' -Destination '\.keiyoushi-base\/signingkey\.jks' -Force/,
  );
  // 这三个名字由底座的 signingConfigs.create("release") 定死，改一个字签名就静默落回 debug。
  for (const [name, value] of [
    ['ALIAS', 'folderlibrary'],
    ['KEY_STORE_PASSWORD', 'folderlibrary'],
    ['KEY_PASSWORD', 'folderlibrary'],
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${name}: ${value}$`, 'm'));
  }
  // 底座换掉选签名配置的方式就该炸，而不是静默产出 Mihon 装不上的包。
  assert.match(workflow, /no longer selects the signing config from signingkey\.jks/);
  assert.match(workflow, /no longer reads the signing credential \$name from the environment/);

  // 受保护分支补签步骤已删除：main 不受保护（ref_protected 恒为 false），它永远不会执行，
  // 而底座已在构建期签好名，再拿 apksigner 补签就是和它的设计对着干。
  assert.doesNotMatch(workflow, /github\.ref_protected/);
  assert.doesNotMatch(workflow, /secrets\.MIHON_/);
  assert.doesNotMatch(workflow, /APKSIGNER sign/);

  // 签名状态现在是确定的，必须硬断言——Mihon 的 ExtensionLoader 直接拒绝未签名包。
  assert.match(workflow, /name: Verify release APK signature/);
  assert.match(workflow, /\$env:APKSIGNER verify --verbose --print-certs \$env:RELEASE_APK/);
  assert.match(workflow, /Signer #\\d\+ certificate DN: \(\.\+\)/);
  assert.match(workflow, /\$_ -notmatch '\^CN=Folder Library'/);
  assert.match(workflow, /::error title=Unexpected APK signer/);
  // 固定文件名会丢掉 versionCode，而 Android 拒绝降级安装，分不清版本就没法排查。
  assert.match(workflow, /"RELEASE_APK=\$collected"/);
  assert.doesNotMatch(workflow, /folder-library-1\.6-(unsigned|staging|signed)\.apk/);

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

test('Mihon signing keystore is a usable PKCS12 store committed alongside the module', async () => {
  const keystore = await fs.readFile(new URL('../mihon/signingkey.p12', import.meta.url));

  // 不是安全边界，是安装前提：Mihon 的 ExtensionLoader 拒绝未签名包，而 AGP 自动生成的
  // debug key 每次 CI 都不同，签名一换 Android 就拒绝覆盖安装。所以要一把固定的密钥。
  // 只验 DER 外壳：PKCS12 是 SEQUENCE，两字节长度（0x30 0x82），空文件/文本占位符会被挡住。
  assert.equal(keystore[0], 0x30);
  assert.equal(keystore[1], 0x82);
  assert.ok(keystore.length > 1024, `keystore is only ${keystore.length} bytes`);
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
