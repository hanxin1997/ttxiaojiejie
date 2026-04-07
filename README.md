# Folder Library

一个可 Docker 部署的套图目录整理服务，带前端和后端，支持：

- 扫描图片文件夹，自动识别漫画、卷、章节和图片页
- 取第一张图片作为封面
- 取系列目录名作为漫画名
- 取下一层目录作为卷名
- 当卷目录下直接是 `1.jpg / 2.jpg / 3.jpg` 这类图片时，按图片数量生成章节名，例如 `20P`
- 当卷目录下还有章节子目录时，直接使用子目录名作为章节名
- 支持手动新增分类，并为分类选择对应文件夹
- 支持单漫画手动分类覆盖
- 支持定时扫描目录
- 支持导出为 Mihon 可读的本地源目录

## 目录规则

支持下面两种常见结构。

### 结构 1：卷目录下直接是图片

```text
library/
  Alice-Cosplay-图片/
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
  Alice-Cosplay-图片/
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

前端里可以：

1. 新增一个分类
2. 为这个分类选择一个对应文件夹

这个文件夹需要是 `LIBRARY_ROOT` 下的相对目录，例如：

```text
library/
  清纯/
    Alice-图片/
      Vol.1/
        1.jpg
  Bob-图片/
    Vol.1/
      1.jpg
```

如果你把分类 `清纯` 绑定到文件夹 `清纯`，那么：

- `清纯/Alice-图片` 会被扫描并自动归到 `清纯`
- `Bob-图片` 仍然按根目录普通漫画处理

注意：

- 当前扫描规则是“根目录直接子文件夹”和“已绑定分类目录下的直接子文件夹”
- 如果某个中间目录只是容器目录，但没有绑定到分类，系统不会继续无限向下猜测漫画根目录

## 运行

### Docker Compose

```bash
docker compose up -d --build
```

默认端口是 `4321`，浏览器打开：

```text
http://localhost:4321
```

## 挂载目录

`docker-compose.yml` 默认有三个挂载：

- `./library`：原始套图目录，只读挂载到容器 `/library`
- `./data`：应用配置和扫描结果
- `./mihon`：Mihon 导出目录，容器内是 `/exports`

最终 Mihon 本地源目录会生成到：

```text
./mihon/local
```

## Mihon 使用方式

当前实现的是 **Mihon Local Source 导出**，不是单独的 Android 扩展包。

导出目录中会包含：

- `cover.jpg`
- `details.json`
- 按顺序编号的章节目录
- 章节目录内按顺序编号的图片页

你可以把 `./mihon/local` 同步到手机的 Mihon 本地源目录，或者通过你自己的同步方案分发。

## 前端功能

- 查看扫描状态和上次扫描时间
- 修改图库根目录
- 修改扫描周期
- 修改目录名解析规则
- 新增分类并选择对应文件夹
- 手动触发扫描
- 手动重新生成 Mihon 导出
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
- `MIHON_EXPORT_ROOT`
- `SCAN_INTERVAL_MINUTES`
