import { reactive, readonly } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type {
  AppState,
  CategoryFolder,
  DuplicateGroup,
  ScanProgress,
  ScanStatus,
  SeriesDetail,
  SeriesListItem,
  WatcherStatus,
} from '../api'
import { api } from '../api'
import { router } from '../router'

export interface CategoryDraft {
  name: string
  folder: string
}

interface State {
  meta: AppState | null
  series: SeriesListItem[]
  activeSeriesId: string | null
  activeSeries: SeriesDetail | null
  search: string
  category: string
  sortBy: string
  sortOrder: string
  page: number
  pageSize: number
  totalPages: number
  totalItems: number
  favoritesOnly: boolean
  categoryDrafts: CategoryDraft[]
  categoryDirty: boolean
  loadingList: boolean
  loadingDetail: boolean
  scanning: boolean
  darkMode: boolean | null
  selectedSeriesIds: Set<string>
  duplicateGroups: DuplicateGroup[]
  watcherStatus: WatcherStatus | null
  currentView: 'library' | 'detail' | 'settings'
  sidebarCollapsed: boolean
  liveScanStatus: ScanStatus | null
  liveScanProgress: ScanProgress | null
  realtimeConnected: boolean
  // 高级过滤
  advancedFilters: {
    tags: string[]
    tagMode: 'and' | 'or'
    minPages: number | null
    maxPages: number | null
    minSize: number | null
    maxSize: number | null
    readStatus: string | null
  }
  // 布局模式
  layoutMode: 'grid' | 'list' | 'waterfall'
  // 选择模式
  selectionMode: boolean
}

const state = reactive<State>({
  meta: null,
  series: [],
  activeSeriesId: null,
  activeSeries: null,
  search: '',
  category: '',
  sortBy: 'title',
  sortOrder: 'asc',
  page: 1,
  pageSize: 80,
  totalPages: 1,
  totalItems: 0,
  favoritesOnly: false,
  categoryDrafts: [],
  categoryDirty: false,
  loadingList: false,
  loadingDetail: false,
  scanning: false,
  darkMode: null,
  selectedSeriesIds: new Set<string>(),
  duplicateGroups: [],
  watcherStatus: null,
  currentView: 'library',
  sidebarCollapsed: false,
  liveScanStatus: null,
  liveScanProgress: null,
  realtimeConnected: false,
  advancedFilters: {
    tags: [],
    tagMode: 'and',
    minPages: null,
    maxPages: null,
    minSize: null,
    maxSize: null,
    readStatus: null,
  },
  layoutMode: (localStorage.getItem('layout-mode') as 'grid' | 'list' | 'waterfall') || 'grid',
  selectionMode: false,
})

function syncCategoryDrafts(force = false) {
  if (!state.meta) return
  if (!force && state.categoryDirty) return

  state.categoryDrafts = (state.meta.settings.categoryFolders ?? []).map((item) => ({
    name: item.name,
    folder: item.folder ?? '',
  }))
  state.categoryDirty = false
}

let refreshInFlight: Promise<void> | null = null
let refreshPending = false
let refreshForceCategoryReset = false
let listGeneration = 0
let listInFlight: { key: string; promise: Promise<void> } | null = null

