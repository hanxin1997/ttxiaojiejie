# 性能审查与优化候选方案

日期：2026-11-05（Asia/Shanghai）

状态：全部批准范围的代码、独立复核与本地可执行验证已完成；真实 ZIP/Sharp、完整 Web 构建/浏览器及 APK 集成验证受本地依赖限制，已接入 CI，尚未实际运行 CI。

## 已批准实施范围与责任（2026-11-05）

全部候选纳入本次工作，包括队列恢复、线性扫描、FTS/分类、异步写入、CBZ 索引/增量复用、缓存维护与变体复用、OPDS/推荐/查重、重复索引、Web 阅读/导航/章节列表及性能 CI。用户此次回复即为批准，无需逐批再次询问。

墨水屏要求：优化首先贯通 Mihon 与服务端媒体；提供可选择的低配墨水屏预设（小分页、省流灰度），保持既有用户画质选择；转换在服务端完成，设备端不增加图像处理。Web 阅读提供相同选择，限制预取并发和内存，墨水屏模式减少动画。缓存和 worker 队列保持有界，避免以大量常驻内存或加并发掩盖性能问题。检查真实依赖不可用时的回退并明确报告验证限制。

文件唯一修改者分工：

- 存储子代理：`server/store.mjs`、`server/store-schema.mjs`、新增 `server/database-write-worker.mjs` / `server/database-write-worker-thread.mjs`（及必要的独立写入实现模块）、`tests/store.test.mjs`、新增写 worker 测试与 `benchmarks/write-benchmark.mjs`；实现有界分批写入、FTS 定位/无变化跳过、章节级复用、分类索引、批量标签和无损迁移。
- 扫描/归档子代理：`server/scanner.mjs`、`server/archive.mjs`、必要的新归档索引模块、`tests/scanner.test.mjs`、`tests/archive.test.mjs`、`benchmarks/scan-benchmark.mjs`；负责线性缓存释放、归档随机读取索引和未变章节复用。章节持久化契约先与存储子代理协调，禁止直接改对方文件。
- 客户端子代理：`web/**`、`mihon/keiyoushi-module/**`、新增 `.github/workflows/test-web.yml`；负责请求竞态复现、阅读预设/有界取消预取、大量章节虚拟化、预算/E2E 和墨水屏兼容。保持 APK 工作流入口，构建版本需要时递增。
- 主代理：其余文件，包括 `server/thumbnail.mjs`、`server/archive-cache.mjs`、`server/media-source.mjs`、媒体/作品/OPDS/高级路由、查询 worker、推荐模块、配置/启动/停机/指标、相应测试、服务端 CI、package.json、README、CLAUDE 与本方案；负责跨模块契约、性能基准、独立复核和整合。

辅助查询采用新增 `server/catalog-queries.mjs` 在现有查询线程内维护轻量作品特征与自然排序缓存，复用同一数据库连接，避免为 OPDS/推荐/查重再复制完整章节树或增加线程池。

约束：不安装依赖、不执行 Docker；bug 先加最小复现并确认失败，其余先完成业务改动后补测试；运行 Node 测试保持 `--test-isolation=none`。各子代理完成独立范围即报告证据，主代理逐项标记完成。

## 审查范围与现状

按当前工作区代码审查，包含尚未提交的 CBZ 支持。主代理整合核验，三个子代理分别审查数据库与接口、扫描与媒体、Mihon 与 Web。没有安装环境或依赖，没有使用 Docker，也没有修改现有未提交内容。

已贯通检查：目录发现 → 扫描/复用 → SQLite 写入/重启 → 查询 worker → HTTP → Mihon/Web；以及 CBZ 索引 → 单页提取 → 原图缓存 → 图片变体 → HTTP 缓存。

现有查询 worker、分页、扫描并发限制、CBZ 单页缓存、图片变体、Web 网格虚拟化、Mihon 轻量接口和图片档位均已存在。建议重点处理剩余的平方级工作量、主线程同步操作及缓存退化。

