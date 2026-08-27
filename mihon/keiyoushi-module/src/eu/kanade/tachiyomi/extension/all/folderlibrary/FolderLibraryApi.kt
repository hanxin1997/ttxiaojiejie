package eu.kanade.tachiyomi.extension.all.folderlibrary

import keiyoushi.network.get
import keiyoushi.utils.parseAs
import okhttp3.CacheControl
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

/** 可独立测试的轻量 API 门面；所有请求都可随调用协程取消。 */
internal class FolderLibraryApi(
    private val client: OkHttpClient,
    private val headers: Headers,
    private val baseUrl: () -> String,
    private val pageSize: () -> Int,
) {
    suspend fun series(
        page: Int,
        search: String? = null,
        category: String? = null,
        sort: String = "title",
        order: String = "asc",
    ): SeriesListResponse {
        val url = absoluteUrl("/api/series").toHttpUrl().newBuilder()
            .addQueryParameter("page", page.coerceAtLeast(1).toString())
            .addQueryParameter("pageSize", pageSize().toString())
            .addQueryParameter("sort", sort)
            .addQueryParameter("order", order)
            .apply {
                search?.trim()?.takeIf(String::isNotEmpty)?.let { addQueryParameter("search", it) }
                category?.trim()?.takeIf(String::isNotEmpty)?.let { addQueryParameter("category", it) }
            }
            .build()

        return client.get(url, headers, CacheControl.FORCE_NETWORK).parseAs()
    }

    suspend fun detail(seriesId: String): SeriesDetailDto =
        client.get(absoluteUrl("/api/series/$seriesId"), headers, CacheControl.FORCE_NETWORK).parseAs()

    suspend fun chapterPages(chapterId: String): ChapterPagesDto =
        client.get(absoluteUrl("/api/chapters/$chapterId/pages"), headers, CacheControl.FORCE_NETWORK).parseAs()

    suspend fun categories(): CategoriesResponse =
        client.get(absoluteUrl("/api/categories"), headers, CacheControl.FORCE_NETWORK).parseAs()

    fun pageImageUrls(payload: ChapterPagesDto, readingMode: String, mono: Boolean): List<String> {
        val variant = resolveVariant(readingMode, mono)

        return (1..payload.pageCount).map { pageIndex ->
            val original = absoluteUrl(payload.urlTemplate.replace("{pageIndex}", pageIndex.toString()))
            if (variant == null) {
                original
            } else {
                original.toHttpUrl().newBuilder()
                    .addQueryParameter("variant", variant)
                    .build()
                    .toString()
            }
        }
    }

    /** 灰度与分辨率档正交：手机可关灰度，墨水屏开灰度，两者共用同一份插件。 */
    private fun resolveVariant(readingMode: String, mono: Boolean): String? {
        val scaled = when (readingMode) {
            READING_BALANCED -> "reader-balanced"
            READING_LITE -> "reader-lite"
            else -> null
        }

        if (!mono) return scaled
        // 原图档开灰度时仍要服务端去色，只是不缩放。
        return if (scaled == null) "reader-mono" else "$scaled-mono"
    }

    fun absoluteUrl(url: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        return "${baseUrl().trimEnd('/')}/${url.trimStart('/')}"
    }
}

internal const val READING_ORIGINAL = "original"
internal const val READING_BALANCED = "balanced"
internal const val READING_LITE = "lite"

internal fun chapterIdFromUrl(url: String): String = url
    .trimEnd('/')
    .substringBeforeLast('/')
    .substringAfterLast('/')
