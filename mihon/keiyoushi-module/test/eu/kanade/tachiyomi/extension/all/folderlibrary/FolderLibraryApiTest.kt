package eu.kanade.tachiyomi.extension.all.folderlibrary

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.Headers.Companion.headersOf
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

class FolderLibraryApiTest {
    private val server = MockWebServer()
    private val api = FolderLibraryApi(
        client = OkHttpClient(),
        headers = headersOf("Accept", "application/json"),
        baseUrl = { server.url("/").toString().trimEnd('/') },
        pageSize = { 40 },
    )

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `series forwards pagination search category and computes next page`() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"items":[{"id":"series-1","title":"Alpha","thumbCoverUrl":"/media/cover/series-1?variant=cover","ignored":"small-dto"}],"total":81,"page":2,"pageSize":40,"totalPages":3,"revision":1}""",
                ),
        )

        val response = api.series(page = 2, search = "alpha", category = "Action")
        val request = server.takeRequest()

        assertEquals(2, response.page)
        assertEquals(3, response.totalPages)
        assertEquals("Alpha", response.items.single().title)
        assertTrue(response.items.single().thumbCoverUrl!!.endsWith("variant=cover"))
        assertEquals("2", request.requestUrl?.queryParameter("page"))
        assertEquals("40", request.requestUrl?.queryParameter("pageSize"))
        assertEquals("alpha", request.requestUrl?.queryParameter("search"))
        assertEquals("Action", request.requestUrl?.queryParameter("category"))
    }

    @Test
    fun `chapter endpoint stays lightweight and expands fixed image modes`() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"chapterId":"chapter-1","pageCount":2,"urlTemplate":"/media/chapter/chapter-1/{pageIndex}"}"""),
        )

        val payload = api.chapterPages("chapter-1")
        assertEquals("/api/chapters/chapter-1/pages", server.takeRequest().requestUrl?.encodedPath)

        val original = api.pageImageUrls(payload, READING_ORIGINAL, mono = false)
        val balanced = api.pageImageUrls(payload, READING_BALANCED, mono = false)
        val lite = api.pageImageUrls(payload, READING_LITE, mono = false)

        assertEquals(2, original.size)
        assertFalse(original.first().contains("variant="))
        assertTrue(balanced.first().endsWith("variant=reader-balanced"))
        assertTrue(lite.first().endsWith("variant=reader-lite"))

        // 灰度开关与分辨率档正交：三档各自映射到独立的服务端墨水屏变体。
        val originalMono = api.pageImageUrls(payload, READING_ORIGINAL, mono = true)
        val balancedMono = api.pageImageUrls(payload, READING_BALANCED, mono = true)
        val liteMono = api.pageImageUrls(payload, READING_LITE, mono = true)

        assertTrue(originalMono.first().endsWith("variant=reader-mono"))
        assertTrue(balancedMono.first().endsWith("variant=reader-balanced-mono"))
        assertTrue(liteMono.first().endsWith("variant=reader-lite-mono"))
        assertEquals("chapter-1", chapterIdFromUrl("/api/chapters/chapter-1/pages"))
    }

    @Test
    fun `api timeout interrupts a stalled lightweight response`() = runBlocking {
        val timeoutApi = FolderLibraryApi(
            client = OkHttpClient.Builder().callTimeout(50, TimeUnit.MILLISECONDS).build(),
            headers = headersOf("Accept", "application/json"),
            baseUrl = { server.url("/").toString().trimEnd('/') },
            pageSize = { 40 },
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBodyDelay(5, TimeUnit.SECONDS)
                .setBody("""{"items":[],"revision":1}"""),
        )

        val startedAt = System.nanoTime()
        try {
            timeoutApi.categories()
            fail("stalled API response should time out")
        } catch (_: IOException) {
            // Expected: the dedicated metadata client has a finite call timeout.
        }
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
        assertTrue("timeout should fail quickly", elapsedMs < 1_000)
    }

    @Test
    fun `suspend API request is cancelled with its coroutine`() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBodyDelay(5, TimeUnit.SECONDS)
                .setBody("""{"items":[],"revision":1}"""),
        )

        val request = launch(Dispatchers.IO) { api.categories() }
        assertNotNull(server.takeRequest(1, TimeUnit.SECONDS))
        request.cancelAndJoin()
        assertTrue(request.isCancelled)
    }

    @Test
    fun `unchanged category cache avoids SharedPreferences writes`() {
        val categories = listOf("Action", "Drama")

        assertFalse(shouldPersistCategoryCache(categories, categories, "http://server", "http://server"))
        assertTrue(shouldPersistCategoryCache(categories + "Mystery", categories, "http://server", "http://server"))
        assertTrue(shouldPersistCategoryCache(categories, categories, "http://old", "http://server"))
    }
}
