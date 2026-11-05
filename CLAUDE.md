# Local Rules

- When Docker mount paths are part of the requirement, separate "display path" from "scan root" before designing the fix.
- Unless the user explicitly asks to filter detected mount points, show all detected container mount points and let the user choose.
- When referencing a local upstream project like Komga, extract and transplant the key interaction model first instead of only copying labels or surface layout.
- When diagnosing why a Mihon/Tachiyomi extension installs but does not appear in-app, inspect the official extension loading rules first (feature flag, metadata, library-version compatibility, signature trust, and source loading path) before proposing fixes; do not rely on guesswork.
- When a Mihon/Tachiyomi source filter can be driven by server metadata already exposed by the project, prefer using the server-provided source categories/taxonomy instead of defaulting to manual input fallbacks.
- 用户本地不是开发电脑，不要在本地运行 npm install 或安装任何依赖。依赖声明写入 package.json 即可，实际安装在 Docker 构建时完成。
- 当用户要求低配置设备性能优化时，默认优先优化 Mihon Android 扩展及其直接依赖的服务端接口；除非用户另行要求，不把范围泛化到 Web 或整套服务的低配模式。
- Mihon 扩展必须以 `.github/workflows/build-mihon-extension.yml` 作为可复现的自动化编译入口；修改模块时同步核对固定 Keiyoushi 底座、测试任务、APK 产物路径和受保护分支签名流程。
- 支持 CBZ 等归档时必须检查候选发现、章节和封面规则、数据库持久化及重启、媒体和图片变体、缓存失效、增量扫描整条链路；不能只增加扩展名识别，也不能把外置封面误当作唯一正文。新增索引字段必须保留现有用户设置、收藏和阅读进度。
- 运行 Node 单测前先核对 package.json 的测试脚本，沿用本项目的 `--test-isolation=none` 参数；不要无意切回默认子进程隔离而触发本地受限环境的 `spawn EPERM` 和额外权限等待。
- 用户明确要求全部优化一起实施时，应覆盖已审查的全部范围，不再擅自缩为首批；涉及低配墨水屏时，同时核对 Mihon 分页、服务端省流/灰度、缓存与阅读响应，不把设备负担转移为客户端图像处理。
- Mihon CI 的 Android SDK 初始化必须显式声明仍可用的包（如 platform-tools），不继承 setup-android 的旧 tools 默认包；失败时先核对原始日志中的实际命令及 action 固定提交，不能将弃用警告误判为根因。