## 实测与边界

| 检查 | 本次结果 | 适用范围 |
| --- | --- | --- |
| `node benchmarks/catalog-benchmark.mjs` | 50,000 作品，80 项/页，查询 P95 123.70ms，事件循环 P99 22.20ms；现有门槛通过 | 直接插表、24 次串行请求、第 1–5 页；没有真实卷章和 HTTP 传输，不覆盖扫描入库、OPDS、推荐 |
| `node benchmarks/scan-benchmark.mjs` | 10,000 作品/1,000,000 页，338,459ms，RSS 峰值 376.4MB，文件 stat 并发峰值 16；现有门槛通过 | 虚拟文件系统，不含真实磁盘延迟和 `replaceLibrary()`；现有门槛只限制内存与并发，没有耗时门槛 |
| 缩略图队列饱和复现 | 队列恢复空闲后 `pending=1, active=0, queued=0`；重试仍返回 null，转换调用次数 0 | 使用真实 ThumbnailService、模拟 stat/编码器，主代理与子代理独立复现；不依赖 Sharp |
| FTS 定向实验 | 主代理 1,000 行：按 series_id 删除重插 162.11ms；预读 rowid 后按 rowid 删除重插 26.49ms；执行计划明确为全表扫描 | 内存 SQLite 简化 FTS 模型，验证定位成本，不代表整条扫描的优化倍数 |
| FTS 规模实验 | 子代理 1k/3k/6k 行按 series_id 更新约 250/2,195/8,366ms | 单次本机样本，非生产 P95 |
| 扫描路径操作计数 | 100/200/400 个单页作品：path.relative 调用 5,946/21,896/83,796 次 | 子代理虚拟文件系统实验，支持平方级路径工作量判断 |
| OPDS 与全库复制 | 10k 作品、每作 30 章，真实 buildCatalogFeed 返回 30 项约 2,321ms；同规模 getLibrary 复制约 1,034ms | 子代理合成数据单次测量，非生产请求 P95 |
| SQLite 索引检查 | 确认 volumes、chapters、pages 各存在一组列顺序完全相同的显式/自动索引 | 主代理使用当前 schema 的内存 SQLite `pragma_index_list/info` 核验 |

以上耗时仅作本机基线，审查时还有其他进程运行，不据此承诺生产提速倍数。扫描总耗时不能全部归因于某一个热点。

Node v24.11.1 可用；本地缺少 yauzl 和 Sharp。本次未跑真实 ZIP/图片编码性能、浏览器/Android 性能或全量功能测试。真实媒体性能需要在已有依赖的运行环境或 CI 验证，不能把模拟实验当作完整集成通过。

## 优先候选及完整改动范围

### 1. 修复队列饱和后持续回退原图（优先，范围小）

证据：`server/thumbnail.mjs:118` 队列满直接返回 `Promise.resolve(null)`，`:206` 仍将它写入 pendingJobs；清理只在未执行的任务回调 finally（`:202`）里。之后同来源/同档位的未命中请求一直获取该 null Promise，通常直到来源变化或服务重启。原图回退发生在 `server/routes/media.mjs:31`，影响封面、省流和灰度；去重表也可能持续积累。

修改：`server/thumbnail.mjs`、`tests/thumbnail.test.mjs`，必要时扩充 `tests/media-routes.test.mjs`。拒绝入队的任务不进入去重表，或将清理绑定到统一 Promise 生命周期，并做身份核对避免误删后继任务。

验收：先新增最小复现测试并确认失败，再修复；队列满时保留既有回退行为，释放队列后同一图片可重新转换；相同任务合并、失败重试和 pending 清零均通过。此项无需 schema 或公开协议变更。

### 2. 消除扫描及入库中的平方级工作量（收益高）

三条独立热点：