async function refreshAll(forceCategoryReset = false) {
  refreshPending = true
  refreshForceCategoryReset ||= forceCategoryReset
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    while (refreshPending) {
      refreshPending = false
      const forceReset = refreshForceCategoryReset
      refreshForceCategoryReset = false
      const runtime = await api.getRuntimeState()
      const catalogChanged = !state.meta || runtime.revision !== state.meta.revision

      if (catalogChanged) {
        const [settings, knownCategories, knownTags] = await Promise.all([
          api.getSettings(),
          api.getKnownCategories(),
          api.getKnownTags(),
          loadSeriesList(),
        ])
        state.meta = { ...runtime, settings, knownCategories, knownTags }
        syncCategoryDrafts(forceReset)
      } else if (state.meta) {
        // 扫描进度变化但 catalog revision 未变时，仅合并轻量运行状态。
        state.meta = { ...state.meta, ...runtime }
      }

      if (!state.liveScanStatus?.running && !runtime.scanStatus.running) {
        state.liveScanProgress = null
        state.liveScanStatus = null
      }
    }
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

function buildListParams() {
  const af = state.advancedFilters
  return {
    search: state.search || undefined,
    category: state.category || undefined,
    sort: state.sortBy !== 'title' ? state.sortBy : undefined,
    order: state.sortOrder !== 'asc' ? state.sortOrder : undefined,
    page: state.page,
    pageSize: state.pageSize,
    favorites: state.favoritesOnly || undefined,
    tags: af.tags.length > 0 ? af.tags.join(',') : undefined,
    tagMode: af.tags.length > 0 ? af.tagMode : undefined,
    minPages: af.minPages ?? undefined,
    maxPages: af.maxPages ?? undefined,
    minSize: af.minSize ?? undefined,
    maxSize: af.maxSize ?? undefined,
    readStatus: af.readStatus ?? undefined,
  }
}

async function loadSeriesList() {
  const params = buildListParams()
  const key = JSON.stringify(params)
  if (listInFlight?.key === key) return listInFlight.promise
  const generation = ++listGeneration
  state.loadingList = true
  const promise = api.getSeriesList(params)
    .then((payload) => {
      if (generation !== listGeneration) return
      state.page = payload.page
      state.pageSize = payload.pageSize
      state.totalPages = payload.totalPages
      state.totalItems = payload.total
      if (payload.page > payload.totalPages) {
        state.page = payload.totalPages
        queueMicrotask(() => { void loadSeriesList() })
        return
      }
      state.series = payload.items
    })
    .finally(() => {
      if (listInFlight?.promise === promise) {
        listInFlight = null
        state.loadingList = false
      }
    })
  listInFlight = { key, promise }
  return promise
}

async function loadSeriesDetail(id: string) {
  state.activeSeriesId = id
  state.loadingDetail = true
  try {
    const detail = await api.getSeriesDetail(id)
    if (state.activeSeriesId === id) {
      state.activeSeries = detail
    }
  } catch {
    if (state.activeSeriesId === id) {
      state.activeSeriesId = null
      state.activeSeries = null
    }
  } finally {
    if (state.activeSeriesId === id) {
      state.loadingDetail = false
    }
  }
}

async function restoreActiveDetail() {
  if (!state.activeSeriesId) return
  try {
    state.activeSeries = await api.getSeriesDetail(state.activeSeriesId)
  } catch {
    state.activeSeriesId = null
    state.activeSeries = null
  }
}

async function runScan() {
  state.scanning = true
  try {
    await api.triggerScan()
    await refreshAll(false)
    await restoreActiveDetail()
  } finally {
    state.scanning = false
  }
}

async function saveSettings(settings: Parameters<typeof api.updateSettings>[0]) {
  await api.updateSettings(settings)
  await api.triggerScan()
  await refreshAll(true)
  await restoreActiveDetail()
}

async function saveSeriesCategories(seriesId: string, categories: string[]) {
  await api.setSeriesCategories(seriesId, categories)
  const apply = (series: SeriesListItem | SeriesDetail) => {
    series.categories.manual = [...categories]
    series.categories.effective = [...new Set([
      ...series.categories.auto,
      ...series.categories.folder,
      ...categories,
    ])]
  }
  const listItem = state.series.find((item) => item.id === seriesId)
  if (listItem) apply(listItem)
  if (state.activeSeries?.id === seriesId) apply(state.activeSeries)
}

async function saveCategoryFolders() {
  if (!state.categoryDirty) return

  const items: CategoryFolder[] = state.categoryDrafts
    .filter((draft) => draft.name.trim() && draft.folder.trim())
    .map((draft) => ({
      name: draft.name.trim(),
      folder: draft.folder.trim(),
    }))

  await api.replaceCategories(items)
  state.categoryDirty = false
  await api.triggerScan()
  await refreshAll(true)
  await restoreActiveDetail()
}

function addCategoryDraft(draft: CategoryDraft) {
  state.categoryDrafts.push(draft)
  state.categoryDirty = true
}

function updateCategoryDraft(index: number, draft: CategoryDraft) {
  if (!state.categoryDrafts[index]) return
  state.categoryDrafts[index] = draft
  state.categoryDirty = true
}

function removeCategoryDraft(index: number) {
  state.categoryDrafts.splice(index, 1)
  state.categoryDirty = true
}

function setSearch(value: string) {
  state.search = value
  state.page = 1
  state.selectedSeriesIds.clear()
}

function setCategory(value: string) {
  state.category = value
  state.page = 1
  state.selectedSeriesIds.clear()
}

function setSortBy(value: string) {
  state.sortBy = value
  state.page = 1
  state.selectedSeriesIds.clear()
}

function setSortOrder(value: string) {
  state.sortOrder = value
  state.page = 1
  state.selectedSeriesIds.clear()
}

function setPage(value: number) {
  state.page = value
  state.selectedSeriesIds.clear()
}

function setPageSize(value: number) {
  state.pageSize = value
  state.page = 1
  state.selectedSeriesIds.clear()
}

function setFavoritesOnly(value: boolean) {
  state.favoritesOnly = value
  state.page = 1
  state.selectedSeriesIds.clear()
}

function setAdvancedFilters(filters: State['advancedFilters']) {
  state.advancedFilters = { ...filters }
  state.page = 1
  state.selectedSeriesIds.clear()
}

function setLayoutMode(mode: 'grid' | 'list' | 'waterfall') {
  state.layoutMode = mode
  localStorage.setItem('layout-mode', mode)
}

function toggleSelectionMode() {
  state.selectionMode = !state.selectionMode
  if (!state.selectionMode) {
    state.selectedSeriesIds.clear()
  }
}

function exitSelectionMode() {
  state.selectionMode = false
  state.selectedSeriesIds.clear()
}

async function batchSetTags(tags: string[], mode: 'merge' | 'replace' = 'merge') {
  if (state.selectedSeriesIds.size === 0) return
  await api.batchSetTags([...state.selectedSeriesIds], tags, mode)
  state.selectedSeriesIds.clear()
  state.selectionMode = false
  await loadSeriesList()
}

function toggleSeriesSelection(id: string) {
  if (state.selectedSeriesIds.has(id)) state.selectedSeriesIds.delete(id)
  else state.selectedSeriesIds.add(id)
}

function clearSelection() {
  state.selectedSeriesIds.clear()
}

function selectAll() {
  state.selectedSeriesIds.clear()
  for (const series of state.series) state.selectedSeriesIds.add(series.id)
}

async function toggleFavorite(seriesId: string) {
  const result = await api.toggleFavorite(seriesId)
  const listItem = state.series.find((item) => item.id === seriesId)
  if (listItem) listItem.favorite = result.favorited
  if (state.activeSeries?.id === seriesId) state.activeSeries.favorite = result.favorited
}

async function setCustomCover(seriesId: string, chapterId: string, pageIndex: number) {
  const result = await api.setCustomCover(seriesId, chapterId, pageIndex)
  const listItem = state.series.find((item) => item.id === seriesId)
  if (listItem) {
    listItem.coverUrl = result.coverUrl
    listItem.thumbCoverUrl = `${result.coverUrl}?variant=cover`
  }
  if (state.activeSeries?.id === seriesId) {
    state.activeSeries.coverUrl = result.coverUrl
    state.activeSeries.thumbCoverUrl = `${result.coverUrl}?variant=cover`
  }
}

async function removeCustomCover(seriesId: string) {
  await api.removeCustomCover(seriesId)
  await loadSeriesDetail(seriesId)
}

async function saveReadProgress(seriesId: string, chapterId: string, pageIndex: number, totalPages: number) {
  const result = await api.updateReadProgress(seriesId, { chapterId, pageIndex, totalPages })
  if (state.activeSeries?.id === seriesId) state.activeSeries.readProgress = result.progress
  return result.progress
}

async function batchSetCategories(categories: string[]) {
  if (state.selectedSeriesIds.size === 0) return
  await api.batchSetCategories([...state.selectedSeriesIds], categories)
  state.selectedSeriesIds.clear()
  await loadSeriesList()
}

async function loadDuplicates() {
  const result = await api.getDuplicates()
  state.duplicateGroups = result.groups
}

/** 从重复分组里移除一项；只剩一项的分组不再构成重复，一并丢弃。 */
function removeDuplicateItem(itemId: string) {
  state.duplicateGroups = state.duplicateGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.id !== itemId) }))
    .filter((group) => group.items.length >= 2)
}

