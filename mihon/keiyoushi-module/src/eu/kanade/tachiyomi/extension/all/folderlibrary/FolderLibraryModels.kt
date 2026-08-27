package eu.kanade.tachiyomi.extension.all.folderlibrary

import kotlinx.serialization.Serializable

// 仅保留 Mihon 实际消费的字段，避免低配设备解析无用的服务端数据。
@Serializable
class SeriesListResponse(
    val items: List<SeriesListItemDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 40,
    val totalPages: Int = 0,
    val revision: Long = 0,
)

@Serializable
class SeriesListItemDto(
    val id: String,
    val title: String,
    val author: String? = null,
    val description: String? = null,
    val thumbCoverUrl: String? = null,
    val counts: CountsDto = CountsDto(),
    val categories: CategoriesDto = CategoriesDto(),
    val tags: List<String> = emptyList(),
)

@Serializable
class SeriesDetailDto(
    val id: String,
    val title: String,
    val author: String? = null,
    val description: String? = null,
    val thumbCoverUrl: String? = null,
    val counts: CountsDto = CountsDto(),
    val categories: CategoriesDto = CategoriesDto(),
    val tags: List<String> = emptyList(),
    val volumes: List<VolumeDto> = emptyList(),
)

@Serializable
class VolumeDto(
    val id: String,
    val title: String = "",
    val synthetic: Boolean = false,
    val chapters: List<ChapterDto> = emptyList(),
)

@Serializable
class ChapterDto(
    val id: String,
    val title: String,
    val pageCount: Int = 0,
)

@Serializable
class ChapterPagesDto(
    val chapterId: String,
    val pageCount: Int = 0,
    val urlTemplate: String,
)

@Serializable
class CategoriesResponse(
    val items: List<String> = emptyList(),
    val revision: Long = 0,
)

@Serializable
class CountsDto(
    val volumes: Int = 0,
    val chapters: Int = 0,
    val pages: Int = 0,
)

@Serializable
class CategoriesDto(
    val effective: List<String> = emptyList(),
)
