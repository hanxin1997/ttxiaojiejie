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

// 底座用通用 ksp 配置注册 SourceProcessor，kei_sources 又是全局参数，所以单元测试编译单元
// 也会跑一遍处理器；但它的 resolver 只看得见 test/，那里结构上不可能有 @Source，处理器就会
// 报 "source {} blocks present but no @Source class found"。源注册只对生产编译有意义，测试
// 靠主变体的产物拿到生成代码，这里直接停掉测试编译单元的 KSP。
tasks.matching { it.name.startsWith("ksp") && it.name.contains("UnitTest") }.configureEach {
    enabled = false
}

dependencies {
    // 官方扩展把宿主 API 与 common 设为 compileOnly；JVM 测试必须显式补齐运行时。
    testImplementation(libs.bundles.common)
    testImplementation(libs.tachiyomi.lib.v16)
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.4.0")
}
