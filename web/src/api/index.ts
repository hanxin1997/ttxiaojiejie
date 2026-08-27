// ===== API Types =====

export interface CountsDto {
  volumes: number
  chapters: number
  pages: number
}

export interface CategoriesDto {
  auto: string[]
  folder: string[]
  manual: string[]
  effective: string[]
}

export interface ReadProgress {
  chapterId: string
  pageIndex: number
  totalPages: number
  updatedAt: string
}

export interface SeriesListItem {
  id: string
  title: string
  author: string | null
  description: string | null
  sourceFolderName: string
  sourceKey: string
  counts: CountsDto
  totalBytes: number
  categories: CategoriesDto
  tags: string[]
  metadata: Record<string, unknown>
  coverUrl: string | null
  thumbCoverUrl: string | null
  latestChapterTitle: string
  favorite: boolean
  readProgress: ReadProgress | null
  readStatus: 'unread' | 'reading' | 'completed'
}

export interface SeriesListResponse {
  items: SeriesListItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  revision: number
}

export interface ChapterDto {
  id: string
  title: string
  pageCount: number
}

export interface VolumeDto {
  id: string
  title: string
  synthetic: boolean
  chapters: ChapterDto[]
}

export interface SeriesDetail extends SeriesListItem {
  volumes: VolumeDto[]
}

export interface ChapterPagesDto {
  chapterId: string
  pageCount: number
  urlTemplate: string
}

export interface FolderPattern {
  enabled: boolean
  separator: string
  authorSegmentIndex: number | null
  titleSegmentIndex: number
  categorySegmentIndex: number
  stripTokens: string[]
}

export interface NamingSettings {
  defaultVolumeName: string
  directImageChapterTemplate: string
}

export interface CategoryFolder {
  name: string
  folder: string
}

export interface Settings {
  libraryRoot: string
  scanIntervalMinutes: number
  autoExportToMihon: boolean
  folderPattern: FolderPattern
  naming: NamingSettings
  categoryFolders: CategoryFolder[]
}

export interface ScanStatus {
  running: boolean
  trigger: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface ScanProgress {
  current: number
  total: number
  currentDir: string | null
  phase: 'collecting' | 'scanning' | 'finalizing'
}

export interface LibrarySummary {
  seriesCount: number
  volumeCount: number
  chapterCount: number
  pageCount: number
  totalBytes: number
  categories: string[]
}

export interface AppState {
  settings: Settings
  scanStatus: ScanStatus
  scanProgress: ScanProgress | null
  summary: LibrarySummary
  issues: string[]
  lastScanAt: string | null
  lastScanLabel: string
  knownCategories: string[]
  knownTags: string[]
  revision: number
  resourceProfile: { name: 'lite' | 'balanced' | 'full'; requested: string }
}

export type RuntimeState = Omit<AppState, 'settings' | 'knownCategories' | 'knownTags'>

export interface MetadataResponse {
  autoTitle: string
  autoAuthor: string | null
  override: { title?: string; author?: string; description?: string }
  effective: { title: string; author: string | null; description: string | null }
}

export interface BrowseResult {
  currentPath: string
  parentPath: string | null
  directories: { name: string; path: string }[]
}

export interface DuplicateItem {
  id: string
  title: string
  sourceKey: string
  counts: CountsDto
  totalBytes: number
}

export interface DuplicateGroup {
  reason: 'same_title' | 'same_size_and_pages'
  items: DuplicateItem[]
}

export interface WatcherStatus {
  running: boolean
  watchedPaths: number
  lastEvent: {
    type: string
    filename: string
    dir: string
    time: string
  } | null
  eventCount: number
  errors: { time: string; message: string }[]
}

export interface RecommendationItem {
  score: number
  reasons: string[]
  series: SeriesListItem
}

export interface MetadataScrapeItem {
  seriesId: string
  title: string
  ok: boolean
  applied?: boolean
  error?: string
  scraped?: {
    source: string
    sourceUrl: string | null
    title: string | null
    author: string | null
    description: string
    tags: string[]
  }
}

export interface MetadataJobResponse {
  jobId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  total: number
  completedCount: number
  successCount: number
  failureCount: number
  items: MetadataScrapeItem[]
  page: number
  pageSize: number
  totalPages: number
}

// ===== API Client =====

class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 带竞态取消的 API 请求管理器 */
const abortControllers = new Map<string, AbortController>()

function cancelPending(key: string) {
  const prev = abortControllers.get(key)
  if (prev) {
    prev.abort()
    abortControllers.delete(key)
  }
}

async function request<T>(
  url: string,
  options: RequestInit & { cancelKey?: string } = {},
): Promise<T> {
  const { cancelKey, ...fetchOptions } = options

  let signal = fetchOptions.signal
  if (cancelKey) {
    cancelPending(cancelKey)
    const controller = new AbortController()
    abortControllers.set(cancelKey, controller)
    signal = controller.signal
  }

  const defaultHeaders: Record<string, string> = {}
  if (fetchOptions.body) {
    defaultHeaders['Content-Type'] = 'application/json'
  }

  const currentController = cancelKey ? abortControllers.get(cancelKey) : null
  let response: Response
  try {
    response = await fetch(url, {
      headers: defaultHeaders,
      ...fetchOptions,
      signal,
    })
  } finally {
    if (cancelKey && abortControllers.get(cancelKey) === currentController) {
      abortControllers.delete(cancelKey)
    }
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }))
    throw new ApiError(payload.error || `请求失败 (${response.status})`, response.status)
  }

  return response.json() as Promise<T>
}

