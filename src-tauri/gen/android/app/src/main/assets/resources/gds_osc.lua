-- Premium OSC for GDS Mobile Player
-- Netflix/Disney+/Apple TV+ style commercial-grade design

local assdraw = require 'mp.assdraw'
local msg = require 'mp.msg'
local opt = require 'mp.options'
local utils = require 'mp.utils'

-- Configuration
local user_opts = {
    hidetimeout = 3000,
    seekbarHeight = 4,
    seekbarHandleSize = 16,
    buttonSize = 48,
    skipSeconds = 10,
}

opt.read_options(user_opts, 'gds_osc')

-- State
local state = {
    osc_visible = false,
    hide_timer = nil,
    osd = mp.create_osd_overlay("ass-events"),
    paused = false,
    fullscreen = false,
    muted = false,
    volume = 100,
}

-- Premium color palette
local colors = {
    white = "FFFFFF",
    white_dim = "B0B0B0",
    bg_gradient = "000000",
    accent = "E50914",  -- Netflix red accent
    seekbar_bg = "404040",
    seekbar_fill = "E50914",
    seekbar_cache = "808080",
}

-- Styles
local styles = {
    time = "{\\blur0\\bord1\\1c&HFFFFFF&\\3c&H000000&\\fs22\\fnSF Pro Display,Inter,Roboto,sans-serif}",
    title = "{\\blur0\\bord2\\1c&HFFFFFF&\\3c&H000000&\\fs26\\fnSF Pro Display,Inter,Roboto,sans-serif\\b1}",
    icon = "{\\blur0\\bord0\\1c&HFFFFFF&}",
    icon_dim = "{\\blur0\\bord0\\1c&HB0B0B0&}",
}

-- Utility functions
local function clamp(value, min, max)
    return math.max(min, math.min(max, value))
end

local function format_time(seconds)
    if not seconds or seconds < 0 then return "--:--" end
    local hours = math.floor(seconds / 3600)
    local mins = math.floor((seconds % 3600) / 60)
    local secs = math.floor(seconds % 60)
    if hours > 0 then
        return string.format("%d:%02d:%02d", hours, mins, secs)
    else
        return string.format("%02d:%02d", mins, secs)
    end
end

-- Draw icons using ASS drawing commands
local function draw_icon_play(ass, x, y, size, alpha)
    local a = alpha or 0
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord0\\1c&HFFFFFF&\\1a&H%02X&}", a))
    ass:pos(x, y)
    ass:draw_start()
    local s = size * 0.5
    ass:move_to(-s * 0.4, -s)
    ass:line_to(s * 0.8, 0)
    ass:line_to(-s * 0.4, s)
    ass:draw_stop()
end

local function draw_icon_pause(ass, x, y, size, alpha)
    local a = alpha or 0
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord0\\1c&HFFFFFF&\\1a&H%02X&}", a))
    ass:pos(x, y)
    ass:draw_start()
    local s = size * 0.5
    local bw = s * 0.25
    local gap = s * 0.2
    ass:rect_cw(-gap - bw, -s, -gap, s)
    ass:rect_cw(gap, -s, gap + bw, s)
    ass:draw_stop()
end

local function draw_icon_skip_back(ass, x, y, size, alpha)
    local a = alpha or 0
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord0\\1c&HFFFFFF&\\1a&H%02X&}", a))
    ass:pos(x, y)
    ass:draw_start()
    local s = size * 0.35
    -- Left arrow
    ass:move_to(s * 0.3, -s)
    ass:line_to(-s * 0.5, 0)
    ass:line_to(s * 0.3, s)
    ass:line_to(s * 0.3, s * 0.3)
    ass:line_to(-s * 0.1, 0)
    ass:line_to(s * 0.3, -s * 0.3)
    ass:draw_stop()
    -- "10" text
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord1\\1c&HFFFFFF&\\3c&H000000&\\fs%d\\fnSF Pro Display,sans-serif\\1a&H%02X&}", size * 0.35, a))
    ass:pos(x + size * 0.15, y + size * 0.45)
    ass:an(5)
    ass:append("10")
