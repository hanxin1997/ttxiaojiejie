package eu.kanade.tachiyomi.extension.all.folderlibrary

import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.okio.decodeFromBufferedSource
import okhttp3.CacheControl
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// 不用 keiyoushi.utils.jsonInstance：那是 Injekt.get()，只有宿主进程注册过实例。
// 服务端字段只增不减，忽略未知键即可向前兼容。
private val json = Json { ignoreUnknownKeys = true }

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

        return getJson(url, SeriesListResponse.serializer())
    }

    suspend fun detail(seriesId: String): SeriesDetailDto = getJson(apiUrl("/api/series/$seriesId"), SeriesDetailDto.serializer())

    suspend fun chapterPages(chapterId: String): ChapterPagesDto = getJson(apiUrl("/api/chapters/$chapterId/pages"), ChapterPagesDto.serializer())

    suspend fun categories(): CategoriesResponse = getJson(apiUrl("/api/categories"), CategoriesResponse.serializer())

    private fun apiUrl(path: String): HttpUrl = absoluteUrl(path).toHttpUrl()

    /**
     * 不走宿主的 keiyoushi.network.get：那条路以 Call.awaitSuccess() 结尾，而 extensions-lib
     * 是桩（`throw Exception("Stub!")`），真实现只存在于 Mihon 进程里，JVM 测试连不上。
     * 这里用 enqueue + suspendCancellableCoroutine 自己挂起，取消语义自己可控：协程取消即
     * call.cancel()，OkHttp 会连带拆掉响应体，不会漏连接。
     */
    private suspend fun <T> getJson(url: HttpUrl, deserializer: DeserializationStrategy<T>): T {
        val request = Request.Builder()
            .url(url)
            .headers(headers)
            .cacheControl(CacheControl.FORCE_NETWORK)
            .build()
        val call = client.newCall(request)

        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(ParseOnResponse(continuation, deserializer))
        }
    }

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

/**
 * 独立成类而不是匿名对象：匿名 Callback 会把调用处的缩进压到 6 层。
 *
 * body 在 OkHttp 的回调线程上读完、解析完才 resume。这样整个读取期间协程都还挂着，
 * invokeOnCancellation 一直有效，读 body 途中取消也能立刻拆掉 socket——响应头一到就
 * resume 的写法做不到这点：那之后是阻塞读，没有挂起点，取消要等读完才生效。
 */
private class ParseOnResponse<T>(
    private val continuation: CancellableContinuation<T>,
    private val deserializer: DeserializationStrategy<T>,
) : Callback {
    override fun onResponse(call: Call, response: Response) {
        if (!response.isSuccessful) {
            response.close()
            continuation.resumeWithException(IOException("HTTP ${response.code} for ${call.request().url}"))
            return
        }

        // 异常绝不能逃进 OkHttp 的回调线程，否则会被吞掉、协程永远挂死。
        val parsed = try {
            response.use { json.decodeFromBufferedSource(deserializer, it.body.source()) }
        } catch (e: Throwable) {
            continuation.resumeWithException(e)
            return
        }
        continuation.resume(parsed)
    }

    // 取消引发的 onFailure 不必再抛：continuation 已经因取消结束。
    override fun onFailure(call: Call, e: IOException) {
        if (!continuation.isCancelled) continuation.resumeWithException(e)
    }
}

internal const val READING_ORIGINAL = "original"
internal const val READING_BALANCED = "balanced"
internal const val READING_LITE = "lite"

internal fun chapterIdFromUrl(url: String): String = url
    .trimEnd('/')
    .substringBeforeLast('/')
    .substringAfterLast('/')