// ===== Exported API Methods =====

export const api = {
  /** 高频刷新只读取运行状态与单调 revision。 */
  getRuntimeState(): Promise<RuntimeState> {
    return request<RuntimeState>('/api/state', { cancelKey: 'app-state' })
  },

  getSettings(): Promise<Settings> {
    return request<Settings>('/api/settings', { cancelKey: 'app-settings' })
  },

  getKnownCategories(): Promise<string[]> {
    return request<{ items: string[] }>('/api/categories', { cancelKey: 'app-categories' })
      .then((payload) => payload.items)
  },

  getKnownTags(): Promise<string[]> {
    return request<{ items: string[] }>('/api/tags', { cancelKey: 'app-tags' })
      .then((payload) => payload.items)
  },

  /** 获取全局状态 */
  async getState(): Promise<AppState> {
    const [runtime, settings, categories, tags] = await Promise.all([
      request<RuntimeState>('/api/state', { cancelKey: 'app-state' }),
      request<Settings>('/api/settings', { cancelKey: 'app-settings' }),
      request<{ items: string[] }>('/api/categories', { cancelKey: 'app-categories' }),
      request<{ items: string[] }>('/api/tags', { cancelKey: 'app-tags' }),
    ])
    return { ...runtime, settings, knownCategories: categories.items, knownTags: tags.items }
  },

  /** 获取漫画列表（带竞态取消） */
  getSeriesList(params: {
    search?: string
    category?: string
    sort?: string
    order?: string
    page: number
    pageSize: number
    favorites?: boolean
    tags?: string
    tagMode?: string
    minPages?: number
    maxPages?: number
    minSize?: number
    maxSize?: number
    readStatus?: string
  }): Promise<SeriesListResponse> {
    const query = new URLSearchParams()
    if (params.search) query.set('search', params.search)
    if (params.category) query.set('category', params.category)
    if (params.sort) query.set('sort', params.sort)
    if (params.order) query.set('order', params.order)
    query.set('page', String(params.page))
    query.set('pageSize', String(params.pageSize))
    if (params.favorites) query.set('favorites', 'true')
    if (params.tags) query.set('tags', params.tags)
    if (params.tagMode) query.set('tagMode', params.tagMode)
    if (params.minPages != null) query.set('minPages', String(params.minPages))
    if (params.maxPages != null) query.set('maxPages', String(params.maxPages))
    if (params.minSize != null) query.set('minSize', String(params.minSize))
    if (params.maxSize != null) query.set('maxSize', String(params.maxSize))
    if (params.readStatus) query.set('readStatus', params.readStatus)
    return request<SeriesListResponse>(`/api/series?${query}`, { cancelKey: 'series-list' })
  },

  /** 获取漫画详情 */
  getSeriesDetail(id: string): Promise<SeriesDetail> {
    return request<SeriesDetail>(`/api/series/${id}`, { cancelKey: 'series-detail' })
  },

  getChapterPages(id: string): Promise<ChapterPagesDto> {
    return request<ChapterPagesDto>(`/api/chapters/${id}/pages`, { cancelKey: 'chapter-pages' })
  },

  /** 设置漫画手动分类 */
  setSeriesCategories(id: string, categories: string[]): Promise<void> {
    return request('/api/series/' + id + '/categories', {
      method: 'PUT',
      body: JSON.stringify({ categories }),
    })
  },

  /** 切换收藏 */
  toggleFavorite(id: string): Promise<{ favorited: boolean }> {
    return request(`/api/series/${id}/favorite`, { method: 'POST' })
  },

  /** 设置自定义封面 */
  setCustomCover(id: string, chapterId: string, pageIndex: number): Promise<{ ok: boolean; coverUrl: string }> {
    return request(`/api/series/${id}/cover`, {
      method: 'PUT',
      body: JSON.stringify({ chapterId, pageIndex }),
    })
  },

  /** 删除自定义封面 */
  removeCustomCover(id: string): Promise<{ ok: boolean }> {
    return request(`/api/series/${id}/cover`, { method: 'DELETE' })
  },

  /** 批量设置分类 */
  batchSetCategories(seriesIds: string[], categories: string[]): Promise<{ ok: boolean; updated: number }> {
    return request('/api/series/batch/categories', {
      method: 'POST',
      body: JSON.stringify({ seriesIds, categories }),
    })
  },

  /** 批量设置标签 */
  batchSetTags(seriesIds: string[], tags: string[], mode: 'merge' | 'replace' = 'merge'): Promise<{ ok: boolean; updated: number }> {
    return request('/api/series/batch/tags', {
      method: 'POST',
      body: JSON.stringify({ seriesIds, tags, mode }),
    })
  },

  /** 更新设置 */
  updateSettings(settings: Partial<Settings>): Promise<Settings> {
    return request<Settings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    })
  },

  /** 手动触发扫描 */
  triggerScan(): Promise<{ ok: boolean; state: AppState }> {
    return request('/api/scan', { method: 'POST' })
  },

  /** 获取扫描进度 */
  getScanProgress(): Promise<{ status: ScanStatus; progress: ScanProgress | null }> {
    return request('/api/scan/progress')
  },

  /** 浏览目录 */
  browseFolders(path?: string): Promise<BrowseResult> {
    const query = new URLSearchParams()
    if (path) query.set('path', path)
    return request<BrowseResult>(query.size ? `/api/folders/browse?${query}` : '/api/folders/browse')
  },

  /** 替换分类配置 */
  replaceCategories(items: CategoryFolder[]): Promise<{ items: CategoryFolder[] }> {
    return request('/api/settings/categories', {
      method: 'PUT',
      body: JSON.stringify({ items }),
    })
  },

  /** 获取重复检测结果 */
  getDuplicates(): Promise<{ groups: DuplicateGroup[] }> {
    return request('/api/duplicates')
  },

  /** 获取文件监听状态 */
  getWatcherStatus(): Promise<WatcherStatus> {
    return request('/api/watcher')
  },

  /** 重启文件监听 */
  restartWatcher(): Promise<{ ok: boolean; status: WatcherStatus }> {
    return request('/api/watcher/restart', { method: 'POST' })
  },

  /** 获取元数据 */
  getSeriesMetadata(id: string): Promise<MetadataResponse> {
    return request(`/api/series/${id}/metadata`)
  },

  /** 更新元数据 */
  setSeriesMetadata(id: string, meta: { title?: string; author?: string; description?: string }): Promise<{ ok: boolean; metadata: Record<string, string> }> {
    return request(`/api/series/${id}/metadata`, {
      method: 'PUT',
      body: JSON.stringify(meta),
    })
  },

  /** 获取标签 */
  getSeriesTags(id: string): Promise<{ tags: string[] }> {
    return request(`/api/series/${id}/tags`)
  },

  /** 设置标签 */
  setSeriesTags(id: string, tags: string[]): Promise<{ ok: boolean; tags: string[] }> {
    return request(`/api/series/${id}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tags }),
    })
  },

  getSeriesRecommendations(id: string, limit = 8): Promise<{ items: RecommendationItem[] }> {
    return request(`/api/series/${id}/recommendations?limit=${limit}`)
  },

  createMetadataJob(options: {
    seriesIds?: string[]
    provider?: string
    overwrite?: boolean
    apply?: boolean
  }): Promise<{ jobId: string; status: string; total: number }> {
    return request('/api/metadata/jobs', {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },

  getMetadataJob(jobId: string, page = 1, pageSize = 50): Promise<MetadataJobResponse> {
    return request(`/api/metadata/jobs/${jobId}?page=${page}&pageSize=${pageSize}`, {
      cancelKey: `metadata-job:${jobId}`,
    })
  },

  cancelMetadataJob(jobId: string): Promise<{ jobId: string; status: string }> {
    return request(`/api/metadata/jobs/${jobId}`, { method: 'DELETE' })
  },

  /** 获取阅读进度 */
  getReadProgress(id: string): Promise<{ progress: ReadProgress | null }> {
    return request(`/api/series/${id}/progress`)
  },

  /** 更新阅读进度 */
  updateReadProgress(id: string, progress: { chapterId: string; pageIndex: number; totalPages: number }): Promise<{ ok: boolean; progress: ReadProgress }> {
    return request(`/api/series/${id}/progress`, {
      method: 'PUT',
      body: JSON.stringify(progress),
    })
  },

  /** 清除阅读进度 */
  clearReadProgress(id: string): Promise<{ ok: boolean }> {
    return request(`/api/series/${id}/progress`, { method: 'DELETE' })
  },
}
