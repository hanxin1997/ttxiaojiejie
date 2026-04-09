# Folder Library

一个可 Docker 部署的套图目录整理服务，提供前端管理界面和 Mihon Android 扩展接口。

当前实现重点是：

- 扫描图片文件夹，识别漫画、卷、章节和图片页
- 取第一张图作为封面
- 保存标题、分类、卷章节结构和源路径等元数据
- 提供封面和章节图片的按需读取接口
- 支持分类目录绑定和单漫画手动分类
- 支持定时扫描
- 支持 Mihon Android 扩展直连当前服务

## 目录规则

支持两种常见结构。

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
- `./data`：应用配置和扫描结果

## Mihon 使用方式

当前实现的是 **Mihon Android 扩展直连服务端**，不是 Local Source 导出。

扫描后项目只会保存：

- 应用配置
- 扫描结果
- 封面和章节对应的源路径元数据

不会再把整套章节图片复制到项目目录里。Mihon 通过扩展访问服务端时，封面和章节图片都按需从原始图库读取。

Android 扩展工程位于：

```text
mihon/android-extension
```

它依赖这些接口：

- `GET /api/series`
- `GET /api/series/:id`
- `GET /media/cover/:id`
- `GET /media/chapter/:chapterId/:pageIndex`

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

## 可调环境变量

- `PORT`
- `DATA_DIR`
- `LIBRARY_ROOT`
- `SCAN_INTERVAL_MINUTES`
