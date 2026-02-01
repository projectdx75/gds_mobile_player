package com.flashplex.player

import android.os.Bundle
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun openExoPlayer(title: String, url: String) {
        val intent = Intent(this@MainActivity, PlayerActivity::class.java)
        intent.putExtra("VIDEO_TITLE", title)
        intent.putExtra("VIDEO_URL", url)
        startActivity(intent)
      }

      @JavascriptInterface
      fun listAndroidFiles(path: String): String {
        return try {
          val file = File(path)
          file.list()?.joinToString("|") ?: ""
        } catch (e: Exception) {
          ""
        }
      }
    }, "PlayerBridge")
  }
}
