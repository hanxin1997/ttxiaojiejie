# Folder Library — Keiyoushi 1.6

这是仓库唯一受支持的 Mihon 扩展模块。它不是独立 Gradle 根工程；CI 会把此目录
复制到固定提交的官方 `keiyoushi/extensions-source` 底座中的
`src/all/folderlibrary` 后测试和构建。

## 低配设备策略

- 列表强制分页，可选 20/40/80，默认 40。
- 列表只使用 300×450 WebP 缩略封面。
- 详情、章节摘要和页面模板分别请求；打开章节不重新下载作品详情。
- 分类缓存采用 stale-while-revalidate，刷新单飞，内容不变不写偏好存储。
- JSON API 使用独立、可取消的 15 秒客户端；大图继续由 Mihon 主客户端下载。
- 阅读默认原图，用户可主动切换平衡或省流固定规格。

## 服务端接口

- `GET /api/series?page=1&pageSize=40`
- `GET /api/series/:id`
- `GET /api/chapters/:id/pages`
- `GET /api/categories`
- `GET /media/cover/:id?variant=cover`
- `GET /media/chapter/:chapterId/:pageIndex`
