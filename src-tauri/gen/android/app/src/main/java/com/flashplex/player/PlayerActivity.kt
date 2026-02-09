package com.flashplex.player

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class PlayerActivity : AppCompatActivity() {

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView

    private val uiHandler = Handler(Looper.getMainLooper())
    private val uiTicker = object : Runnable {
        override fun run() {
            refreshOverlayMeta()
            uiHandler.postDelayed(this, 1000)
        }
    }

    private var immersiveMode = true

    @OptIn(UnstableApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        playerView = PlayerView(this).apply {
            id = View.generateViewId()
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(android.graphics.Color.BLACK)
            controllerShowTimeoutMs = 4000
            setOnClickListener { showController() }
        }
        setContentView(playerView)

        playerView.setOnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_DOWN) {
                when (keyCode) {
                    KeyEvent.KEYCODE_DPAD_CENTER,
                    KeyEvent.KEYCODE_ENTER -> {
                        // OK: reveal OSC only when hidden; if visible, let focused control handle Enter.
                        if (!playerView.isControllerFullyVisible) {
                            playerView.showController()
                            return@setOnKeyListener true
                        }
                    }

                    KeyEvent.KEYCODE_DPAD_LEFT -> {
                        // Hidden OSC state: quick seek -10s directly.
                        if (!playerView.isControllerFullyVisible) {
                            seekBy(-10_000L)
                            return@setOnKeyListener true
                        }
                    }

                    KeyEvent.KEYCODE_DPAD_RIGHT -> {
                        // Hidden OSC state: quick seek +10s directly.
                        if (!playerView.isControllerFullyVisible) {
                            seekBy(10_000L)
                            return@setOnKeyListener true
                        }
                    }

                    KeyEvent.KEYCODE_DPAD_UP,
                    KeyEvent.KEYCODE_DPAD_DOWN -> {
                        // Up/Down from hidden state: just reveal controls.
                        if (!playerView.isControllerFullyVisible) {
                            playerView.showController()
                            return@setOnKeyListener true
                        }
                    }
                }
            }
            false
        }

        applyImmersiveMode(true)

        val videoUrl = intent.getStringExtra("VIDEO_URL") ?: return finish()
        val videoTitle = intent.getStringExtra("VIDEO_TITLE") ?: "Video"
        val subtitleUrl = intent.getStringExtra("SUBTITLE_URL")
        val subtitleSize = intent.getFloatExtra("SUBTITLE_SIZE", 1.0f)
        val subtitlePos = intent.getFloatExtra("SUBTITLE_POS", 0.0f)

        setupPlayer(videoUrl, videoTitle, subtitleUrl, subtitleSize, subtitlePos)
    }

    @OptIn(UnstableApi::class)
    private fun setupPlayer(
        url: String,
        title: String,
        subtitleUrl: String?,
        subtitleSize: Float,
        subtitlePos: Float,
    ) {
        player = ExoPlayer.Builder(this)
            .setAudioAttributes(androidx.media3.common.AudioAttributes.DEFAULT, true)
            .setSeekBackIncrementMs(10000)
            .setSeekForwardIncrementMs(10000)
            .build()

        playerView.player = player

        playerView.findViewById<TextView>(R.id.exo_title)?.text = title

        playerView.findViewById<ImageButton>(R.id.btn_player_back)?.setOnClickListener {
            finish()
        }

        playerView.findViewById<View>(R.id.btn_player_settings)?.setOnClickListener {
            showSubtitleSettingsDialog()
        }

        playerView.findViewById<View>(R.id.btn_player_subtitles)?.setOnClickListener {
            showSubtitleSettingsDialog()
        }

        playerView.findViewById<View>(R.id.btn_player_fullscreen)?.setOnClickListener {
            immersiveMode = !immersiveMode
            applyImmersiveMode(immersiveMode)
            playerView.showController()
        }

        applySubtitleSettings()

        player.playWhenReady = true
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setPreferredTextLanguage("ko")
            .setSelectUndeterminedTextLanguage(true)
            .build()

        player.addListener(object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) {
                var selected = false
                var firstTextGroup: Tracks.Group? = null
                var firstTextIndex = -1

                for (group in tracks.groups) {
                    if (group.type == androidx.media3.common.C.TRACK_TYPE_TEXT) {
                        if (firstTextGroup == null && group.length > 0) {
                            firstTextGroup = group
                            firstTextIndex = 0
                        }

                        for (i in 0 until group.length) {
                            val format = group.getTrackFormat(i)
                            val lang = (format.language ?: "").lowercase(Locale.getDefault())
                            if (lang == "ko" || lang == "kor" || lang.startsWith("ko")) {
                                if (!group.isTrackSelected(i)) {
                                    player.trackSelectionParameters =
                                        player.trackSelectionParameters.buildUpon()
                                            .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, i))
                                            .build()
                                }
                                selected = true
                                break
                            }
                            if (group.isTrackSelected(i)) {
                                selected = true
                            }
                        }
                    }
                    if (selected) break
                }

                if (!selected && firstTextGroup != null && firstTextIndex >= 0) {
                    player.trackSelectionParameters =
                        player.trackSelectionParameters.buildUpon()
                            .setOverrideForType(TrackSelectionOverride(firstTextGroup!!.mediaTrackGroup, firstTextIndex))
                            .build()
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                refreshOverlayMeta()
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                refreshOverlayMeta()
            }
        })

        val mediaItemBuilder = MediaItem.Builder().setUri(url)

        if (!subtitleUrl.isNullOrEmpty()) {
            val isExternalApi = subtitleUrl.contains("external_subtitle") || subtitleUrl.contains("convert_to_vtt")
            val subtitleConfig = MediaItem.SubtitleConfiguration.Builder(Uri.parse(subtitleUrl))
                .setMimeType(if (isExternalApi || subtitleUrl.endsWith(".vtt")) MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP)
                .setLanguage("ko")
                .setSelectionFlags(
                    androidx.media3.common.C.SELECTION_FLAG_DEFAULT or androidx.media3.common.C.SELECTION_FLAG_FORCED,
                )
                .setRoleFlags(androidx.media3.common.C.ROLE_FLAG_SUBTITLE)
                .build()
            mediaItemBuilder.setSubtitleConfigurations(listOf(subtitleConfig))
        }

        player.setMediaItem(mediaItemBuilder.build())
        player.prepare()
        refreshOverlayMeta()
    }

    private fun seekBy(deltaMs: Long) {
        val current = player.currentPosition.coerceAtLeast(0L)
        val duration = player.duration.takeIf { it > 0 } ?: Long.MAX_VALUE
        val rawTarget = (current + deltaMs).coerceAtLeast(0L)
        val target = if (duration == Long.MAX_VALUE) rawTarget else rawTarget.coerceAtMost(duration)
        player.seekTo(target)
        refreshOverlayMeta()
    }

    private fun applyImmersiveMode(enable: Boolean) {
        @Suppress("DEPRECATION")
        if (enable) {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }

    private fun refreshOverlayMeta() {
        val pos = player.currentPosition.coerceAtLeast(0L)
        val dur = player.duration.takeIf { it > 0 } ?: 0L
        playerView.findViewById<TextView>(R.id.exo_subtitle_meta)?.text = "${formatTime(pos)} / ${formatTime(dur)}"

        val clock = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date())
        playerView.findViewById<TextView>(R.id.player_clock)?.text = clock
    }

    private fun formatTime(ms: Long): String {
        val totalSec = (ms / 1000).toInt()
        val h = totalSec / 3600
        val m = (totalSec % 3600) / 60
        val s = totalSec % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.US, "%02d:%02d", m, s)
    }

    private fun showSubtitleSettingsDialog() {
        try {
            val dialog = com.google.android.material.bottomsheet.BottomSheetDialog(this)
            val view = layoutInflater.inflate(R.layout.subtitle_settings_dialog, null)
            dialog.setContentView(view)

            val prefs = getSharedPreferences("player_prefs", MODE_PRIVATE)

            val rgStyle = view.findViewById<android.widget.RadioGroup>(R.id.rg_subtitle_style)
            val savedStyle = prefs.getInt("subtitle_style", 0)
            when (savedStyle) {
                1 -> rgStyle.check(R.id.rb_style_shadow)
                2 -> rgStyle.check(R.id.rb_style_outline)
                else -> rgStyle.check(R.id.rb_style_box)
            }

            rgStyle.setOnCheckedChangeListener { _, checkedId ->
                val style = when (checkedId) {
                    R.id.rb_style_shadow -> 1
                    R.id.rb_style_outline -> 2
                    else -> 0
                }
                prefs.edit().putInt("subtitle_style", style).apply()
                applySubtitleSettings()
            }

            val sbSize = view.findViewById<android.widget.SeekBar>(R.id.sb_subtitle_size)
            val tvSizeValue = view.findViewById<TextView>(R.id.tv_size_value)
            val savedSize = prefs.getFloat("subtitle_size", 1.0f)
            sbSize.progress = ((savedSize - 0.5f) * 100).toInt()
            tvSizeValue.text = String.format(Locale.US, "%.1fx", savedSize)

            sbSize.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    val size = 0.5f + (progress / 100f)
                    tvSizeValue.text = String.format(Locale.US, "%.1fx", size)
                    prefs.edit().putFloat("subtitle_size", size).apply()
                    applySubtitleSettings()
                }
                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) {}
                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) {}
            })

            val sbPos = view.findViewById<android.widget.SeekBar>(R.id.sb_subtitle_pos)
            val tvPosValue = view.findViewById<TextView>(R.id.tv_pos_value)
            val savedPos = prefs.getFloat("subtitle_pos", 0.05f)
            sbPos.progress = (savedPos * 200).toInt()
            tvPosValue.text = String.format(Locale.US, "%d%%", (savedPos * 100).toInt())

            sbPos.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    val pos = progress / 200f
                    tvPosValue.text = String.format(Locale.US, "%d%%", (pos * 100).toInt())
                    prefs.edit().putFloat("subtitle_pos", pos).apply()
                    applySubtitleSettings()
                }
                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) {}
                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) {}
            })

            view.findViewById<View>(R.id.btn_close_settings).setOnClickListener {
                dialog.dismiss()
            }

            dialog.show()
        } catch (e: Exception) {
            e.printStackTrace()
            android.widget.Toast.makeText(this, "Settings Error: ${e.message}", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    private fun applySubtitleSettings() {
        val prefs = getSharedPreferences("player_prefs", MODE_PRIVATE)
        val style = prefs.getInt("subtitle_style", 0)
        val size = prefs.getFloat("subtitle_size", 1.0f)
        val pos = prefs.getFloat("subtitle_pos", 0.05f)

        playerView.subtitleView?.setFractionalTextSize(androidx.media3.ui.SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * size)
        playerView.subtitleView?.setBottomPaddingFraction(pos)

        val styleCompat = when (style) {
            1 -> androidx.media3.ui.CaptionStyleCompat(
                android.graphics.Color.WHITE,
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT,
                androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW,
                android.graphics.Color.BLACK,
                null,
            )
            2 -> androidx.media3.ui.CaptionStyleCompat(
                android.graphics.Color.WHITE,
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT,
                androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_OUTLINE,
                android.graphics.Color.BLACK,
                null,
            )
            else -> androidx.media3.ui.CaptionStyleCompat.DEFAULT
        }
        playerView.subtitleView?.setStyle(styleCompat)
    }

    override fun onResume() {
        super.onResume()
        uiHandler.post(uiTicker)
    }

    override fun onPause() {
        super.onPause()
        uiHandler.removeCallbacks(uiTicker)
        player.pause()
    }

    override fun onDestroy() {
        uiHandler.removeCallbacks(uiTicker)
        player.release()
        super.onDestroy()
    }
}
