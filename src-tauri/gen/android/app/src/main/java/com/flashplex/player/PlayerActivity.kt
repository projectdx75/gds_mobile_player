package com.flashplex.player

import android.net.Uri
import android.os.Bundle
import android.view.View
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import android.view.KeyEvent
import android.view.WindowManager
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks

class PlayerActivity : AppCompatActivity() {

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView

    @OptIn(UnstableApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Prevent Screen Timeout
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Use a simple programmatic layout instead of XML for easier injection
        playerView = PlayerView(this).apply {
            id = View.generateViewId()
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(android.graphics.Color.BLACK)
            // Show controller on any D-pad press for leanback experience
            setOnClickListener { this.showController() }
        }
        setContentView(playerView)

        // D-pad Navigation Support for OSC
        playerView.setOnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_DOWN) {
                when (keyCode) {
                    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, 
                    KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                        if (!playerView.isControllerFullyVisible) {
                            playerView.showController()
                            return@setOnKeyListener true
                        }
                    }
                }
            }
            false
        }

        // Enter Fullscreen
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)

        val videoUrl = intent.getStringExtra("VIDEO_URL") ?: return finish()
        val videoTitle = intent.getStringExtra("VIDEO_TITLE") ?: "Video"
        val subtitleUrl = intent.getStringExtra("SUBTITLE_URL")
        val subtitleSize = intent.getFloatExtra("SUBTITLE_SIZE", 1.0f)
        val subtitlePos = intent.getFloatExtra("SUBTITLE_POS", 0.0f)
        
        setupPlayer(videoUrl, videoTitle, subtitleUrl, subtitleSize, subtitlePos)
    }

    @OptIn(UnstableApi::class)
    private fun setupPlayer(url: String, title: String, subtitleUrl: String?, subtitleSize: Float, subtitlePos: Float) {
        player = ExoPlayer.Builder(this)
            .setAudioAttributes(androidx.media3.common.AudioAttributes.DEFAULT, true)
            .setSeekBackIncrementMs(10000)
            .setSeekForwardIncrementMs(10000)
            .build()
            
        playerView.player = player

        // Set Title in Custom Controller
        playerView.findViewById<android.widget.TextView>(com.flashplex.player.R.id.exo_title)?.text = title

        // Handle Settings Button
        playerView.findViewById<android.view.View>(com.flashplex.player.R.id.btn_player_settings)?.setOnClickListener {
            showSubtitleSettingsDialog()
        }

        // Apply Saved Preferences
        applySubtitleSettings()

        // 1. Force Auto-play state
        player.playWhenReady = true

        // 2. Configure Track Selection to prioritize Korean Subtitles
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setPreferredTextLanguage("ko")
            .setSelectUndeterminedTextLanguage(true)
            .build()

        // 3. Listener to ensure subtitle track is selected
        player.addListener(object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) {
                // If there is a Korean text track and none is selected, force it
                for (group in tracks.groups) {
                    if (group.type == androidx.media3.common.C.TRACK_TYPE_TEXT) {
                        for (i in 0 until group.length) {
                            val format = group.getTrackFormat(i)
                            if (format.language == "ko" || format.language == "und") {
                                if (!group.isTrackSelected(i)) {
                                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                                        .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, i))
                                        .build()
                                }
                                break
                            }
                        }
                    }
                }
            }
        })

        val mediaItemBuilder = MediaItem.Builder()
            .setUri(url)

        if (!subtitleUrl.isNullOrEmpty()) {
            val isExternalApi = subtitleUrl.contains("external_subtitle") || subtitleUrl.contains("convert_to_vtt")
            val subtitleConfig = MediaItem.SubtitleConfiguration.Builder(Uri.parse(subtitleUrl))
                .setMimeType(if (isExternalApi || subtitleUrl.endsWith(".vtt")) MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP)
                .setLanguage("ko")
                .setSelectionFlags(androidx.media3.common.C.SELECTION_FLAG_DEFAULT or androidx.media3.common.C.SELECTION_FLAG_FORCED)
                .setRoleFlags(androidx.media3.common.C.ROLE_FLAG_SUBTITLE)
                .build()
            mediaItemBuilder.setSubtitleConfigurations(listOf(subtitleConfig))
        }

        player.setMediaItem(mediaItemBuilder.build())
        player.prepare()
    }

    private fun showSubtitleSettingsDialog() {
        try {
            val dialog = com.google.android.material.bottomsheet.BottomSheetDialog(this)
            val view = layoutInflater.inflate(com.flashplex.player.R.layout.subtitle_settings_dialog, null)
            dialog.setContentView(view)

            val prefs = getSharedPreferences("player_prefs", MODE_PRIVATE)
            
            // --- Style ---
            val rgStyle = view.findViewById<android.widget.RadioGroup>(com.flashplex.player.R.id.rg_subtitle_style)
            val savedStyle = prefs.getInt("subtitle_style", 0) // 0:Box, 1:Shadow, 2:Outline
            when(savedStyle) {
                1 -> rgStyle.check(com.flashplex.player.R.id.rb_style_shadow)
                2 -> rgStyle.check(com.flashplex.player.R.id.rb_style_outline)
                else -> rgStyle.check(com.flashplex.player.R.id.rb_style_box)
            }

            rgStyle.setOnCheckedChangeListener { _, checkedId ->
                val style = when(checkedId) {
                    com.flashplex.player.R.id.rb_style_shadow -> 1
                    com.flashplex.player.R.id.rb_style_outline -> 2
                    else -> 0
                }
                prefs.edit().putInt("subtitle_style", style).apply()
                applySubtitleSettings()
            }

            // --- Size (0.5x to 2.0x, mapped to progress 0-150) ---
            val sbSize = view.findViewById<android.widget.SeekBar>(com.flashplex.player.R.id.sb_subtitle_size)
            val tvSizeValue = view.findViewById<android.widget.TextView>(com.flashplex.player.R.id.tv_size_value)
            val savedSize = prefs.getFloat("subtitle_size", 1.0f)
            sbSize.progress = ((savedSize - 0.5f) * 100).toInt()
            tvSizeValue.text = String.format("%.1fx", savedSize)

            sbSize.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    val size = 0.5f + (progress / 100f)
                    tvSizeValue.text = String.format("%.1fx", size)
                    prefs.edit().putFloat("subtitle_size", size).apply()
                    applySubtitleSettings()
                }
                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) {}
                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) {}
            })

            // --- Position (0% to 50% bottom padding, mapped to 0-100) ---
            val sbPos = view.findViewById<android.widget.SeekBar>(com.flashplex.player.R.id.sb_subtitle_pos)
            val tvPosValue = view.findViewById<android.widget.TextView>(com.flashplex.player.R.id.tv_pos_value)
            val savedPos = prefs.getFloat("subtitle_pos", 0.05f) // Default bottom padding
            sbPos.progress = (savedPos * 200).toInt() // 0.0-0.5 -> 0-100
            tvPosValue.text = String.format("%d%%", (savedPos * 100).toInt())

            sbPos.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    val pos = progress / 200f
                    tvPosValue.text = String.format("%d%%", (pos * 100).toInt())
                    prefs.edit().putFloat("subtitle_pos", pos).apply()
                    applySubtitleSettings()
                }
                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) {}
                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) {}
            })

            view.findViewById<android.view.View>(com.flashplex.player.R.id.btn_close_settings).setOnClickListener {
                dialog.dismiss()
            }

            dialog.show()
        } catch (e: Exception) {
            e.printStackTrace()
            android.widget.Toast.makeText(this, "Settings Error: " + e.message, android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    private fun applySubtitleSettings() {
        val prefs = getSharedPreferences("player_prefs", MODE_PRIVATE)
        val style = prefs.getInt("subtitle_style", 0)
        val size = prefs.getFloat("subtitle_size", 1.0f)
        val pos = prefs.getFloat("subtitle_pos", 0.05f)

        // Apply Size & Pos (Existing logic updated)
        playerView.subtitleView?.setFractionalTextSize(androidx.media3.ui.SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * size)
        playerView.subtitleView?.setBottomPaddingFraction(pos)

        // Apply Style
        val styleCompat = when(style) {
            1 -> androidx.media3.ui.CaptionStyleCompat(
                android.graphics.Color.WHITE, 
                android.graphics.Color.TRANSPARENT, 
                android.graphics.Color.TRANSPARENT, 
                androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, 
                android.graphics.Color.BLACK, 
                null
            )
            2 -> androidx.media3.ui.CaptionStyleCompat(
                android.graphics.Color.WHITE, 
                android.graphics.Color.TRANSPARENT, 
                android.graphics.Color.TRANSPARENT, 
                androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_OUTLINE, 
                android.graphics.Color.BLACK, 
                null
            )
            else -> androidx.media3.ui.CaptionStyleCompat.DEFAULT // Box
        }
        playerView.subtitleView?.setStyle(styleCompat)
    }

    override fun onDestroy() {
        super.onDestroy()
        player.release()
    }

    override fun onPause() {
        super.onPause()
        player.pause()
    }
}
