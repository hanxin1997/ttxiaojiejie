# Mihon CI Android SDK 初始化修复

日期：2026-11-05（Asia/Shanghai）

状态：SDK 修复已推送并在 CI 通过；重试消除 Gradle 下载 HTTP 504 后，正在修复新增 Kotlin 文件命名检查。

## 证据与调用链

- 失败提交：`f0ebc7d4f845b9448c8feb242be86015bc4cb5a1`。
- 失败运行：`41878796597`，job `126745539366`，`Set up Android SDK` 失败，后续 Spotless、测试、APK 与签名步骤均未运行。
- 原始日志：commandline-tools 16.0 安装成功，许可证接受成功，执行 `sdkmanager tools` 时出现 `Warning: Failed to find package 'tools'`，随后退出码 1。
- 本次实际 action 为 `android-actions/setup-android@v3`，提交 `9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407`，其 `action.yml` 的 `packages` 默认值确为 `tools platform-tools`。
- 当前工作流未覆盖 packages，因此继承了已经不可用的旧包。Node/setup-java 弃用提示不是本次失败点。

## 修改范围

1. 修改 `.github/workflows/build-mihon-extension.yml`：为 setup-android 显式指定 `packages: platform-tools`。commandline-tools 和许可证仍由 action 处理；平台和 build-tools 继续交给固定 Keiyoushi/AGP 配置。不跳过 Spotless、测试或签名校验。
2. 修改 `tests/deployment.test.mjs`：先添加回归检查并确认失败，核对 SDK action 有显式包配置且不含独立 `tools` 包，保留现有固定底座、测试与签名检查。
3. 修改 `CLAUDE.md`：记录 SDK 初始化必须核对实际下载包和失败日志，不能依赖陈旧的默认包列表。
4. 新增本方案文件；如新构建暴露后续问题，先记录证据和必要范围再修复。

## 验证与交付

- 本地仅使用现有 Node，运行 `node --test --test-isolation=none tests/deployment.test.mjs`，不安装 Android/Gradle/任何依赖，不运行 Docker。
- 提交并推送修复，跟踪本次提交对应的新 Mihon workflow 到测试、release APK、签名和 artifact 成功，或记录明确外部阻塞。
- GitHub Actions SDK 集成以真实 CI 结果为准，静态回归检查不等同 Android 构建成功。

## 状态

- [x] 获取失败步骤、原始日志及实际 action 参数。
- [x] 落地修复方案和文件清单。
- [x] 回归检查先确认未显式配置 packages 时失败，再修复工作流。
- [x] 提交推送并核对远程提交：`6179c41`，本地 deployment 8/8 通过。
- [ ] 新构建完成测试、APK、签名和上传。

## 后续构建暴露的问题（2026-11-06）

- 新运行 `42046702791` 首次 attempt 的 SDK 步骤成功；Gradle 分发下载返回 HTTP 504。未修改 Gradle 版本，使用现有授权重试失败任务。
- 第二次 attempt 的 job `127361548640` 成功下载并启动 Gradle 9.6.1，`spotlessKotlinCheck` 失败，明确报 `FolderLibraryPreferences.kt:L1 ktlint(standard:filename)`：唯一类为 ReaderPreferences，文件应命名 ReaderPreferences.kt。这是前次新增代码的命名疏漏。
- 最小修复：将 `mihon/keiyoushi-module/src/eu/kanade/tachiyomi/extension/all/folderlibrary/FolderLibraryPreferences.kt` 重命名为同目录 `ReaderPreferences.kt`，内容和所有调用保持一致；更新方案中的当前文件名及 CLAUDE 规则。
- 已有真实 CI 失败即复现；不额外编写只断言文件名的实现镜像测试。保留 Spotless 作为真正验收，推送后继续跟踪测试、APK、签名和上传。
