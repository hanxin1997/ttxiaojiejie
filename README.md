# Folder Library

一个可 Docker 部署的套图目录整理服务，提供前端管理界面和 Mihon Android 扩展接口。

当前实现重点是：

- 扫描图片文件夹和 CBZ，识别漫画、卷、章节和图片页
- 支持外置封面，也可取正文第一页作为封面
- 保存标题、分类、卷章节结构和源路径等元数据
- 提供封面和章节图片的按需读取接口
- 支持分类目录绑定和单漫画手动分类
- 支持定时扫描
- 支持 Mihon Android 扩展直连当前服务

## 目录规则

支持以下常见结构；CBZ 可以与现有图片章节放在同一个作品目录中。

### 结构 1：卷目录下直接是图片

```text
library/
  Alice-Cosplay-images/
    Vol.1/
      1.jpg
      2.jpg
      3.jpg
    Vol.2/
      1.jpg
      2.jpg
```

解析结果：

- 漫画名：`Alice`
- 目录名分类：`Cosplay`
- 卷名：`Vol.1`、`Vol.2`
- 章节名：按图片数量生成，例如 `3P`、`2P`

### 结构 2：卷下面还有章节目录

```text
library/
  Alice-Cosplay-images/
    Vol.1/
      Part A/
        1.jpg
        2.jpg
      Part B/
        1.jpg
        2.jpg
```

解析结果：

- 漫画名：`Alice`
- 目录名分类：`Cosplay`
- 卷名：`Vol.1`
- 章节名：`Part A`、`Part B`

### 结构 3：作品目录中的 CBZ

```text
library/
  作者名/
    漫画名字/
      封面.jpg
      第1章.cbz
      第2章.cbz
      第10章.cbz
```

- `漫画名字` 是一个作品，每个 CBZ 是一个章节，章节名为文件名去掉扩展名。
- CBZ 文件和包内图片按自然顺序排列，例如 `1`、`2`、`10`；扩展名大小写不敏感。包内嵌套目录中的图片也会读取。
- 有有效 CBZ 时，同级名为 `cover`、`folder` 或 `封面` 的图片用作封面；同级只有一张图片时也视作外置封面。这些封面不计入正文章节，其余散图仍按原有规则组成图片章节。
- 没有外置封面时，使用第一个有效 CBZ 章节的第一页。仅包含 CBZ 的目录同样可以扫描。
- `作者名` 只用于目录组织，不会自动写入作者信息。分类绑定目录也遵循相同的扫描规则。

CBZ 使用 ZIP 容器，支持 Store/Deflate、ZIP64、UTF-8、Unicode 路径及 CP437 文件名；不自动猜测无编码标记的 GBK 文件名。目录项、非图片、`__MACOSX` 和 AppleDouble 文件会被忽略。加密包、不支持的压缩方式、损坏的目录索引和不安全的条目路径会产生包含文件路径的扫描问题，一个坏包不会中断其他作品的扫描。无法建立索引的包不能生成可阅读章节，只有这种坏包和封面的目录也不会显示为成功读取的作品。图片数据在实际阅读时校验大小和 CRC32，校验失败会返回读取错误。

归档最多允许 20,000 个条目及 8 MiB 索引元数据，单页展开默认不超过 64 MiB。扫描只读取页索引；阅读时按需提取单页，Web 和 Mihon 使用相同的章节图片接口，封面、省流和灰度模式也适用于 CBZ。

升级后执行一次扫描以建立 CBZ 页索引；替换 CBZ 后也需要等自动扫描完成或手动扫描。旧的仅封面章节被移除后，失效的手动封面会回退默认封面，旧阅读位置不会跳转到新章节。

## 分类目录

前端可以新增分类，并把分类绑定到某个目录。

例如：

```text
library/
  featured/
    Alice-images/
      Vol.1/
        1.jpg
  Bob-images/
    Vol.1/
      1.jpg
```

如果把分类 `Featured` 绑定到目录 `featured`，那么：

- `featured/Alice-images` 会被扫描并自动归入 `Featured`
- `Bob-images` 仍然按普通漫画处理

## 运行

### Docker Compose

```bash
docker compose up -d --build
```

默认端口是 `4321`：

```text
http://localhost:4321
```

## 挂载目录

`docker-compose.yml` 默认有两个挂载：

- `./library`：原始套图目录，只读挂载到容器 `/library`
- `./data`：应用配置、扫描结果及按需图片缓存

## Mihon 使用方式

当前实现的是 **Mihon Android 扩展直连服务端**，不是 Local Source 导出。

扫描后项目只会保存：

- 应用配置
- 扫描结果
- 封面和章节对应的源路径元数据
- 按需生成的封面/图片变体，以及 `data/archive-pages` 下有容量和空闲期限限制的 CBZ 单页原图缓存

Mihon 通过扩展访问服务端时，普通图片按需从原始图库读取，CBZ 只提取请求的页，不会整包解压。

独立的 Keiyoushi 1.6 模块位于：

```text
mihon/keiyoushi-module
```

模块使用 `KeiSource` suspend API，并依赖这些轻量接口：