end

local function draw_icon_skip_forward(ass, x, y, size, alpha)
    local a = alpha or 0
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord0\\1c&HFFFFFF&\\1a&H%02X&}", a))
    ass:pos(x, y)
    ass:draw_start()
    local s = size * 0.35
    -- Right arrow
    ass:move_to(-s * 0.3, -s)
    ass:line_to(s * 0.5, 0)
    ass:line_to(-s * 0.3, s)
    ass:line_to(-s * 0.3, s * 0.3)
    ass:line_to(s * 0.1, 0)
    ass:line_to(-s * 0.3, -s * 0.3)
    ass:draw_stop()
    -- "10" text
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord1\\1c&HFFFFFF&\\3c&H000000&\\fs%d\\fnSF Pro Display,sans-serif\\1a&H%02X&}", size * 0.35, a))
    ass:pos(x - size * 0.15, y + size * 0.45)
    ass:an(5)
    ass:append("10")
end

local function draw_icon_volume(ass, x, y, size, muted, alpha)
    local a = alpha or 0
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord0\\1c&HFFFFFF&\\1a&H%02X&}", a))
    ass:pos(x, y)
    ass:draw_start()
    local s = size * 0.3
    -- Speaker body
    ass:move_to(-s, -s * 0.5)
    ass:line_to(-s * 0.3, -s * 0.5)
    ass:line_to(s * 0.3, -s)
    ass:line_to(s * 0.3, s)
    ass:line_to(-s * 0.3, s * 0.5)
    ass:line_to(-s, s * 0.5)
    ass:draw_stop()
    
    if muted then
        -- X mark
        ass:new_event()
        ass:append(string.format("{\\blur0\\bord2\\1c&HE50914&\\3c&H000000&\\1a&H%02X&}", a))
        ass:pos(x + size * 0.25, y)
        ass:draw_start()
        ass:move_to(-s * 0.4, -s * 0.4)
        ass:line_to(s * 0.4, s * 0.4)
        ass:move_to(s * 0.4, -s * 0.4)
        ass:line_to(-s * 0.4, s * 0.4)
        ass:draw_stop()
    else
        -- Sound waves (simple arc using lines)
        ass:new_event()
        ass:append(string.format("{\\blur0\\bord2\\1c&HFFFFFF&\\3c&H000000&\\1a&H%02X&}", a))
        ass:pos(x + size * 0.2, y)
        ass:draw_start()
        -- Simple arc approximation
        ass:move_to(0, -s * 0.4)
        ass:line_to(s * 0.2, -s * 0.2)
        ass:line_to(s * 0.25, 0)
        ass:line_to(s * 0.2, s * 0.2)
        ass:line_to(0, s * 0.4)
        ass:draw_stop()
    end
end

local function draw_icon_subtitle(ass, x, y, size, alpha)
    local a = alpha or 0
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord1\\1c&HFFFFFF&\\3c&H000000&\\fs%d\\fnSF Pro Display,sans-serif\\1a&H%02X&}", size * 0.4, a))
    ass:pos(x, y)
    ass:an(5)
    ass:append("CC")
end

local function draw_icon_fullscreen(ass, x, y, size, alpha)
    local a = alpha or 0
    ass:new_event()
    ass:append(string.format("{\\blur0\\bord2\\1c&HFFFFFF&\\3c&H000000&\\1a&H%02X&}", a))
    ass:pos(x, y)
    ass:draw_start()
    local s = size * 0.3
    local t = size * 0.08
    -- Top-left corner
    ass:rect_cw(-s, -s, -s + t * 3, -s + t)
    ass:rect_cw(-s, -s, -s + t, -s + t * 3)
    -- Top-right corner
    ass:rect_cw(s - t * 3, -s, s, -s + t)
    ass:rect_cw(s - t, -s, s, -s + t * 3)
    -- Bottom-left corner
    ass:rect_cw(-s, s - t, -s + t * 3, s)
    ass:rect_cw(-s, s - t * 3, -s + t, s)
    -- Bottom-right corner
    ass:rect_cw(s - t * 3, s - t, s, s)
    ass:rect_cw(s - t, s - t * 3, s, s)
    ass:draw_stop()