async function loadWatcherStatus() {
  state.watcherStatus = await api.getWatcherStatus()
}

async function restartWatcher() {
  const result = await api.restartWatcher()
  state.watcherStatus = result.status
}

function setWatcherStatus(value: WatcherStatus | null) {
  state.watcherStatus = value
}

function setLiveScanState(status: ScanStatus | null, progress: ScanProgress | null) {
  state.liveScanStatus = status
  state.liveScanProgress = status?.running ? progress : null
  if (!status?.running) {
    state.scanning = false
  }
}

function setRealtimeConnected(value: boolean) {
  state.realtimeConnected = value
}

function setDarkMode(value: boolean | null) {
  state.darkMode = value
  if (value === null) {
    localStorage.removeItem('dark-mode')
  } else {
    localStorage.setItem('dark-mode', value ? 'dark' : 'light')
  }
}

function initDarkMode() {
  const saved = localStorage.getItem('dark-mode')
  if (saved === 'dark') state.darkMode = true
  else if (saved === 'light') state.darkMode = false
  else state.darkMode = null
}

async function navigateTo(view: 'library' | 'detail' | 'settings') {
  if (view === 'settings') {
    await router.push('/settings')
    return
  }

  if (view === 'detail' && state.activeSeriesId) {
    await router.push(`/series/${state.activeSeriesId}`)
    return
  }

  await router.push(state.favoritesOnly ? '/favorites' : '/library')
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed
}

