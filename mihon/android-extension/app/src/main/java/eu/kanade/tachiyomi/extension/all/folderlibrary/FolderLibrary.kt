package eu.kanade.tachiyomi.extension.all.folderlibrary

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.text.InputType
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.Preference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.serialization.json.Json
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import uy.kohesive.injekt.Injekt

class FolderLibrary : HttpSource(), ConfigurableSource {

    private val preferences: SharedPreferences by lazy {
        val app = Injekt.get<Application>()
        app.getSharedPreferences("source_$id", Context.MODE_PRIVATE)
    }

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private val configuredBaseUrl: String
        get() = preferences
            .getString(PREF_SERVER_ADDRESS, DEFAULT_SERVER_ADDRESS)
            .orEmpty()
            .trim()
            .removeSuffix("/")

    override val baseUrl: String
        get() = configuredBaseUrl.ifBlank { DEFAULT_SERVER_ADDRESS }

    override val lang: String = "all"

    override val name: String = "Folder Library"

    override val supportsLatest: Boolean = true

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("Accept", "application/json, text/plain, */*")

    override fun popularMangaRequest(page: Int): Request = GET(buildSeriesUrl(), headers)

    override fun popularMangaParse(response: Response): MangasPage = parseSeriesList(response)

    override fun latestUpdatesRequest(page: Int): Request = GET(buildSeriesUrl(), headers)

    override fun latestUpdatesParse(response: Response): MangasPage = parseSeriesList(response)

    override fun searchMangaRequest(page: Int, query: String, filters: eu.kanade.tachiyomi.source.model.FilterList): Request {
        return GET(buildSeriesUrl(query.takeIf { it.isNotBlank() }), headers)
    }

    override fun searchMangaParse(response: Response): MangasPage = parseSeriesList(response)

    override fun getMangaUrl(manga: SManga): String = baseUrl

    override fun mangaDetailsRequest(manga: SManga): Request = GET(toAbsoluteUrl(manga.url), headers)

    override fun mangaDetailsParse(response: Response): SManga {
        val detail = response.parseAs<SeriesDetailDto>()
        return detail.toSManga(baseUrl)
    }

    override fun chapterListRequest(manga: SManga): Request = GET(toAbsoluteUrl(manga.url), headers)

    override fun chapterListParse(response: Response): List<SChapter> {
        val detail = response.parseAs<SeriesDetailDto>()
        var chapterNumber = 1F

        return detail.volumes.flatMap { volume ->
            volume.chapters.map { chapter ->
                SChapter.create().apply {
                    url = createChapterToken(detail.id, chapter.id)
                    name = chapter.title
                    scanlator = volume.title
                    chapter_number = chapterNumber++
                }
            }
        }
    }

    override fun getChapterUrl(chapter: SChapter): String = baseUrl

    override fun pageListRequest(chapter: SChapter): Request {
        val token = parseChapterToken(chapter.url)
        return GET(
            toAbsoluteUrl("/api/series/${token.seriesId}"),
            headers.newBuilder().add(CHAPTER_ID_HEADER, token.chapterId).build(),
        )
    }

    override fun pageListParse(response: Response): List<Page> {
        val chapterId = response.request.header(CHAPTER_ID_HEADER)
            ?: throw IllegalStateException("Missing chapter id")
        val detail = response.parseAs<SeriesDetailDto>()
        val chapter = detail.volumes
            .flatMap { it.chapters }
            .firstOrNull { it.id == chapterId }
            ?: throw IllegalStateException("Chapter not found: $chapterId")

        return chapter.pageUrls.mapIndexed { index, pageUrl ->
            Page(index, imageUrl = toAbsoluteUrl(pageUrl))
        }
    }

    override fun imageUrlParse(response: Response): String = throw UnsupportedOperationException()

    override fun imageRequest(page: Page): Request = GET(page.imageUrl!!, headers)

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val addressPreference = EditTextPreference(screen.context).apply {
            key = PREF_SERVER_ADDRESS
            title = "服务器地址"
            summary = configuredBaseUrl.ifBlank { "例如：http://192.168.1.20:4321" }
            text = configuredBaseUrl.ifBlank { DEFAULT_SERVER_ADDRESS }
            setOnBindEditTextListener { editText ->
                editText.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                editText.hint = DEFAULT_SERVER_ADDRESS
            }
            setOnPreferenceChangeListener { preference, newValue ->
                val normalized = newValue
                    ?.toString()
                    .orEmpty()
                    .trim()
                    .removeSuffix("/")

                if (normalized.toHttpUrlOrNull() == null) {
                    Toast.makeText(preference.context, "服务器地址格式无效", Toast.LENGTH_LONG).show()
                    false
                } else {
                    preference.summary = normalized
                    Toast.makeText(preference.context, "重启 Mihon 后生效", Toast.LENGTH_LONG).show()
                    true
                }
            }
        }

