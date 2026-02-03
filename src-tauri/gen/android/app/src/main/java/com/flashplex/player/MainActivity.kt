package com.flashplex.player

import android.os.Bundle
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import java.io.File

class MainActivity : TauriActivity() {
  private var mainWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.mainWebView = webView
    
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun openExoPlayer(title: String, url: String, subtitleUrl: String?, subtitleSize: Double, subtitlePos: Double) {
        val intent = Intent(this@MainActivity, PlayerActivity::class.java)
        intent.putExtra("VIDEO_TITLE", title)
        intent.putExtra("VIDEO_URL", url)
        intent.putExtra("SUBTITLE_URL", subtitleUrl)
        intent.putExtra("SUBTITLE_SIZE", subtitleSize.toFloat())
        intent.putExtra("SUBTITLE_POS", subtitlePos.toFloat())
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
      // Direct call to JS for centralized navigation control
      mainWebView?.evaluateJavascript("if(window.handleAndroidBack) { window.handleAndroidBack(); } else { console.log('handeback missing'); }", null)
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  // Also override onBackPressed for modern Android versions
  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    mainWebView?.evaluateJavascript("if(window.handleAndroidBack) { window.handleAndroidBack(); }", null)
  }
}