async function openSeriesDetail(id: string) {
  state.currentView = 'detail'
  await router.push(`/series/${id}`)
}

async function backToLibrary() {
  state.currentView = 'library'
  state.activeSeriesId = null
  state.activeSeries = null
  await router.push(state.favoritesOnly ? '/favorites' : '/library')
}

async function syncRouteState(route: Pick<RouteLocationNormalizedLoaded, 'name' | 'params'>) {
  if (!state.meta) await refreshAll(true)
  if (route.name === 'settings') {
    state.currentView = 'settings'
    return
  }

  if (route.name === 'favorites') {
    const changed = !state.favoritesOnly || state.currentView !== 'library'
    state.favoritesOnly = true
    state.currentView = 'library'
    if (changed) {
      await loadSeriesList()
    }
    return
  }

  if (route.name === 'series') {
    state.currentView = 'detail'
    const id = String(route.params.id ?? '')
    if (id && state.activeSeriesId !== id) {
      await loadSeriesDetail(id)
    }
    return
  }

  const changed = state.favoritesOnly || state.currentView !== 'library'
  state.favoritesOnly = false
  state.currentView = 'library'
  if (changed) {
    await loadSeriesList()
  }
}

export function useAppState() {
  return {
    // 运行时 readonly() 代理是深层的，仍会拦截任何嵌套写入；
    // 类型只标浅层 Readonly，因为 Vue SFC 编译器无法在 defineProps 里解析 DeepReadonly。
    state: readonly(state) as Readonly<State>,
    refreshAll,
    loadSeriesList,
    loadSeriesDetail,
    restoreActiveDetail,
    runScan,
    saveSettings,
    saveSeriesCategories,
    saveCategoryFolders,
    addCategoryDraft,
    updateCategoryDraft,
    removeCategoryDraft,
    setSearch,
    setCategory,
    setSortBy,
    setSortOrder,
    setPage,
    setPageSize,
    setFavoritesOnly,
    setAdvancedFilters,
    setLayoutMode,
    toggleSelectionMode,
    exitSelectionMode,
    batchSetTags,
    setDarkMode,
    initDarkMode,
    syncCategoryDrafts,
    toggleSeriesSelection,
    clearSelection,
    selectAll,
    toggleFavorite,
    setCustomCover,
    removeCustomCover,
    saveReadProgress,
    batchSetCategories,
    loadDuplicates,
    removeDuplicateItem,
    loadWatcherStatus,
    restartWatcher,
    setWatcherStatus,
    setLiveScanState,
    setRealtimeConnected,
    navigateTo,
    toggleSidebar,
    openSeriesDetail,
    backToLibrary,
    syncRouteState,
  }
}
