package eu.kanade.tachiyomi.extension.all.folderlibrary

import androidx.preference.ListPreference
import androidx.preference.PreferenceScreen
import androidx.preference.SwitchPreferenceCompat
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.model.SMangaUpdate
import keiyoushi.annotation.Source
import keiyoushi.source.KeiSource
import keiyoushi.utils.firstInstanceOrNull
import keiyoushi.utils.getPreferencesLazy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@Source
abstract class FolderLibrary :
    KeiSource(),
    ConfigurableSource {

    private val preferences by getPreferencesLazy()
    private val categoryRefreshInFlight = AtomicBoolean(false)
    private val categoryScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var categoryRefreshAtInMemory = 0L

    private val apiClient: OkHttpClient by lazy {
        // 元数据 API 必须快速失败；图片仍使用 Mihon 主下载客户端，不受此超时影响。
        client.newBuilder()
            .callTimeout(API_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .connectTimeout(API_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(API_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(API_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }

    private val api: FolderLibraryApi by lazy {
        FolderLibraryApi(
            client = apiClient,
            headers = headers,
            baseUrl = { baseUrl },
            pageSize = ::configuredPageSize,
        )
    }

    override suspend fun getPopularManga(page: Int): MangasPage =
        api.series(page = page).toMangasPage()

    override suspend fun getLatestUpdates(page: Int): MangasPage =
        api.series(page = page, sort = "updatedAt", order = "desc").toMangasPage()

    override suspend fun getSearchMangaList(page: Int, query: String, filters: FilterList): MangasPage {
        val category = filters.firstInstanceOrNull<CategoryFilter>()?.selectedCategory
        return api.series(
            page = page,
            search = query.takeIf(String::isNotBlank),
            category = category,
        ).toMangasPage()
    }

    override fun getFilterList(data: JsonElement?): FilterList {
        val categories = readCachedCategories()
        if (isCategoryCacheExpired()) triggerCategoryRefresh()
        return FilterList(CategoryFilter(categories))
    }

    override suspend fun fetchMangaUpdate(
        manga: SManga,
        chapters: List<SChapter>,
        fetchDetails: Boolean,
        fetchChapters: Boolean,
    ): SMangaUpdate {
        // 一次轻量详情请求同时覆盖详情和章节摘要。
        val detail = api.detail(manga.url.substringAfterLast('/'))
        rememberCategories(detail.categories.effective)

        val nextManga = if (fetchDetails) detail.toSManga() else manga
        val nextChapters = if (fetchChapters) detail.toSChapters() else chapters
        return SMangaUpdate(nextManga, nextChapters)
    }

    override suspend fun getPageList(chapter: SChapter): List<Page> {
        val payload = api.chapterPages(chapterIdFromUrl(chapter.url))
        return api.pageImageUrls(payload, configuredReadingMode(), configuredMonoOutput()).mapIndexed { index, imageUrl ->
            Page(index = index, imageUrl = imageUrl)
        }
    }

    override fun getMangaUrl(manga: SManga): String = baseUrl

    override fun getChapterUrl(chapter: SChapter): String = baseUrl

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        ListPreference(screen.context).apply {
            key = PREF_PAGE_SIZE
            title = "每页作品数"
            entries = arrayOf("20（低配）", "40（推荐）", "80")
            entryValues = arrayOf("20", "40", "80")
            setDefaultValue(DEFAULT_PAGE_SIZE.toString())
            summary = "%s"
        }.also(screen::addPreference)

        ListPreference(screen.context).apply {
            key = PREF_READING_MODE
            title = "阅读图片"
            entries = arrayOf("原图", "平衡（1600px / WebP 80）", "省流（1280px / WebP 70）")
            entryValues = arrayOf(READING_ORIGINAL, READING_BALANCED, READING_LITE)
            setDefaultValue(READING_ORIGINAL)
            summary = "%s"
        }.also(screen::addPreference)

        SwitchPreferenceCompat(screen.context).apply {
            key = PREF_MONO_OUTPUT
            title = "墨水屏灰度输出"
            summary = "服务端预先转灰度，设备省去实时去色开销；彩页会变黑白。"
            setDefaultValue(false)
        }.also(screen::addPreference)
    }

    private fun SeriesListResponse.toMangasPage(): MangasPage {
        rememberCategories(items.flatMap { it.categories.effective })
        return MangasPage(
            mangas = items.map(SeriesListItemDto::toSManga),
            hasNextPage = page < totalPages,
        )
    }

    private fun SeriesListItemDto.toSManga(): SManga = SManga.create().apply {
        url = "/api/series/${this@toSManga.id}"
        title = this@toSManga.title
        author = this@toSManga.author
        description = this@toSManga.description
        genre = (categories.effective + tags).distinct().joinToString(", ")
        thumbnail_url = thumbCoverUrl?.let(api::absoluteUrl)
        status = SManga.UNKNOWN
    }

    private fun SeriesDetailDto.toSManga(): SManga = SManga.create().apply {
        url = "/api/series/${this@toSManga.id}"
        title = this@toSManga.title
        author = this@toSManga.author
        description = this@toSManga.description
        genre = (categories.effective + tags).distinct().joinToString(", ")
        thumbnail_url = thumbCoverUrl?.let(api::absoluteUrl)
        status = SManga.UNKNOWN
    }

    private fun SeriesDetailDto.toSChapters(): List<SChapter> {
        var ordinal = 0F
        return volumes.flatMap { volume ->
            volume.chapters.map { chapter ->
                ordinal += 1F
                SChapter.create().apply {
                    url = "/api/chapters/${chapter.id}/pages"
                    name = chapter.title
                    scanlator = volume.title.takeUnless { volume.synthetic || it.isBlank() }
                    chapter_number = ordinal
                }
            }
        }.asReversed()
    }

    private fun configuredPageSize(): Int = preferences
        .getString(PREF_PAGE_SIZE, DEFAULT_PAGE_SIZE.toString())
        ?.toIntOrNull()
        ?.takeIf { it in ALLOWED_PAGE_SIZES }
        ?: DEFAULT_PAGE_SIZE

    private fun configuredReadingMode(): String = preferences
        .getString(PREF_READING_MODE, READING_ORIGINAL)
        ?.takeIf { it in ALLOWED_READING_MODES }
        ?: READING_ORIGINAL

    private fun configuredMonoOutput(): Boolean = preferences.getBoolean(PREF_MONO_OUTPUT, false)

    private fun triggerCategoryRefresh() {
        if (!categoryRefreshInFlight.compareAndSet(false, true)) return

        categoryScope.launch {
            try {
                val next = normalizeCategories(api.categories().items)
                val previous = readCachedCategories()
                val now = System.currentTimeMillis()
                categoryRefreshAtInMemory = now

                // 内容不变时不触发 SharedPreferences 磁盘写入。
                if (shouldPersistCategoryCache(next, previous, cachedCategoryBaseUrl(), baseUrl)) {
                    persistCategories(next, now)
                }
            } catch (_: Exception) {
                // 旧缓存继续可用；下一次过期检查会再次尝试。
            } finally {
                categoryRefreshInFlight.set(false)
            }
        }
    }

    private fun rememberCategories(values: List<String>) {
        if (values.isEmpty()) return
        val previous = readCachedCategories()
        val merged = normalizeCategories(previous + values)
        if (shouldPersistCategoryCache(merged, previous, cachedCategoryBaseUrl(), baseUrl)) {
            persistCategories(merged, System.currentTimeMillis())
        }
    }

    private fun readCachedCategories(): List<String> {
        if (cachedCategoryBaseUrl() != baseUrl) return emptyList()
        val raw = preferences.getString(PREF_CATEGORY_VALUES, null).orEmpty()
        if (raw.isBlank()) return emptyList()

        return try {
            normalizeCategories(JSON.decodeFromString(ListSerializer(String.serializer()), raw))
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun persistCategories(values: List<String>, fetchedAt: Long) {
        val encoded = JSON.encodeToString(
            ListSerializer(String.serializer()),
            normalizeCategories(values),
        )
        preferences.edit()
            .putString(PREF_CATEGORY_BASE_URL, baseUrl)
            .putString(PREF_CATEGORY_VALUES, encoded)
            .putLong(PREF_CATEGORY_FETCHED_AT, fetchedAt)
            .apply()
    }

    private fun cachedCategoryBaseUrl(): String? = preferences.getString(PREF_CATEGORY_BASE_URL, null)

    private fun isCategoryCacheExpired(): Boolean {
        if (cachedCategoryBaseUrl() != baseUrl) return true
        val persistedAt = preferences.getLong(PREF_CATEGORY_FETCHED_AT, 0L)
        val freshestAt = maxOf(persistedAt, categoryRefreshAtInMemory)
        return freshestAt <= 0L || System.currentTimeMillis() - freshestAt >= CATEGORY_CACHE_TTL_MS
    }

    private fun normalizeCategories(values: List<String>): List<String> = values
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinctBy { it.lowercase() }
        .sortedWith(String.CASE_INSENSITIVE_ORDER)

    private class CategoryFilter(categories: List<String>) : Filter.Select<String>(
        name = "分类",
        values = (listOf(ALL_CATEGORIES) + categories).toTypedArray(),
    ) {
        val selectedCategory: String?
            get() = values.getOrNull(state)?.takeUnless { it == ALL_CATEGORIES }
    }

    companion object {
        private val JSON = Json { ignoreUnknownKeys = true }
        private val ALLOWED_PAGE_SIZES = setOf(20, 40, 80)
        private val ALLOWED_READING_MODES = setOf(READING_ORIGINAL, READING_BALANCED, READING_LITE)

        private const val PREF_PAGE_SIZE = "page_size"
        private const val PREF_READING_MODE = "reading_mode"
        private const val PREF_MONO_OUTPUT = "mono_output"
        private const val PREF_CATEGORY_BASE_URL = "category_cache_base_url"
        private const val PREF_CATEGORY_VALUES = "category_cache_values"
        private const val PREF_CATEGORY_FETCHED_AT = "category_cache_fetched_at"
        private const val DEFAULT_PAGE_SIZE = 40
        private const val ALL_CATEGORIES = "全部"
        private const val API_TIMEOUT_SECONDS = 15L
        private const val CATEGORY_CACHE_TTL_MS = 10 * 60 * 1_000L
    }
}

internal fun shouldPersistCategoryCache(
    next: List<String>,
    previous: List<String>,
    cachedBaseUrl: String?,
    currentBaseUrl: String,
): Boolean = next != previous || cachedBaseUrl != currentBaseUrl