- `server/scanner.mjs:49` 的 releaseDirectoryTree，每个作品完成（`:1166`）都遍历剩余全库目录缓存。建议按实际访问目录/作品归属记录可释放键，释放成本与该作品目录数相关，保留候选发现与解析共享 readdir 的设计。
- `server/store-schema.mjs:220` 的 FTS series_id 为 UNINDEXED；`server/store.mjs:759` 准备按此列删除，`:859` 对每个作品删除重插，复用作品也执行。一次操作扫描全 FTS，整库更新近似平方级。采用批量预取 rowid 或稳定文档映射，并对文本不变的复用作品跳过索引更新；`:1022` 的元数据/标签刷新和批量标签入口也要一并覆盖。
- `server/store.mjs:898` 遍历每个作品，再调用 `:888` 的数组 find，分类应用又是平方级。直接处理当前对象或维护 sourceKey/id Map，并同步批量分类、标签和元数据定位。

修改：`server/scanner.mjs`、`server/store.mjs`、`tests/scanner.test.mjs`、`tests/store.test.mjs`、`benchmarks/scan-benchmark.mjs`、`benchmarks/catalog-benchmark.mjs`；若选稳定文档映射，另改 `server/store-schema.mjs` 并增加保留数据的迁移。批量标签事务涉及 `server/routes/series.mjs` 与 `tests/series-routes.test.mjs`。

批量预取 rowid 适用于整库操作；单作元数据/标签更新不能每次重新预取全表，应使用稳定映射或随写入维护的定位机制，否则单作更新仍有 O(N) 成本。

风险：释放缓存要处理嵌套/分类根和并发读取；不能丢失复用 CBZ 的数据库页索引；FTS 删除作品、改名、标签、作者、手动标题必须保持一致。任何 schema 升级不能走重建全部用户数据的路径。

验收：新增/删除/替换、完全未变化扫描、dirty-path、连续复用和重启均保持结果；100/200/400 目录工作量接近线性；真实 store 首次和复用写入加入规模实验；核对搜索结果、收藏和阅读进度。百万页基准增加耗时记录，并与相同环境基线比较。

### 3. 将大批同步写入移出 HTTP 主线程（高收益，需单独实施）

`server/store.mjs:367` 的写 Promise 队列只负责顺序，`:685` 的 DatabaseSync 大事务仍运行在主线程。已有 database-query-worker 仅负责读取。因此列表离线基准通过并不能保证扫描提交期间阅读不卡顿。

先完成第 2 项减少总工作量，再评估专用写 worker。拟新增 `server/database-write-worker.mjs`、`server/database-write-worker-thread.mjs`；修改 `server/store.mjs`、`server/shutdown.mjs`、`server/runtime-metrics.mjs`，扩充 `tests/store.test.mjs`、`tests/runtime.test.mjs`，新增 `tests/database-write-worker.test.mjs`。若实际方案能复用现有 worker 架构，实施前更新本文件清单。

风险：写事务、revision、内存快照、查询可见性必须保持一致；大快照 postMessage 的结构化复制仍有开销，不能仅把同步代码搬过去就宣称解决。需采用分批消息或有界暂存并保证最终原子发布，停机等待和错误恢复一并处理。

验收：真实扫描入库同时请求健康检查、列表、封面和章节页，记录 P95/P99 和最大事件循环停顿；参考现有 <50ms 事件循环目标，但以同硬件并发实验验收，不将其当作已实现承诺。

### 4. CBZ 冷读索引复用与未变化归档扫描（CBZ 多时优先）

`server/archive.mjs:289` 每次提取页重新打开包，并从第一个中央目录条目遍历到目标。对于 N 个图片条目的归档，首次读完各页要处理约 N(N+1)/2 个条目；1,000 页约 500,500 次条目处理。这是索引遍历量，不是整包解压量，缓存命中页不走该提取路径。

