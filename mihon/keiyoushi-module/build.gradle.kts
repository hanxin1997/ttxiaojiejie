import io.github.keiyoushi.gradle.api.ContentWarning

plugins {
    alias(kei.plugins.extension)
}

keiyoushi {
    name = "Folder Library"
    versionCode = 4
    contentWarning = ContentWarning.SAFE
    libVersion = "1.6"

    source {
        lang = "all"
        baseUrl {
            custom("http://127.0.0.1:4321")
        }
    }
}

android {
    sourceSets.getByName("test").apply {
        java.srcDir("test")
        kotlin.srcDir("test")
    }
}

dependencies {
    // 官方扩展把宿主 API 与 common 设为 compileOnly；JVM 测试必须显式补齐运行时。
    testImplementation(libs.bundles.common)
    testImplementation(libs.tachiyomi.lib.v16)
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.4.0")
}
