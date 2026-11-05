package eu.kanade.tachiyomi.extension.all.folderlibrary

internal data class ReaderPreferences(
    val pageSize: Int,
    val readingMode: String,
    val mono: Boolean,
)

/** Apply the preset at read time so disabling it restores every existing user preference. */
internal fun resolveReaderPreferences(
    einkPreset: Boolean,
    savedPageSize: String?,
    savedReadingMode: String?,
    savedMono: Boolean,
): ReaderPreferences {
    if (einkPreset) return ReaderPreferences(20, READING_LITE, true)
    return ReaderPreferences(
        pageSize = savedPageSize?.toIntOrNull()?.takeIf { it in setOf(20, 40, 80) } ?: 40,
        readingMode = savedReadingMode?.takeIf { it in setOf(READING_ORIGINAL, READING_BALANCED, READING_LITE) } ?: READING_ORIGINAL,
        mono = savedMono,
    )
}
