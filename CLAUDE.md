# Local Rules

- When Docker mount paths are part of the requirement, separate "display path" from "scan root" before designing the fix.
- Unless the user explicitly asks to filter detected mount points, show all detected container mount points and let the user choose.
- When referencing a local upstream project like Komga, extract and transplant the key interaction model first instead of only copying labels or surface layout.
- When diagnosing why a Mihon/Tachiyomi extension installs but does not appear in-app, inspect the official extension loading rules first (feature flag, metadata, library-version compatibility, signature trust, and source loading path) before proposing fixes; do not rely on guesswork.
- When a Mihon/Tachiyomi source filter can be driven by server metadata already exposed by the project, prefer using the server-provided source categories/taxonomy instead of defaulting to manual input fallbacks.
- 用户本地不是开发电脑，不要在本地运行 npm install 或安装任何依赖。依赖声明写入 package.json 即可，实际安装在 Docker 构建时完成。
- 当用户要求低配置设备性能优化时，默认优先优化 Mihon Android 扩展及其直接依赖的服务端接口；除非用户另行要求，不把范围泛化到 Web 或整套服务的低配模式。
- Mihon 扩展必须以 `.github/workflows/build-mihon-extension.yml` 作为可复现的自动化编译入口；修改模块时同步核对固定 Keiyoushi 底座、测试任务、APK 产物路径和受保护分支签名流程。