end

-- Draw seekbar
local function draw_seekbar(ass, x, y, w, h, progress, cache_progress)
    progress = clamp(progress or 0, 0, 1)
    cache_progress = clamp(cache_progress or 0, 0, 1)
    
    local radius = h / 2
    
    -- Background track
    ass:new_event()
    ass:append("{\\blur0\\bord0\\1c&H" .. colors.seekbar_bg .. "&}")
    ass:pos(0, 0)
    ass:draw_start()
    ass:round_rect_cw(x, y, x + w, y + h, radius)
    ass:draw_stop()
    
    -- Cache indicator
    if cache_progress > 0 then
        ass:new_event()
        ass:append("{\\blur0\\bord0\\1c&H" .. colors.seekbar_cache .. "&}")
        ass:pos(0, 0)
        ass:draw_start()
        local cw = w * cache_progress
        if cw > radius * 2 then
            ass:round_rect_cw(x, y, x + cw, y + h, radius)
        end
        ass:draw_stop()
    end
    
    -- Progress fill
    if progress > 0 then
        ass:new_event()
        ass:append("{\\blur0\\bord0\\1c&H" .. colors.seekbar_fill .. "&}")
        ass:pos(0, 0)
        ass:draw_start()
        local pw = w * progress
        if pw > radius * 2 then
            ass:round_rect_cw(x, y, x + pw, y + h, radius)
        else
            ass:rect_cw(x, y, x + math.max(pw, 2), y + h)
        end
        ass:draw_stop()
    end
    
    -- Handle
    local handleX = x + (w * progress)
    local handleR = user_opts.seekbarHandleSize / 2
    ass:new_event()
    ass:append("{\\blur0\\bord0\\1c&HFFFFFF&\\shad1\\4c&H000000&}")
    ass:pos(0, 0)
    ass:draw_start()
    -- Circle
    for i = 0, 360, 10 do
        local rad = math.rad(i)
        if i == 0 then
            ass:move_to(handleX + handleR * math.sin(rad), y + h/2 + handleR * math.cos(rad))
        else
            ass:line_to(handleX + handleR * math.sin(rad), y + h/2 + handleR * math.cos(rad))
        end
    end
    ass:draw_stop()
end

