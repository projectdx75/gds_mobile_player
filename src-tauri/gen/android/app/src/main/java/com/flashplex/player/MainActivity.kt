package com.flashplex.player

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import java.io.File

class MainActivity : TauriActivity() {
  private var mainWebView: WebView? = null
  private var lastBackPressedAt: Long = 0L

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

  private fun dispatchBackToWebAndMaybeExit() {
    val web = mainWebView
    if (web == null) {
      handleDoubleBackExit()
      return
    }

    val js = """
      (function() {
        try {
          if (window.handleAndroidBack) {
            return window.handleAndroidBack();
          }
        } catch (e) {}
        return "default";
      })();
    """.trimIndent()

    web.evaluateJavascript(js) { rawResult ->
      val action = rawResult
        ?.trim()
        ?.removePrefix("\"")
        ?.removeSuffix("\"")
        ?.ifBlank { "default" }
        ?: "default"

      if (action == "default") {
        handleDoubleBackExit()
      }
    }
  }

  private fun handleDoubleBackExit() {
    val now = System.currentTimeMillis()
    if (now - lastBackPressedAt < 2000L) {
      finishAffinity()
    } else {
      lastBackPressedAt = now
      Toast.makeText(this, "한 번 더 누르면 종료됩니다.", Toast.LENGTH_SHORT).show()
    }
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK) {
      dispatchBackToWebAndMaybeExit()
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    dispatchBackToWebAndMaybeExit()
  }
}