建议使用有数量/字节/句柄上限的归档索引缓存，按文件身份失效，保存经过验证的随机读取描述。优先复用成熟 ZIP 库能力，避免自行增加不完整 ZIP 解析。保留 CRC、展开大小、路径与读前后文件身份校验。

修改：`server/archive.mjs`、`server/archive-cache.mjs`、`tests/archive.test.mjs`、`tests/archive-cache.test.mjs`、`tests/media-routes.test.mjs`；如果独立索引缓存更合适，拟新增 `server/archive-index-cache.mjs` 和对应测试。持久化定位字段则还要同步 `server/scanner.mjs`、`server/store.mjs`、`server/database-query-worker-thread.mjs` 与迁移/重启测试。

周期重扫还有一个独立机会：未变化包也先读完条目后才判断作品可复用。子代理模拟 5 个 CBZ，第二次完全未变化扫描仍调用索引器 5 次。不能直接复用运行态 pages，因为 `store.mjs:134` 会清空它们；需章节级持久化身份和保留旧索引能力。此部分另涉及 `server/store-schema.mjs`、`tests/scanner.test.mjs`、`tests/store.test.mjs`，不与单页索引缓存混为一个小改动。

验收：1k/5k 页冷顺序读、随机跳页，记录中央目录访问次数和首图 P95；重复页命中不重提取；替换包、同名条目、ZIP64、CRC、容量、句柄释放与重启回归。真实 yauzl 验证尚待具备依赖的环境。

### 5. 降低图片缓存清理和指标采集成本（机械盘/NAS 更明显）

`server/thumbnail.mjs:195` 每次生成变体触发 prune；`:218` 起 readdir 并逐个 stat 全部缓存，`:285` getStats 也全量遍历。prunePromise 会合并同时发生的清理，但串行生成或监控请求仍可反复产生全量 I/O。`server/runtime-metrics.mjs:26` 调用该统计。`server/archive-cache.mjs:132` 每次释放页也调用 prune，`:269` 每次复制并排序全部记录。

建议缩略图启动时建立缓存记录/总字节数，生成/淘汰时增量维护；容量压力立即清理，TTL 按周期检查，定期协调外部删文件；归档清理采用同类调度或有界 LRU，空闲命中不必全排序。

修改：`server/thumbnail.mjs`、`server/archive-cache.mjs`、`server/runtime-metrics.mjs`，扩充 `tests/thumbnail.test.mjs`、`tests/archive-cache.test.mjs`、`tests/runtime.test.mjs`。如新增清理定时器需同步 `server/shutdown.mjs` 与生命周期测试。

风险及验收：保持空闲 TTL、容量、正在发送/转换的文件保护及稳定 ETag；1 万缓存条目下连续读和统计，检查 stat/readdir 次数不再随每个请求全量增长；验证外部删除、并发清理和重启账目。

同链路还有可独立优化的一点：`server/routes/media.mjs:27` 先获取 CBZ 原图，才查图片变体；`server/thumbnail.mjs:41` 的变体键使用原图缓存文件的 mtime/ctime。原图被淘汰重建后，即使归档和页内容没变，旧 WebP 也无法按新键复用。建议按稳定的归档身份、条目身份和变体规格生成键，验证来源后先查变体，命中时不必解压原图。另涉及 `server/media-source.mjs`、`server/routes/media.mjs` 和 `tests/media-routes.test.mjs`。验收“生成变体 → 淘汰原图 → 再请求变体”不重复解压/转码，并验证替换归档不会复用旧图及发送期间的淘汰保护。本项为静态判断，真实 Sharp/ZIP 实测未执行。

### 6. OPDS、推荐、查重避免全库同步处理（使用这些入口时收益高）

`server/routes/opds.mjs:137` 每次先投影所有作品，`:142` 中文排序，之后才过滤和分页；仅返回 30 项也会在主线程处理全库。OPDS 根/详情仅取扫描时间却调用 getLibrary 深拷贝（`:106`、`:204`）。推荐 `server/routes/series.mjs:215` 和查重 `server/routes/advanced.mjs:76` 同样复制全库。

