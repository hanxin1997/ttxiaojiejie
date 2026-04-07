plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "eu.kanade.tachiyomi.extension.all.folderlibrary"
    compileSdk = 36

    defaultConfig {
        applicationId = "eu.kanade.tachiyomi.extension.all.folderlibrary"
        minSdk = 21
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        manifestPlaceholders["appName"] = "Mihon: Folder Library"
        manifestPlaceholders["extClass"] = ".FolderLibrarySourceFactory"
        manifestPlaceholders["nsfw"] = 0
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        jvmToolchain(17)
    }

    packaging {
        resources {
            excludes += "kotlin-tooling-metadata.json"
            excludes += "META-INF/AL2.0"
            excludes += "META-INF/LGPL2.1"
        }
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    compileOnly("com.github.keiyoushi:extensions-lib:v1.4.2.1")
    compileOnly("org.jetbrains.kotlin:kotlin-stdlib-jdk8:2.3.0")
    compileOnly("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    compileOnly("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    compileOnly("com.github.null2264.injekt:injekt-core:4135455a2a")
    compileOnly("io.reactivex:rxjava:1.3.8")
    compileOnly("org.jsoup:jsoup:1.22.1")
    compileOnly("com.squareup.okhttp3:okhttp:5.3.2")
}
