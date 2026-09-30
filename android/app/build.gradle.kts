import java.util.Properties

plugins {
  id("com.android.application")
}

val keystoreProps = Properties().apply {
  val file = file("keystore.properties")
  if (file.exists()) file.inputStream().use { load(it) }
}

android {
  namespace = "com.rbcode.mobile"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.rbowo.code"
    minSdk = 30
    // 注意：必须是 28。Android 10（API 29）起，targetSdk >= 29 的 App 不允许执行
    // 自己私有目录里的可执行文件（W^X），proot 就会 Permission denied（error=13）。
    // 降到 28 后系统按旧策略放行 —— Termux / UserLAnd / Andronix 都是这么做的。
    targetSdk = 28
    versionCode = 1
    versionName = "1.0.0"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  signingConfigs {
    create("release") {
      if (keystoreProps.getProperty("storeFile") != null) {
        storeFile = file(keystoreProps.getProperty("storeFile"))
        storePassword = keystoreProps.getProperty("storePassword")
        keyAlias = keystoreProps.getProperty("keyAlias")
        keyPassword = keystoreProps.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      if (keystoreProps.getProperty("storeFile") != null) {
        signingConfig = signingConfigs.getByName("release")
      }
    }
  }

  lint {
    // 故意把 targetSdk 停在 28（proot 需要；见 defaultConfig 注释），别为此报错
    disable += "ExpiredTargetSdkVersion"
    checkReleaseBuilds = false
  }

  // Ubuntu rootfs 是 .txz（已压缩）；别让 aapt 再压一遍
  androidResources {
    noCompress += "txz"
  }
}

dependencies {
  // 解压 xz 压缩的 rootfs（系统的 toybox 不保证带 xz 命令）
  implementation("org.tukaani:xz:1.10")
}

// 手机版不内置网页前端（前端部署到别处，手机连本机后端 127.0.0.1:7717）。
// 后端只提供一个「访问成功」说明页（见 HttpServer.serveLanding）。