-- Main render function
local function render()
    local osd_w, osd_h = mp.get_osd_size()
    if osd_w <= 0 then return end
    
    local ass = assdraw.ass_new()
    
    -- Get playback info
    local position = mp.get_property_number("time-pos", 0)
    local duration = mp.get_property_number("duration", 0)
    local progress = (duration > 0) and (position / duration) or 0
    local paused = mp.get_property_bool("pause", false)
    local title = mp.get_property("media-title", "")
    local muted = mp.get_property_bool("mute", false)
    local cache = mp.get_property_number("demuxer-cache-time", 0)
    local cache_progress = (duration > 0 and cache) and ((position + cache) / duration) or 0
    
    -- Layout dimensions
    local margin = 30
    local bottomPadding = 25
    local seekH = user_opts.seekbarHeight
    local seekY = osd_h - bottomPadding - seekH - 50
    local seekX = margin + 90
    local seekW = osd_w - seekX - margin - 90
    local controlY = osd_h - bottomPadding - 25
    local centerX = osd_w / 2
    local buttonSize = user_opts.buttonSize
    
    -- ===== TOP GRADIENT =====
    ass:new_event()
    ass:append("{\\blur0\\bord0\\1c&H000000&\\1a&H80&}")
    ass:pos(0, 0)
    ass:draw_start()
    ass:rect_cw(0, 0, osd_w, 100)
    ass:draw_stop()
    
    -- Title (top left)
    if title and title ~= "" then
        local display_title = title
        if #display_title > 70 then
            display_title = display_title:sub(1, 67) .. "..."
        end
        ass:new_event()
        ass:append(styles.title)
        ass:pos(margin, 35)
        ass:an(4)
        ass:append(display_title)
    end
    
    -- ===== BOTTOM GRADIENT =====
    ass:new_event()
    ass:append("{\\blur0\\bord0\\1c&H000000&\\1a&H60&}")
    ass:pos(0, 0)
    ass:draw_start()
    ass:rect_cw(0, osd_h - 150, osd_w, osd_h)
    ass:draw_stop()
    
    -- ===== CENTER CONTROLS =====
    local centerY = osd_h / 2
    
    -- Skip back 10s
    draw_icon_skip_back(ass, centerX - buttonSize * 2, centerY, buttonSize * 1.5, 0)
    
    -- Play/Pause (large, center)
    if paused then
        draw_icon_play(ass, centerX, centerY, buttonSize * 2, 0)
    else
        draw_icon_pause(ass, centerX, centerY, buttonSize * 2, 0)
    end
    
    -- Skip forward 10s
    draw_icon_skip_forward(ass, centerX + buttonSize * 2, centerY, buttonSize * 1.5, 0)
    
    -- ===== SEEKBAR =====
    -- Current time (left)
    ass:new_event()
    ass:append(styles.time)
    ass:pos(margin, seekY + seekH / 2)
    ass:an(4)
    ass:append(format_time(position))
    
    -- Seekbar
    draw_seekbar(ass, seekX, seekY, seekW, seekH, progress, cache_progress)
    
    -- Duration (right)
    ass:new_event()
    ass:append(styles.time)
    ass:pos(osd_w - margin, seekY + seekH / 2)
    ass:an(6)
    ass:append(format_time(duration))
    
    -- ===== BOTTOM CONTROLS =====
    local rightControlsX = osd_w - margin
    
    -- Volume (right side)
    draw_icon_volume(ass, rightControlsX - buttonSize * 2.5, controlY, buttonSize * 0.8, muted, 0)
    
    -- Subtitles
    draw_icon_subtitle(ass, rightControlsX - buttonSize * 1.3, controlY, buttonSize * 0.8, 0)
    
    -- Fullscreen
    draw_icon_fullscreen(ass, rightControlsX - buttonSize * 0.3, controlY, buttonSize * 0.8, 0)
    
    state.osd.data = ass.text
    state.osd:update()
end

-- Hide OSD
local function hide_osc()
    state.osc_visible = false
    state.osd.data = ""
    state.osd:update()
end

-- Show OSD
local function show_osc()
    state.osc_visible = true
    render()
    
    if state.hide_timer then
        state.hide_timer:kill()
        state.hide_timer = nil
    end
    state.hide_timer = mp.add_timeout(user_opts.hidetimeout / 1000, hide_osc)
end

-- Tick function for continuous updates
local function tick()
    if state.osc_visible then
        render()
    end
end

-- Event handlers
local function on_seek()
    show_osc()
end

local function on_pause_change()
    show_osc()
end

-- Mouse/keyboard activity detection via properties
local last_mouse_pos = {x = 0, y = 0}

local function check_mouse_pos()
    local mx = mp.get_property_number("mouse-pos/x", 0)
    local my = mp.get_property_number("mouse-pos/y", 0)
    if mx ~= last_mouse_pos.x or my ~= last_mouse_pos.y then
        last_mouse_pos.x = mx
        last_mouse_pos.y = my
        show_osc()
    end
end

-- Initialize
mp.observe_property("pause", "bool", on_pause_change)
mp.observe_property("time-pos", "number", tick)
mp.observe_property("seeking", "bool", on_seek)

mp.register_event("file-loaded", function()
    show_osc()
end)

-- Periodic mouse position check
mp.add_periodic_timer(0.1, check_mouse_pos)

-- Also show on any key press
mp.add_key_binding(nil, "show-osc", show_osc)
mp.register_script_message("show-osc", show_osc)

-- Show on property changes that indicate user activity
mp.observe_property("fullscreen", "bool", show_osc)
mp.observe_property("mute", "bool", show_osc)
mp.observe_property("volume", "number", show_osc)

msg.info("GDS Premium OSC v2 loaded - Commercial-grade UI")