修改：`server/routes/opds.mjs`、`server/routes/series.mjs`、`server/routes/advanced.mjs`、`server/recommendations.mjs`、`server/store.mjs`、`server/database-query-worker-thread.mjs`；扩充 `tests/opds.test.mjs`、`tests/recommendations.test.mjs`、`tests/series-routes.test.mjs`，拟新增 `tests/advanced-routes.test.mjs`，扩充 catalog 基准。

时间戳用 summary；内部只读操作取受控引用或轻量投影。OPDS 使用查询 worker 或按相关 revision 缓存，避免每页全库投影；复用 Collator。推荐目标特征只构造一次，候选特征缓存，保持同分排序的 Top-K；查重已有 ID Set 放到循环外增量维护。

风险：OPDS 当前有效标题自然排序、sourceKey/子串搜索和页码夹取，与普通 SQL 列表的 FTS 搜索及排序不同，不能直接替换接口而改变语义。缓存失效要覆盖标签、分类、元数据、手工封面和阅读状态等实际输出依赖。

验收：10k 作品/每作 30 章节，OPDS、推荐、查重结果等价；根和单作入口成本不随全库章节树增长；并发健康检查验证主线程停顿；中文数字排序、覆盖标题和删除作品回归。

### 7. 删除三组重复索引（磁盘和写放大优化，收益待测）

`server/store-schema.mjs:98–101` 的 volumes 唯一约束与显式索引重复；`:114–118` chapters 的 volume_id/position 索引重复；`:127–130` pages 主键与显式索引重复。当前 pragma 实验确认自动索引均存在。代码未用 INDEXED BY 固定这些显式名称。

修改 `server/store-schema.mjs`、`tests/store.test.mjs`；通过保留数据迁移移除重复显式索引，保留约束。若与第 2 项 schema 变更同批实施，合并迁移，避免重复升级。

验收：页面/章节查询计划继续使用唯一索引；百万页前后比较数据库/WAL 增量与写耗时。删除索引不保证已有数据库文件立即缩小，需区分可重用页与文件体积，不自动执行高成本 VACUUM。

### 8. Web 阅读流量与请求竞态（客户端次优先项）

- `web/src/components/DetailPanel.vue:403` 将页面模板展开为原图地址；`ImageViewer.vue:230` 用 new Image 预取前后各两页，未保留对象或取消离开窗口的请求。建议开放既有 balanced/lite 档位并保留原图选择，限制预取并发，优先下一页，关闭时取消。修改上述两组件；新增偏好字段时同步 API 类型/存储，仅在明确需要服务端持久化时扩大范围。
- `web/src/api/index.ts:259` 在 fetch 收到响应头后即移除 AbortController，响应体还未完成；`useAppState.ts:231` restoreActiveDetail 无 ID/世代保护，取消旧 A 请求的 catch 可能清空刚导航到的 B；DetailPanel 的推荐和元数据请求也可能旧结果覆盖新作品。修改 `web/src/api/index.ts`、`web/src/composables/useAppState.ts`、`web/src/components/DetailPanel.vue`，把取消生命周期覆盖完整 body，并为状态提交核对目标 ID/世代。
- 单作品几千章节时 DetailPanel/VolumeCard 全量渲染卷章；按需折叠/虚拟化可后续评估。修改 `web/src/components/DetailPanel.vue`、`web/src/components/VolumeCard.vue`。

验收：扩充 `web/e2e/performance.spec.ts`，必要时新增 `web/e2e/navigation.spec.ts`；延迟响应体、A/B 交错导航、后台刷新与用户导航竞争，确保结果归属正确；慢网跳 30 页再关闭检查在途上限及取消；用 5,000 章节而不是单章 5,000 页验证详情 DOM。此处竞态为静态确认，浏览器复现未执行，实施按 bug 流程先复现再修。

