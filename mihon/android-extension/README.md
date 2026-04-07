# Mihon Android Extension

这是一个独立的 Mihon Android 扩展工程，目录在：

```text
mihon/android-extension
```

功能：

- 作为 Mihon 扩展直接读取当前服务的 REST 接口
- 在扩展设置里手动填写服务器地址
- 支持 `http` 和 `https`
- 默认允许明文流量，方便局域网地址，例如 `http://192.168.1.20:4321`

## 依赖的服务接口

扩展会使用这些接口：

- `GET /api/series`
- `GET /api/series/:id`
- `GET /media/cover/:id`
- `GET /media/chapter/:chapterId/:pageIndex`

## 本地构建

这个工程没有提交 Gradle Wrapper。你本地如果要编译，需要自己准备：

- JDK 17
- Gradle 9.3.1
- Android SDK Platform 36
- Build Tools 36.0.0

然后在本目录执行：

```bash
gradle assembleRelease
```

## GitHub Actions

仓库根目录已经提供工作流：

```text
.github/workflows/build-mihon-extension.yml
```

推到 GitHub 后可以直接编译 APK。
