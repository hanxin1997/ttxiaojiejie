package eu.kanade.tachiyomi.extension.all.folderlibrary

import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory

class FolderLibrarySourceFactory : SourceFactory {
    override fun createSources(): List<Source> = listOf(FolderLibrary())
}