Mihon 已具备分页、流式 JSON 解码、协程取消、图片三档与灰度、分类缓存等。本次没有证据要求重新建设这些能力或强制降低默认画质。

## 性能验证补齐

当前两条 GitHub workflow 分别运行服务端单测和 Mihon 构建，未接入 catalog/scan 基准或 Web 性能脚本；README 关于一体化流水线的描述与当前实现不一致。

拟修改 `.github/workflows/test-server.yml` 增加合适规模的性能回归，新增 `.github/workflows/test-web.yml`，同步 `README.md`；修改 `web/scripts/check-budgets.mjs` 统计实际 library/detail 路由依赖图，当前只统计 index.html 直接引用文件。需要 manifest 时修改 `web/vite.config.ts`。扩充 `web/e2e/performance.spec.ts` 的真实小图片、慢 body 和大量章节场景。

现有 catalog 基准绕过 store 入库且无真实卷章；scan 基准不覆盖持久化且没有耗时门槛。应补真实 `scan → replaceLibrary → worker 查询 → HTTP` 并发实验，新增独立基准可用 `benchmarks/write-benchmark.mjs`、`benchmarks/media-benchmark.mjs`；CI 优先用操作次数、请求数、DOM 上限等确定性断言，再为耗时设置有余量的阈值。

## 实施状态与实际结果

用户批准后已把全部优化合并实施；重复索引移除、FTS 文档映射与章节归档身份合并为 v6 无损迁移。服务端普通 revision 与 catalog_revision 分离，阅读进度/收藏/封面更新不触发目录特征重建，响应投影仍读取最新状态。

实施遵循先落地方案和文件唯一修改者，bug 先复现失败再修复。整合复核额外确认并修复并发 metadata/tags、收藏切换、大小写 sourceKey、过期图片删除租约竞争、超时停机未关闭共享索引等边界问题，均有回归用例。

实际新增文件（除上一轮 CBZ 已有文件外）：

- `server/store-fts.mjs`、`server/database-write-worker.mjs`、`server/database-write-worker-thread.mjs`、`server/archive-index-cache.mjs`、`server/catalog-queries.mjs`。
- `tests/database-write-worker.test.mjs`、`tests/archive-index-cache.test.mjs`、`tests/catalog-queries.test.mjs`；媒体、扫描、存储、运行态、缩略图在既有测试中扩展。
- `benchmarks/write-benchmark.mjs`、`benchmarks/media-benchmark.mjs`；原 catalog 基准新增 5 万真实章节的辅助查询场景，scan 基准新增线性操作次数及耗时门槛。
- `web/src/utils/reader.ts`、`web/scripts/bundle-graph.mjs`、`web/tests/navigation.test.mjs`、`web/tests/reader.test.mjs`、`web/tests/budgets.test.mjs`、`web/e2e/fixtures.ts`、`web/e2e/navigation.spec.ts`、`.github/workflows/test-web.yml`。
- `mihon/keiyoushi-module/src/eu/kanade/tachiyomi/extension/all/folderlibrary/ReaderPreferences.kt`（后续 CI 按类名重命名）和对应 `test/.../FolderLibraryPreferencesTest.kt`；模块 versionCode 4→5，固定 Keiyoushi 构建入口不变。

本地验证结果（耗时为单机合成数据，不承诺实际 NAS/墨水屏同倍数）：

