package eu.kanade.tachiyomi.extension.all.folderlibrary

import org.junit.Assert.assertEquals
import org.junit.Test

class FolderLibraryPreferencesTest {
    @Test
    fun `preset uses small pages and server grayscale without changing saved choices`() {
        assertEquals(ReaderPreferences(20, READING_LITE, true), resolveReaderPreferences(true, "80", READING_ORIGINAL, false))
        assertEquals(ReaderPreferences(80, READING_ORIGINAL, false), resolveReaderPreferences(false, "80", READING_ORIGINAL, false))
        assertEquals(ReaderPreferences(40, READING_BALANCED, true), resolveReaderPreferences(false, "40", READING_BALANCED, true))
    }

    @Test
    fun `new users and invalid values retain original quality and default pagination`() {
        assertEquals(ReaderPreferences(40, READING_ORIGINAL, false), resolveReaderPreferences(false, null, null, false))
        assertEquals(ReaderPreferences(40, READING_ORIGINAL, false), resolveReaderPreferences(false, "999", "unknown", false))
    }
}
