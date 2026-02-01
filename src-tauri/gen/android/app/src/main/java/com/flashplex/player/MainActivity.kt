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

  override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
    if (keyCode == android.view.KeyEvent.KEYCODE_BACK) {
      // Intercept back button to prevent app exit. 
      // JavaScript will handle the back event via setupRemoteNavigation.
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  // Also override onBackPressed for modern Android versions
  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    // Do nothing - let JS handle navigation
    // This prevents the system from finishing the activity
  }
}
