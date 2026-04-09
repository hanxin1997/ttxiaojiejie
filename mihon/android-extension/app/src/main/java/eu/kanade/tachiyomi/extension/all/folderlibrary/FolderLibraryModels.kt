package eu.kanade.tachiyomi.extension.all.folderlibrary

import kotlinx.serialization.Serializable

@Serializable
data class SeriesListResponse(
    val items: List<SeriesListItemDto> = emptyList(),
    val total: Int = 0,
)

@Serializable
data class SeriesListItemDto(
    val id: String,
    val title: String,
    val sourceFolderName: String = "",
    val sourceKey: String = "",
    val counts: CountsDto = CountsDto(),
    val categories: CategoriesDto = CategoriesDto(),
    val coverUrl: String? = null,
    val latestChapterTitle: String = "",
)

@Serializable
data class SeriesDetailDto(
    val id: String,
    val title: String,
    val sourceFolderName: String = "",
    val sourceKey: String = "",
    val sourcePath: String = "",
    val counts: CountsDto = CountsDto(),
    val categories: CategoriesDto = CategoriesDto(),
    val coverUrl: String? = null,
    val volumes: List<VolumeDto> = emptyList(),
)

@Serializable
data class VolumeDto(
    val id: String,
    val title: String,
    val sourcePath: String = "",
    val synthetic: Boolean = false,
    val chapters: List<ChapterDto> = emptyList(),
)

@Serializable
data class ChapterDto(
    val id: String,
    val title: String,
    val sourcePath: String = "",
    val pageCount: Int = 0,
    val pageUrls: List<String> = emptyList(),
    val firstPageUrl: String? = null,
)

@Serializable
data class CountsDto(
    val volumes: Int = 0,
    val chapters: Int = 0,
    val pages: Int = 0,
)

@Serializable
data class CategoriesDto(
    val auto: List<String> = emptyList(),
    val folder: List<String> = emptyList(),
    val manual: List<String> = emptyList(),
    val effective: List<String> = emptyList(),
)

@Serializable
data class StatePayloadDto(
    val knownCategories: List<String> = emptyList(),
)