        val helpPreference = Preference(screen.context).apply {
            title = "接口要求"
            summary = "服务端需要提供 /api/series、/api/series/:id 和 /media/* 接口。"
            isSelectable = false
        }

        screen.addPreference(addressPreference)
        screen.addPreference(helpPreference)
    }

    private fun buildSeriesUrl(query: String? = null): String {
        val builder = toAbsoluteUrl("/api/series").toHttpUrl().newBuilder()
        if (!query.isNullOrBlank()) {
            builder.addQueryParameter("search", query)
        }
        return builder.build().toString()
    }

    private fun toAbsoluteUrl(url: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url
        }

        val cleanPath = if (url.startsWith("/")) url else "/$url"
        return "$baseUrl$cleanPath"
    }

    private inline fun <reified T> Response.parseAs(): T = json.decodeFromString(body.string())

    private fun SeriesListItemDto.toSManga(baseUrl: String): SManga = SManga.create().apply {
        title = this@toSManga.title
        url = "/api/series/${this@toSManga.id}"
        thumbnail_url = coverUrl?.let { absoluteUrl(baseUrl, it) }
        genre = categories.effective.joinToString(", ")
        description = buildString {
            appendLine("源目录: $sourceKey")
            appendLine("原目录名: $sourceFolderName")
            appendLine("卷数: ${counts.volumes}")
            appendLine("章节: ${counts.chapters}")
            append("图片: ${counts.pages}")
        }
        status = SManga.UNKNOWN
    }

    private fun SeriesDetailDto.toSManga(baseUrl: String): SManga = SManga.create().apply {
        title = this@toSManga.title
        url = "/api/series/${this@toSManga.id}"
        thumbnail_url = coverUrl?.let { absoluteUrl(baseUrl, it) }
        genre = categories.effective.joinToString(", ")
        author = categories.folder.joinToString(", ").ifBlank { null }
        artist = categories.manual.joinToString(", ").ifBlank { null }
        description = buildString {
            appendLine("源目录: $sourceKey")
            appendLine("实际路径: $sourcePath")
            appendLine("卷数: ${counts.volumes}")
            appendLine("章节: ${counts.chapters}")
            appendLine("图片: ${counts.pages}")
            if (categories.auto.isNotEmpty()) appendLine("目录名分类: ${categories.auto.joinToString(" / ")}")
            if (categories.folder.isNotEmpty()) appendLine("目录绑定分类: ${categories.folder.joinToString(" / ")}")
            if (categories.manual.isNotEmpty()) appendLine("手动分类: ${categories.manual.joinToString(" / ")}")
        }.trim()
        status = SManga.UNKNOWN
    }

    private fun absoluteUrl(baseUrl: String, url: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url
        }
        return if (url.startsWith("/")) "$baseUrl$url" else "$baseUrl/$url"
    }

    private fun createChapterToken(seriesId: String, chapterId: String): String = "folderlibrary://$seriesId/$chapterId"

    private fun parseChapterToken(value: String): ChapterToken {
        val prefix = "folderlibrary://"
        require(value.startsWith(prefix)) { "Invalid chapter token: $value" }
        val payload = value.removePrefix(prefix)
        val separatorIndex = payload.indexOf('/')
        require(separatorIndex > 0 && separatorIndex < payload.lastIndex) { "Invalid chapter token: $value" }
        return ChapterToken(
            seriesId = payload.substring(0, separatorIndex),
            chapterId = payload.substring(separatorIndex + 1),
        )
    }

    private data class ChapterToken(
        val seriesId: String,
        val chapterId: String,
    )

    companion object {
        private const val PREF_SERVER_ADDRESS = "server_address"
        private const val DEFAULT_SERVER_ADDRESS = "http://127.0.0.1:4321"
        private const val CHAPTER_ID_HEADER = "X-Folder-Library-Chapter-Id"
    }
}