| 检查 | 最终结果 |
| --- | --- |
| 服务端全量单测 | `node --test --test-isolation=none tests/*.test.mjs`：145 项，134 通过、0 失败、11 跳过；跳过仅真实 yauzl/Sharp 归档链路 |
| 百万页冷扫 | 26,931ms（旧基线 338,459ms）；目录读取 10,001、释放访问 10,000、stat 并发 16；RSS 481.1MB |
| 5 万作品查询 | 补齐最终基准后 P95 116.40ms、事件循环 P99 26.33ms，门槛通过；此前同实现单次 61.86ms，说明本机计时有波动，不能只取最好结果 |
| 辅助查询 | 同 5 万作品加入 5 千作品/5 万章节：OPDS 冷查询 548.00ms，缓存分页 1.61ms，推荐 322.28ms；均在查询线程，主线程事件循环 P99 24.99ms |
| 写入与 HTTP | 2 千作品/10 万页首次 1,619.43ms，完全复用 146.63ms；并发读 P95 5.23ms，健康检查 P95 6.29ms（126 次）；事件循环 P99 19.71ms/max20.71ms；复用 FTS 写入 0 |
| 有界写入 | 批次上限 256 条/256KiB，本次峰值 256 条/74,752B；单条另有 4MiB 硬上限，逐批 ACK；回滚和重启测试通过 |
| 媒体复用 | 无 ZIP/Sharp 的确定性 HTTP 测试验证原图淘汰后墨水屏变体不重复解压/编码，替换归档返回过期错误；真实媒体基准明确报告缺依赖跳过 |
| 静态检查 | 49 个新增/修改 MJS `node --check` 通过；按仓库换行配置运行 `git diff --check` 通过 |
| 客户端本地 | `node --test --test-isolation=none web/tests/*.test.mjs`：8/8；真实 Vue 编译器检查 3 个修改组件 script/template 通过；3 个 E2E 文件 TypeScript 语法通过 |

客户端验收实现：API 控制器保留至响应体读取结束；详情、推荐、元数据均有目标/世代保护；Web 单次只挂载一个卷、最多 25 个章节，并在重扫后收敛页码；阅读预取只占一条请求，普通模式最多后两页、墨水屏仅下一页，流式读取不保留 Blob/像素数组，关闭时取消且立即卸载主图。Mihon 预设运行时选择 20/page、lite+mono，关闭恢复原偏好；版本号已递增。浏览器测试保留 WebSocket 正常时无轮询断言，新增慢 body、30 次翻页、真实小 PNG、5 千章节/卷和墨水屏持久化场景。

需要保留的限制：

- 百万页冷扫 RSS 比旧基线 376.4MB 高，最终 481.1MB；没有以更高扫描/文件并发提速，已减少所有权引用并定期让出事件循环，仍需在目标低配服务器验证内存峰值。墨水屏客户端只接收分页/缩放图片，不承担这部分扫描内存。
- 本地没有 yauzl/Sharp、完整 Web 依赖/Playwright 和 Android 构建底座。真实归档、编码、Web 构建与浏览器、APK 的 CI/设备结果尚未获得，不将配置好的 CI 当作已通过。
- CBZ 索引 16MiB 是元数据预算，不是 V8 实际堆精确上限；低配限制最多 4 个归档、1 个构建任务，超预算索引不常驻。Sharp 已经运行的原生编码不能强制终止，超时关闭只停止接受新请求并排空/结束队列。
- 无损迁移支持 v4/v5 和当前 v6；更早版本仍沿用原有重建行为，不自动回滚 schema 或执行 VACUUM。

- [x] 调查完整调用链，核对既有优化。
- [x] 三个子代理独立审查，主代理核验关键证据。
- [x] 运行现有 catalog/scan 基准。
- [x] 队列退化、FTS 访问计划和重复索引定向核验。
- [x] 落地候选方案、文件范围、风险和验收场景。
- [x] 用户批准全部一起实施，并增加低配置墨水屏要求。
- [x] 队列退化、线性扫描、无损迁移/FTS/分类和有界写 worker。
- [x] CBZ 索引缓存、章节复用、原图/变体缓存维护与稳定键。
- [x] OPDS/推荐/查重后台查询、内容版本、重复索引移除。
- [x] 服务端回归与 catalog/scan/write 基准、媒体 CI 基准。
- [x] Web/Mihon 墨水屏实现、客户端本地回归及编译语法核验。
- [ ] 在真实依赖环境完成 ZIP/Sharp 与浏览器验收。