- `GET /api/series?page=1&pageSize=40`
- `GET /api/series/:id`
- `GET /api/chapters/:id/pages`
- `GET /api/categories`
- `GET /media/cover/:id`
- `GET /media/chapter/:chapterId/:pageIndex`

扩展不在本仓库复制完整官方构建树。GitHub Actions 会拉取固定提交
`5083ff5d06b9cb7736216ae0fbd0be3828bcce2c` 的 Keiyoushi 底座，覆盖模块后运行
MockWebServer 单测并构建 APK。签名由固定底座在构建期完成，工作流校验固定证书指纹，
保留稳定的扩展升级身份。自动化入口是 `.github/workflows/build-mihon-extension.yml`。

服务端单测/性能基准、Web 检查和 APK 构建分别由独立工作流运行；APK 构建不依赖其他任务。
`.github/workflows/test-server.yml` 验证真实 ZIP/Sharp、5 万作品列表、分批入库，Linux 还运行百万页扫描和媒体基准。
`.github/workflows/test-web.yml` 验证类型、构建、资源预算和浏览器行为，包括请求取消、列表/章节 DOM 上限及阅读预取。
提交工作流配置不代表已经在 CI 执行通过。

本次升级会将 v4/v5 数据库无损迁移到 v6，保留设置、收藏、阅读进度和手动覆盖数据。
更早的 schema 版本仍沿用重建并重新扫描的规则，也不导入旧备份或兼容 Mihon 1.4；
服务端、Web 和 1.6 扩展需保持版本匹配，CBZ 阅读继续使用现有扩展接口。

## 低配置设备和墨水屏

Mihon 源设置提供可选择的墨水屏低配预设：每页 20 个作品，阅读图片使用服务端 1280px 省流灰度输出。
关闭预设后继续使用原有分页、画质和灰度设置，不自动覆盖已有偏好。灰度会丢失彩色信息，原图选项保留。
Web 阅读器也提供图片档位并限制预取；墨水屏模式减少动态效果，设备端不额外进行像素转换。

图库服务器自身配置较低时可设置 `RESOURCE_PROFILE=lite`。它限制扫描、编码和归档索引构建并发；
与阅读设备的画质偏好是两个独立设置。单次页提取仍校验 CRC、大小和归档身份，缓存不以取消校验换性能。

扫描提交在专用线程内分批、原子写入；未变章节保留已有页索引，未变全文不重写 FTS。
OPDS、推荐和查重使用查询线程中的轻量目录；图片缓存增量统计，HTTP 发送期间保留租约。
CBZ 目录索引缓存限制元数据预算和归档数，不常驻打开归档句柄；大型单项超过预算时只在当次使用。
原图被淘汰后，已有省流/灰度变体仍可直接命中；归档被替换后需要重扫，旧变体不会继续冒充新内容。

性能基准可单独运行 `npm run benchmark`、`npm run benchmark:scan`、`npm run benchmark:write`、
`npm run benchmark:media`。媒体基准需要已安装的 yauzl/Sharp，本地缺依赖时会明确报告跳过；
CI 的 `REQUIRE_ARCHIVE_DEPS=1` 禁止跳过。资源、队列与索引统计可从 `/api/metrics` 查看。

## 前端功能

- 查看扫描状态和上次扫描时间
- 修改图库根目录
- 修改扫描周期
- 修改目录名解析规则
- 新增分类并选择对应文件夹
- 手动触发扫描
- 查看漫画、卷、章节
- 为单个漫画设置手动分类

## 本地开发

```bash
npm start
```

测试：

```bash
npm test
```

后端自动化入口为 `.github/workflows/test-server.yml`，在 Windows/Linux 的 Node 24 上安装声明依赖后运行测试，并要求真实 `yauzl` 与 Sharp 可用。本地未安装这些依赖时，真实归档和图片转换测试可能跳过，不代表相应链路已经验证。

## 可调环境变量

- `PORT`
- `DATA_DIR`
- `LIBRARY_ROOT`
- `SCAN_INTERVAL_MINUTES`
- `RESOURCE_PROFILE=auto|lite|balanced|full`（默认 `auto`）
- `IMAGE_CACHE_MAX_MB`（默认 `512`）
- `IMAGE_CACHE_MAX_QUEUE`（默认 `128`）
- `IMAGE_CACHE_TTL_HOURS`（默认 `168`，按空闲时间过期）
- `ARCHIVE_CACHE_MAX_MB`（默认 `512`，CBZ 单页原图缓存容量，独立于图片变体缓存）
- `ARCHIVE_CACHE_MAX_QUEUE`（默认 `128`，等待提取的单页任务上限）
- `ARCHIVE_CACHE_TTL_HOURS`（默认 `168`，按空闲时间过期）
- `ARCHIVE_MAX_PAGE_MB`（默认 `64`，单页展开大小上限；解压并发沿用 `RESOURCE_PROFILE` 的图片处理并发）
- `METADATA_JOB_DEADLINE_MS`
- `TRUST_PROXY`
- `WS_MAX_FRAME_KB`
