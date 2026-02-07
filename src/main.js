// Tauri v2 GDS Mobile Player - main.js
// Tauri v2 GDS Mobile Player - main.js
// if (window.__TAURI_INTERNALS__) {
//   window.__TAURI__ = window.__TAURI_INTERNALS__; // Attempt polyfill if needed
// }

// State Management (Hardcoded for testing as requested)
const state = {
  serverUrl: "https://music.yommi.mywire.org",
  apiKey: "gommikey",
  currentView: "library",
  category: "tv_show", // Default to TV/Show
  query: "", // Current search query
  library: [],
  currentPath: "", // For folder navigation
  pathStack: [], // Navigation history
  categoryMapping: {},
  subtitleSize: parseFloat(localStorage.getItem("flashplex_sub_size") || "1.1"), // Default font scale
  subtitlePos: parseFloat(localStorage.getItem("flashplex_sub_pos") || "100.0"), // Default vertical offset (Bottom)
  volume: parseInt(localStorage.getItem("flashplex_volume") || "100"),
  qualityProfile: localStorage.getItem("flashplex_quality_profile") || "balanced",

  // [PHASE 4] Infinite Scroll State
  offset: 0,
  limit: 100, // Batch size (increased from 50 due to performance optimization)
  isLoadingMore: false,
  hasMore: true,

  // [PHASE 4] Sorting State
  sortBy: "date",
  sortOrder: "desc",

  // [NEW] Global seen paths to prevent duplicates across appends
  seenPaths: new Set(),
  isFirstFreshLoadDone: false,
  isFreshLoading: false, // [NEW] Concurrency guard for fresh loads
  nativeSource: null, // { title, url, subtitleUrl }
  nativeRecreating: false,
};

// Platform Detection
const isAndroid = /Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isDesktop = !isAndroid && !isIOS;
const folderMetaCache = new Map();
let nativeStatePollTimer = null;

// Helper for cross-version Tauri invoke
function getTauriInvoke() {
  const invoke = window.__TAURI_CDN_INVOKE__ || (window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core.invoke : (window.__TAURI__ ? window.__TAURI__.invoke : null));
  if (invoke && !window.tlog) {
    window.tlog = (msg) => { 
        invoke("native_log", { msg }).catch(() => {});
        console.log("[NATIVE-LOG]", msg);
    };
  }
  return invoke;
}

function normalizeQualityProfile(profile) {
  if (profile === "quality" || profile === "smooth") return profile;
  return "balanced";
}

async function applyNativeQualityProfile(profile, silent = false) {
  const invoke = getTauriInvoke();
  const normalized = normalizeQualityProfile(profile);
  state.qualityProfile = normalized;
  localStorage.setItem("flashplex_quality_profile", normalized);

  if (!invoke || !state.isNativeActive) return normalized;
  try {
    const applied = await invoke("set_quality_profile", { profile: normalized });
    const finalProfile = normalizeQualityProfile(applied || normalized);
    state.qualityProfile = finalProfile;
    localStorage.setItem("flashplex_quality_profile", finalProfile);
    if (!silent) console.log("[QUALITY] Applied profile:", finalProfile);
    return finalProfile;
  } catch (err) {
    console.error("[QUALITY] Failed to apply profile:", err);
    return normalized;
  }
}

async function recreateNativePlayerAfterResize(reason = "fullscreen") {
  const invoke = getTauriInvoke();
  if (!invoke || !state.isNativeActive || state.nativeRecreating || !state.nativeSource) return;

  state.nativeRecreating = true;
  setNativeTransitionMask(true);
  if (ui.premiumOsc) ui.premiumOsc.classList.add("hidden");
  try {
    const wasPausedBefore = !!state.nativePaused;
    let mpvState = {
      position: typeof state.nativePos === "number" ? state.nativePos : 0,
      pause: wasPausedBefore,
      sid: -1,
      volume: typeof state.volume === "number" ? state.volume : 100,
    };

    // Freeze playback position first to avoid timing drift while recreating.
    await invoke("native_play_pause", { pause: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 70));

    try {
      const snap = await invoke("get_mpv_state");
      if (snap && typeof snap === "object") {
        mpvState.position = typeof snap.position === "number" ? snap.position : mpvState.position;
        // Do not override pause with the forced pause state we just applied.
        mpvState.sid = typeof snap.sid === "number" ? snap.sid : mpvState.sid;
        mpvState.volume = typeof snap.volume === "number" ? snap.volume : mpvState.volume;
      }
    } catch (_) {}
    const shouldResume = !wasPausedBefore;

    const source = state.nativeSource;
    console.log(`[NATIVE-RECREATE] start (${reason})`, source, "pos=", mpvState.position);

    await invoke("close_native_player").catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    await invoke("launch_mpv_player", {
      title: source.title,
      url: source.url,
      subtitle_url: source.subtitleUrl || null,
      start_pos: mpvState.position,
      start_paused: true,
    });

    // Wait until mpv is ready enough to accept seek reliably.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 90));
      try {
        const s = await invoke("get_mpv_state");
        if (s && typeof s.duration === "number" && s.duration > 1) break;
      } catch (_) {}
    }
    await invoke("resize_native_player", {}).catch(() => {});
    await applyNativeQualityProfile(state.qualityProfile, true);

    if (typeof mpvState.position === "number" && mpvState.position > 0.2) {
      await invoke("native_seek", { seconds: mpvState.position }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      await invoke("native_seek", { seconds: mpvState.position }).catch(() => {});
    }
    if (typeof mpvState.sid === "number" && mpvState.sid >= 0) {
      await invoke("set_subtitle_track", { sid: mpvState.sid }).catch(() => {});
    }
    if (typeof mpvState.volume === "number") {
      await invoke("native_set_volume", { volume: Math.round(mpvState.volume) }).catch(() => {});
    }

    const applySubPos = (typeof state.subtitlePos === "number") ? state.subtitlePos : 100.0;
    await invoke("set_subtitle_style", {
      scale: state.subtitleSize,
      pos: Math.round(applySubPos),
    }).catch(() => {});

    if (shouldResume) {
      await new Promise((r) => setTimeout(r, 110));
      await invoke("native_play_pause", { pause: false }).catch(() => {});
      state.nativePaused = false;
    } else {
      await invoke("native_play_pause", { pause: true }).catch(() => {});
      state.nativePaused = true;
    }

    console.log(`[NATIVE-RECREATE] done (${reason})`);
  } catch (err) {
    console.error(`[NATIVE-RECREATE] failed (${reason})`, err);
  } finally {
    state.nativeRecreating = false;
    if (ui.premiumOsc) {
      setTimeout(() => {
        if (state.isNativeActive && !state.nativeRecreating) {
          ui.premiumOsc.classList.remove("hidden");
        }
        setNativeTransitionMask(false);
      }, 250);
    } else {
      setTimeout(() => setNativeTransitionMask(false), 250);
    }
  }
}

function setNativeTransitionMask(active) {
  document.body.classList.toggle("native-recreate-active", !!active);
  document.documentElement.classList.toggle("native-recreate-active", !!active);
  if (ui.premiumOsc && active) ui.premiumOsc.classList.add("hidden");
}

// [NEW] Shared logic for checking/selecting subs and updating badge with retry
async function checkAndSelectSubtitles(retries = 4) {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  try {
    let tracks = await invoke("get_subtitle_tracks");
    console.log("[SUB] Tracks identified:", tracks.length, tracks);

    // [MOD] Auto-Selection Logic: Prefer Korean even if something else is selected by default
    const currentSelection = tracks.find(t => t.selected);
    const isKorean = (t) => {
        if (!t) return false;
        const lang = (t.lang || "").toLowerCase();
        const title = (t.title || "").toLowerCase();
        // [MOD] Robust check for ko, kor, ko-KR, ko_KR
        return lang === 'ko' || lang === 'kor' || lang.startsWith('ko-') || lang.startsWith('ko_') || 
               title.includes('korean') || title.includes('한국어') || title.includes('ko.');
    };

    if (tracks && tracks.length > 0) {
        // If nothing selected OR current selection is NOT Korean, try to find Korean
        if (!currentSelection || !isKorean(currentSelection)) {
            const koTrack = tracks.find(isKorean);
            
            if (koTrack) {
                console.log("[SUB] Auto-selecting Korean track (Overriding default):", koTrack.id, koTrack.title);
                await invoke("set_subtitle_track", { sid: koTrack.id });
                
                const badge = document.getElementById("osc-sub-badge");
                if (badge) badge.style.display = "block";
                return true; 
            }
        }
    }

    // Update Badge Visibility
    const hasSelection = tracks && tracks.some((t) => t.selected);
    const badge = document.getElementById("osc-sub-badge");
    if (badge) badge.style.display = hasSelection ? "block" : "none";

    // Retry if no tracks found (maybe loading)
    if (retries > 0) {
      setTimeout(() => checkAndSelectSubtitles(retries - 1), 2000); 
    }
    return hasSelection;
  } catch (e) {
    console.error("[SUB] Auto-check failed:", e);
  }
}

// DOM Elements (Cached on load)
let ui = {};

function initElements() {
  try {
    ui = {
      views: {
        library: document.getElementById("view-library"),
        search: document.getElementById("view-search"),
        settings: document.getElementById("view-settings"),
      },
      grid: document.getElementById("library-grid"),
      heroSection: document.querySelector(".hero-section"),
      searchInput: document.getElementById("search-input"),
      navItems: document.querySelectorAll(".nav-item"),
      categoryTabs: document.querySelectorAll(".tab"),
      playerOverlay: document.getElementById("player-overlay"),
      mainPlayer: document.getElementById("main-player"),
      playerTitle:
        document.getElementById("player-video-title") ||
        document.getElementById("player-title"),
      statusDot: document.getElementById("status-indicator"),
      playerBg: document.getElementById("player-bg"),
      audioVisual: document.getElementById("audio-visual"),
      audioPoster: document.getElementById("audio-poster"),
      audioTitle: document.getElementById("audio-title"),
      audioArtist: document.getElementById("audio-artist"),
      videoContainer: document.querySelector(".video-container"),
      playerTitleInfo: document.querySelector(".player-title-info"),
      progressBarFill: document.getElementById("progress-bar-fill"),
      progressSlider: document.getElementById("progress-slider"),
      currentTime: document.getElementById("current-time"),
      totalTime: document.getElementById("total-time"),
      customControls: document.getElementById("custom-controls"),
      btnCenterPlay: document.getElementById("btn-center-play"),
      btnPlayPause: document.getElementById("btn-play-pause"),
      playerHeader: document.querySelector(".player-header"),
      btnExitNative: document.getElementById("btn-exit-native"),
      globalLoader: document.getElementById("global-loader"),

      // [NEW] Premium OSC Elements
      premiumOsc: document.getElementById("premium-osc"),
      oscTitle: document.getElementById("osc-title"),
      oscSubtitle: document.getElementById("osc-subtitle"),
      oscCurrentTime: document.getElementById("osc-current-time"),
      oscTotalTime: document.getElementById("osc-total-time"),
      oscProgressFill: document.getElementById("osc-progress-fill"),
      oscProgressSlider: document.getElementById("osc-progress-slider"),
      oscHwBadge: document.getElementById("osc-hw-badge"),
      oscClock: document.getElementById("osc-clock"),
      btnOscPlayPause: document.getElementById("btn-osc-play-pause"),
      btnOscCenterPlay: document.getElementById("btn-osc-center-play"),
      btnOscPrev: document.getElementById("btn-osc-prev"),
      btnOscNext: document.getElementById("btn-osc-next"),
      btnOscBack: document.getElementById("btn-osc-back"),
      oscVolumeSlider: document.getElementById("osc-volume-slider"),
      btnOscFullscreen: document.getElementById("btn-osc-fullscreen"),
      btnOscSubtitles: document.getElementById("btn-osc-subtitles"), // [FIX] ID Plural
      btnOscSettings: document.getElementById("osc-btn-settings"),
      btnHeaderSettings: document.getElementById("btn-osc-settings"),
      oscCenterControls: document.querySelector(".osc-center-controls"),
    };
    console.log("[INIT] UI Elements initialized safely.");
  } catch (err) {
    console.error("[INIT] Failed to initialize elements:", err);
  }
}

// Initialize
window.addEventListener("DOMContentLoaded", () => {
  console.log("[STARTUP] Application booting...");
  document.documentElement.classList.add("appletv-skin");
  document.body.classList.add("appletv-skin");





  // [CRITICAL] Polyfill Tauri API if injection failed
  // This restores window.__TAURI__ using the CDN version if needed
  const cdnInvoke = window.__TAURI_CDN_INVOKE__;
  if (!window.__TAURI__ && cdnInvoke) {
    console.log("[POLYFILL] Tauri Global missing - Restoring via CDN...");
    window.__TAURI__ = {
      core: { invoke: cdnInvoke },
      invoke: cdnInvoke,
      event: { listen: window.__TAURI_CDN_LISTEN__ }
    };
    // Manually trigger component re-checks if needed
  } else if (!window.__TAURI__) {
    // Manual IPC fallback check
    const ipc = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tauri;
    if (ipc) {
      console.log("[POLYFILL] Finding raw IPC...");
      // Basic mock if IPC exists but global is missing
    }
  }

  // Connectivity Test
  try {
    const invoke =
      window.__TAURI__ && window.__TAURI__.core
        ? window.__TAURI__.core.invoke
        : window.__TAURI__
          ? window.__TAURI__.invoke
          : null;

    // Retry checking if Tauri is late
    if (!invoke && !window.__TAURI__) {
      let checkCount = 0;
      const initTauri = setInterval(() => {
        if (window.__TAURI__) {
          clearInterval(initTauri);
          console.log("[STARTUP] Tauri Global Detected (Late)!");

          // Re-trigger connectivity test
          const lateInvoke = window.__TAURI__.core ? window.__TAURI__.core.invoke : window.__TAURI__.invoke;
          if (lateInvoke) lateInvoke("ping").then(r => console.log("Late Ping:", r));

          // Re-init OSC which failed earlier
          setupPremiumOSC();
        } else {
          checkCount++;
          if (checkCount > 50) { // 5 seconds
            clearInterval(initTauri);
            console.error("[CRITICAL] Tauri Global NOT FOUND after 5s.");
          }
        }
      }, 100);
    }

    if (invoke) {
      invoke("ping")
        .then((r) => {
          console.log("[STARTUP] Bridge Test (ping) SUCCESS:", r);
          if (ui.statusDot) ui.statusDot.style.backgroundColor = "#00ff00";
          // Update debug with success
          const dEl = document.getElementById("debug-overlay");
          if (dEl) dEl.innerHTML += `<br><strong>Ping:</strong> <span style="color:#0f0">SUCCESS (${r})</span>`;
        })
        .catch((e) => {
          console.warn("[STARTUP] Bridge Test (ping) FAILED:", e);
          if (ui.statusDot) ui.statusDot.style.backgroundColor = "#ff0000";
        });
    }
  } catch (err) {
    console.warn("[STARTUP] Bridge check failed:", err);
  }

  initElements();
  if (window.lucide) lucide.createIcons();

  // Register robust global listeners
  document.addEventListener("click", (e) => {
    const navItem = e.target.closest(".nav-item");
    if (navItem && navItem.dataset.view) {
      switchView(navItem.dataset.view);
    }
  });

  setupNavigation();
  setupTabs();

  // Setup other modules with safety
  try {
    const defaultTab = document.querySelector('.tab[data-category="tv_show"]');
    if (defaultTab) defaultTab.classList.add("active");

    setupSearch();
    setupPlayer();
    setupButtons();
    setupSettings();
    setupRemoteNavigation();
    setupPremiumOSC();
  } catch (err) {
    console.error("[STARTUP] Setup error:", err);
  }

  // Initial data load
  if (state.serverUrl && state.apiKey) {
    console.log("[STARTUP] Starting initial library load...");
    loadLibrary();
    switchView("library");
  } else {
    switchView("settings");
  }
  // setupScrollBehavior(); // [PHASE 4] Auto-hide Nav (Disabled per user request)
  setupInfiniteScroll(); // [PHASE 4] Infinite Scroll
  setupSortUI(); // [PHASE 4] Sort UI
  // initHeroCarousel moved to switchView("library") for proper DOM timing

  // Header Scroll Effect
  const container = document.querySelector(".content-container");
  const header = document.querySelector(".glass-header");
  if (container && header) {
    container.scrollTop = 0; // [FIX] Initial reset
    container.addEventListener("scroll", () => {
      header.classList.toggle("scrolled", container.scrollTop > 50);
    });
  }

  // [FIX] Robust Manual Dragging Fallback
  const dragHandle = document.getElementById("stable-drag-bar") || header;
  if (dragHandle) {
    dragHandle.addEventListener("mousedown", (e) => {
      // Don't drag if clicking buttons, links, or logo
      if (e.target.closest("button") || 
          e.target.closest(".nav-link") || 
          e.target.hasAttribute("data-tauri-no-drag")) {
        return;
      }

      const invoke = getTauriInvoke();
      if (!invoke) return;
      console.log("[DRAG] Manual dragging initiated");
      invoke("native_start_drag").catch((err) => {
        console.error("[DRAG] native_start_drag failed:", err);
      });
    });
  }

  // Globally expose switchView for HTML onclick
  window.switchView = switchView;
  window.playVideo = playVideo;
});

// Navigation Logic
function setupNavigation() {
  // delegation handled in global listener above
  console.log("[NAV] Global navigation listener active.");
}

function switchView(viewName) {
  console.log("[NAV] Switching to view:", viewName);
  const views = ui.views || {};
  const navItems = ui.navItems || [];

  if (!views[viewName]) {
    console.error("[NAV] Target view not found:", viewName);
    return;
  }

  Object.keys(views).forEach((key) => {
    if (views[key]) views[key].classList.toggle("active", key === viewName);
  });

  navItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });

  // [NEW] If switching view AND native player is active, kill it
  if (state.isNativeActive && viewName !== "player") {
    const invoke = window.__TAURI__ ? (window.__TAURI__.core ? window.__TAURI__.core.invoke : window.__TAURI__.invoke) : null;
    if (invoke) {
      invoke("close_native_player").catch(() => {});
      state.isNativeActive = false;
      state.nativeSource = null;
      document.body.classList.remove("native-player-active");
      document.documentElement.classList.remove("native-player-active");
    }
  }

  state.currentView = viewName;

  // [FIX] Reset scroll position on view switch
  const container = document.querySelector(".content-container");
  if (container) container.scrollTop = 0;

  // [FIX] Initialize hero carousel when library view is shown
  if (viewName === "library") {
    // Use setTimeout to ensure DOM is fully rendered
    setTimeout(() => initHeroCarousel(), 50);
  } else {
    // [NEW] Kill hero timer if not in library
    if (heroTimer) {
      console.log("[PLAYER] Leaving library, stopping hero timer");
      clearInterval(heroTimer);
      heroTimer = null;
    }
  }
}

// Tabs Logic
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  if (!tabs) return;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const cat = tab.dataset.category || "";
      const isActive = tab.classList.contains("active");

      // [NEW] If already active and has sub-menu, show it
      // Users specifically asked for sub-menus on Series, Movie, Animation
      if (isActive && (cat === 'tv_show' || cat === 'movie' || cat === 'animation')) {
          showCategorySubMenu(cat, tab);
          return;
      }
      // Existing navigation highlight logic
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      if (cat === state.category && state.currentPath === "") return;
      
      showLoader();
      console.log(`[NAV] Switching to category: ${cat}`);

      // Category filter logic
      console.log("[NAV] Tab clicked, category:", cat);

      state.category = cat;
      state.currentPath = "";
      state.pathStack = [];
      state.offset = 0;
      state.library = [];
      state.query = ""; // Reset query when switching categories

      // Special handling for Favorites
      if (cat === "favorites") {
        renderFavorites();
      } else {
        const hero = document.querySelector(".hero-section");
        if (hero) hero.style.display = "block";
        loadLibrary(true); // Force refresh to clear old state and show skeletons
        // initHeroCarousel(); // [REMOVED] Already handled by switchView("library")
      }

      if (ui.container) ui.container.scrollTop = 0;
    });
  });
}

const categorySubMenus = {
  tv_show: ["국내", "해외", "다큐", "뉴스", "교양", "예능", "시사", "음악", "데일리"],
  movie: ["한국영화", "외국영화", "고전영화", "액션", "스릴러", "코미디"],
  animation: ["TV 애니", "극장판", "OVA", "라프텔"]
};

function showCategorySubMenu(category, tabEl) {
  const subItems = categorySubMenus[category];
  if (!subItems) return;

  // Remove existing
  const existing = document.getElementById("category-menu-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "category-menu-overlay";
  overlay.className = "category-menu-overlay";
  
  let menuHtml = `
    <div class="category-menu-content">
      <div class="category-option ${!state.query ? 'active' : ''}" data-query="">전체 (All)</div>
  `;

  subItems.forEach(item => {
      menuHtml += `<div class="category-option ${state.query === item ? 'active' : ''}" data-query="${item}">${item}</div>`;
  });

  menuHtml += `</div>`;
  overlay.innerHTML = menuHtml;
  document.body.appendChild(overlay);

  // Animate in
  setTimeout(() => overlay.classList.add("active"), 10);

  // Handlers
  overlay.onclick = (e) => {
    if (e.target === overlay) {
        overlay.classList.remove("active");
        setTimeout(() => overlay.remove(), 300);
    }
  };

  overlay.querySelectorAll(".category-option").forEach(opt => {
    opt.onclick = () => {
        const q = opt.dataset.query;
        console.log(`[NAV] Sub-category selected: ${q} in ${category}`);
        
        // [FIXED] TV show sub-categories use path navigation
        if (category === 'tv_show') {
          const pathMap = {
            '국내': 'VIDEO/국내TV',
            '드라마': 'VIDEO/국내TV/드라마',
            '해외': 'VIDEO/해외TV',
            '': ''  // "전체" clears path
          };
          state.currentPath = pathMap[q] || '';
          state.pathStack = state.currentPath ? [state.currentPath] : [];
          state.query = '';
        } else {
          state.query = q;
          state.currentPath = '';
          state.pathStack = [];
        }
        
        state.offset = 0;
        state.library = [];
        
        loadLibrary(true);
        
        overlay.classList.remove("active");
        setTimeout(() => overlay.remove(), 300);
    };
  });
}

// Global API Fetch
async function gdsFetch(endpoint, options = {}) {
  if (!state.serverUrl || !state.apiKey) throw new Error("Setup required");

  let baseUrl = state.serverUrl.trim();
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = `http://${baseUrl}`;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/gds_dviewer/normal/${endpoint.replace(/^\//, "")}`;
  const method = options.method || "GET";

  // URL에 API Key 추가 (POST body에 이미 있으면 생략해도 되지만 안전을 위해 유지)
  const separator = url.includes("?") ? "&" : "?";
  const finalUrl = `${url}${separator}apikey=${state.apiKey}`;

  console.log(`[GDS-API] Calling (${method}): ${url}`);

  // Tauri HTTP Plugin Logic
  const tauriHttp =
    window.__TAURI_PERMISSION_HTTP__ ||
    (window.__TAURI__ && window.__TAURI__.http);
  // v2에서는 __TAURI__.http 대신 플러그인을 직접 쓸 수도 있음.
  // 여기서는 fetch API가 자동으로 Tauri에 의해 가로채지지 않는 경우 대비
  const tauriPlugin = window.__TAURI_PLUGIN_HTTP__;

  // Browser fetch fallback with enhanced error reporting
  try {
    const fetchOptions = {
      method,
      headers: options.headers || {},
      body: options.body,
    };

    // 만약 tauriPlugin이 있다면 그것을 먼저 시도
    if (tauriPlugin && tauriPlugin.fetch) {
      try {
        console.log(`[GDS-API] Trying Tauri Plugin (${method})...`);
        const resp = await tauriPlugin.fetch(finalUrl, fetchOptions);
        const data = await resp.json();
        console.log(`[GDS-API] Tauri Plugin Success:`, data);
        return data;
      } catch (perr) {
        console.warn(
          "[GDS-API] Tauri Plugin HTTP failed:",
          perr.message || perr,
        );
      }
    }

    console.log(`[GDS-API] Falling back to Browser Fetch (${method})...`);
    const response = await fetch(finalUrl, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    console.log(`[GDS-API] Success (${method}):`, endpoint);
    return data;
  } catch (e) {
    console.error("[GDS-API] Fetch Error:", e);
    throw e;
  }
}

// Data Loading

// [NEW] Global Loader Controls
function showLoader() {
  const loader = ui.globalLoader;
  if (!loader) return;
  loader.style.width = "30%";
  loader.classList.add("active");
  
  // Progressively move it to 80%
  setTimeout(() => { if (loader.classList.contains("active")) loader.style.width = "70%"; }, 400);
}

function hideLoader() {
  const loader = ui.globalLoader;
  if (!loader) return;
  loader.style.width = "100%";
  setTimeout(() => {
    loader.classList.remove("active");
    setTimeout(() => { loader.style.width = "0"; }, 300);
  }, 200);
}

async function loadLibrary(forceRefresh = false, isAppend = false) {
  const grid = ui.grid;
  const heroSection = ui.heroSection;
  if (!grid) return;

  if (!isAppend) showLoader();

  // [Pagination] Reset or Check
  if (!isAppend) {
    if (state.isFreshLoading) {
      console.warn("[LOAD] Concurrent fresh load blocked");
      return;
    }
    state.isFreshLoading = true;
    state.offset = 0;
    state.hasMore = true;
    state.isLoadingMore = false;
    state.library = []; // Clear current library state reference
    state.seenPaths.clear(); // Reset deduplication set
    state.isFirstFreshLoadDone = false;
  } else {
    if (!state.hasMore || state.isLoadingMore || !state.isFirstFreshLoadDone) return;
    state.isLoadingMore = true;
  }

  // Determine current view mode
  const isFolderCategory = [
    "video",
    "audio",
    "image",
    "document",
    "tv_show",
    "movie",
    "animation",
    "music_video"
  ].includes(state.category);
  const isAtRoot = !state.currentPath;

  /* [DISABLED FOR DEBUG] Cache Logic (Only for first page)
  const cacheKey = `library_${state.category}_${state.currentPath || "root"}_${state.query || ""}`;
  const cachedData = localStorage.getItem(cacheKey);

  if (!isAppend && cachedData && !forceRefresh) {
    try {
      console.log("[CACHE] Populating state from local storage (skipping eager render to avoid flicker)");
      let cachedItems = JSON.parse(cachedData);

      // [FIX] Apply Season Filter to Cache
      if (state.category === 'tv_show' && !state.currentPath) {
        const seasonRegex = /^(season|s|시즌)\s*\d+|specials/i;
        cachedItems = cachedItems.filter(i => {
          if (!i.is_dir) return true;
          return !seasonRegex.test(i.name);
        });
      }

      state.library = cachedItems;
      state.offset = state.library.length; 
      // We purposefully SKIP renderGrid here. We only show skeletons until fresh data arrives
      // to avoid the "flicker" of old data changing to new data.
    } catch (e) {
      console.warn("[CACHE] Corrupt cache:", e);
    }
  } */  
  if (!isAppend) {
    // Show skeletons immediately (even if cache exists, we want to look fresh)
    grid.innerHTML = Array(6)
      .fill('<div class="card skeleton"></div>')
      .join("");
    if (heroSection) heroSection.style.display = "none";
  }


  try {
    if (!isAppend && ui.statusDot) ui.statusDot.className = "status-dot loading";
    let data;

    // Common Params
    const actualOffset = isAppend ? state.offset : 0;
    const commonParams = {
      limit: state.limit.toString(),
      offset: actualOffset.toString(),
      sort_by: state.sortBy,
      sort_order: state.sortOrder
    };

    console.log(`[LOAD] Fetching: isAppend=${isAppend}, offset=${actualOffset}, category=${state.category}`);

    // FETCH LOGIC
    let currentList = [];

    // [OTT HUB] Logic Refinement: Hub Mode vs Folder Mode
    const isHubRoot = ["VIDEO/국내TV", "VIDEO/국내TV/드라마", "VIDEO/국내TV/예능", "VIDEO/해외TV", "VIDEO/영화"].some(p => state.currentPath && (state.currentPath === p || state.currentPath.startsWith(p + "/"))) && (state.pathStack.length <= 1);
    
    if (state.currentPath && isHubRoot) {
      // [MODE: HUB] Flattened discovery view
      console.log(`[OTT-HUB] Entering Hub Mode for: ${state.currentPath}`);
      if (!isAppend) renderSubCategoryChips([]);
      
      const params = new URLSearchParams({ 
        query: "",
        path: state.currentPath,
        recursive: "true",
        is_dir: "true",
        has_metadata: "true", // [NEW] Server-side filtering for performance
        limit: "100",          // [FIX] No longer need 1000
        ...commonParams 
      });
      
      data = await gdsFetch(`search?${params.toString()}`);
      if (data.ret === "success") {
        const rawList = data.data || data.list || data.items || [];
        
        // [SEASON FILTER] Hide subfolders like "Season 1" from the main hub
        const seasonRegex = /Season|시즌|S\d+/i;
        currentList = rawList.filter(item => {
          // Rule 1: Must be a directory with metadata
          if (!item.is_dir || !item.meta_id) return false;
          // Rule 2: Exclude index folders (already handled by has_metadata but double check)
          if (item.name.length <= 2 && !item.meta_poster) return false; 
          // Rule 3: Exclude Season folders
          if (seasonRegex.test(item.name)) return false;
          return true;
        });
        
        console.log(`[OTT-HUB] Flattened Hub items: ${currentList.length} (from ${rawList.length})`);
      }
    } else if (state.currentPath) {
      // [MODE: FOLDER] Standard explorer view for deep diving (Episodes/Seasons)
      console.log(`[OTT-HUB] Entering Folder Mode for: ${state.currentPath}`);
      if (!isAppend) renderSubCategoryChips([]);
      
      const params = new URLSearchParams({ 
        path: state.currentPath,
        recursive: "false", // Only show immediate children
        ...commonParams 
      });
      
      data = await gdsFetch(`list?${params.toString()}`);
      if (data.ret === "success") {
        currentList = data.data || data.items || data.list || [];
        console.log(`[OTT-HUB] Folder items: ${currentList.length}`);
      }
    } else if (isFolderCategory && isAtRoot && !state.query) {
      // Category browsing (folders) → search API with is_dir=true
      const params = new URLSearchParams({
        query: "",
        is_dir: "true",
        recursive: "true",
        has_metadata: "true", // [NEW] Discovery optimization
        ...commonParams
      });
      // [FIXED] FlashPlex is VIDEO-only app
      params.append("category", state.category || "tv_show,movie,animation");
      data = await gdsFetch(`search?${params.toString()}`);

      const rawList = data.list || data.data || [];
      
      const seasonRegex = /Season|시즌|S\d+/i;
      const excludedRoots = ['READING', 'DATA', 'MUSIC', '책', '만화', 'YES24 북클럽'];
      
      currentList = rawList.filter(i => {
          const nameUpper = (i.name || "").toUpperCase();
          if (excludedRoots.includes(nameUpper)) return false;
          if (seasonRegex.test(i.name)) return false; // Hide seasons in hub
          return i.is_dir && i.meta_id; // Standard OTT check
      });

      if (!isAppend) {
        if (data.ret === "success" && state.category) {
          renderSubCategoryChips(currentList); 
        } else {
          hideSubCategoryChips();
        }
      }
    } else {
      // General Search (files) → search API with is_dir=false
      if (!isAppend) hideSubCategoryChips();
      const params = new URLSearchParams({
        query: state.query || "",
        is_dir: "false",
        ...commonParams
      });
      // [FIXED] FlashPlex is VIDEO-only app
      params.append("category", state.category || "tv_show,movie,animation");
      data = await gdsFetch(`search?${params.toString()}`);
      if (data.ret === "success") {
        currentList = data.list || data.data || [];
      }
    }

    if (data && data.ret === "success") {
      // [META-DEBUG] Quick visibility check: does server actually return meta fields?
      if (!isAppend && state.currentPath) {
        const pathParts = String(state.currentPath).split("/").filter(Boolean);
        const parentPath =
          (state.pathStack && state.pathStack.length > 1
            ? state.pathStack[state.pathStack.length - 2]
            : pathParts.slice(0, -1).join("/")) || "";
        const parentMeta = parentPath ? folderMetaCache.get(parentPath) : null;

        const metaProbe = (currentList || []).slice(0, 3).map((it) => ({
          name: it?.name,
          path: it?.path,
          is_dir: it?.is_dir,
          meta_id: it?.meta_id,
          meta_title: it?.meta_title,
          title: it?.title,
          meta_summary_len: (it?.meta_summary || "").length,
          has_meta_poster: !!it?.meta_poster,
          has_poster: !!it?.poster,
        }));
        console.log("[META-DEBUG] path:", state.currentPath);
        if (parentPath) {
          console.log("[META-DEBUG] parentPath:", parentPath);
          console.log("[META-DEBUG] parentMeta(cache):", {
            title: parentMeta?.title || parentMeta?.meta_title || parentMeta?.name || "",
            has_meta_poster: !!parentMeta?.meta_poster,
            has_poster: !!parentMeta?.poster,
            meta_summary_len: (parentMeta?.meta_summary || "").length,
          });
        } else {
          console.log("[META-DEBUG] parentPath: <none>");
        }
        console.table(metaProbe);
      }

      state.isLoadingMore = false;
      let finalItems = currentList;

      // Pagination Check
      if (finalItems.length < state.limit) {
        state.hasMore = false;
      }
      state.offset += finalItems.length;

      // Update State Library
      if (isAppend) {
        state.library = [...state.library, ...finalItems];
      } else {
        state.library = finalItems;
        // [DISABLED] Cache disabled due to localStorage quota issues
        // try {
        //   localStorage.setItem(cacheKey, JSON.stringify(finalItems));
        // } catch (e) {
        //   console.warn("[CACHE] Storage full, skipping cache:", e);
        // }
      }

      // [NEW] Filter out "Season" folders for TV Shows (Only at Root)
      if (state.category === 'tv_show' && !state.currentPath) {
        const seasonRegex = /^(season|s|시즌)\s*\d+|specials/i;
        finalItems = finalItems.filter(i => {
          if (!i.is_dir) return true;
          return !seasonRegex.test(i.name);
        });
      }

      // [NEW] Deduplicate items (Persistent across appends)
      const uniqueItems = finalItems.filter(i => {
        const isCatRoot = !state.currentPath;
        const key = getDedupKey(i, isCatRoot);

        if (state.seenPaths.has(key)) {
            console.log(`[DEDUP] Grouping/Skipping duplicate: ${key} (Name: ${i.name})`);
            return false;
        }
        state.seenPaths.add(key);
        return true;
      });

      // [NEW] FILTER: Only Video Content and exclude READING/DATA/MUSIC unless inside VIDEO
      // [NEW] FILTER: Video Content + Subtitles
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m4v', '.srt', '.smi', '.vtt', '.ass', '.ssa'];
      const excludedRoots = ['READING', 'DATA', 'MUSIC', '책', '만화', 'YES24 북클럽'];
      
      let displayItems = uniqueItems.filter(i => {
        const pathUpper = (i.path || "").toUpperCase();
        const nameUpper = (i.name || "").toUpperCase();
        
        // 1. If it's a file, it MUST be a video
        if (!i.is_dir) {
          const ext = nameUpper.substring(nameUpper.lastIndexOf('.'));
          if (!videoExtensions.includes(ext.toLowerCase())) return false;
        }

        // 2. Path restriction: If at root, only allow 'VIDEO' itself or items that have 'VIDEO/' in their path
        if (!state.currentPath) {
           // Allow 'VIDEO' folder to be seen, but skip others like READING
           if (i.is_dir && excludedRoots.includes(nameUpper)) return false;
        } else {
           // If user enters a folder, but that folder is outside VIDEO (this shouldn't happen with above rule)
           // we still allow it for flexibility unless explicitly excluded
           if (excludedRoots.some(root => pathUpper.startsWith(root + "/") || nameUpper === root)) return false;
        }

        // 4. [NEW] Filter out Season/시즌/Specials folders from root category view
        if (i.is_dir && !state.currentPath) {
          const seasonRegex = /^(season|s|시즌|specials)\s*\d+/i;
          if (seasonRegex.test(i.name)) return false;
        }

        return true;
      });

      if (state.category === 'movie' && !state.currentPath) {
        if (!isAppend) {
          const indexFolders = displayItems.filter(i => i.is_dir && i.name.length === 1);
          renderSubCategoryChips(indexFolders);
        }
        displayItems = displayItems.filter(i => !(i.is_dir && i.name.length === 1));
      } else if (state.category === 'tv_show' && !state.currentPath) {
        if (!isAppend) {
           renderSubCategoryChips(['드라마', '예능', '다큐', '시사', '애니', '뉴스']);
        }
      } else if (!isFolderCategory && !state.currentPath && !isAppend) {
        renderSubCategoryChips(null);
      }

      // Final Render
      if (!isAppend) {
        state.isFirstFreshLoadDone = true; // Mark as done now that fresh data arrived
        ui.statusDot.className = "status-dot success";
        if (heroSection) {
          heroSection.style.display =
            state.currentView === "library" && !state.currentPath
              ? "block"
              : "none";

          if (state.currentView === "library" && !state.currentPath) {
            const heroCarousel = document.getElementById("hero-carousel");
            if (heroCarousel) renderHeroPlaceholder(heroCarousel);
            // Re-init when category/path changes inside library.
            setTimeout(() => initHeroCarousel(), 40);
          }
        }
      }

      renderFolderContextPanel(displayItems);
      renderGrid(grid, displayItems, isFolderCategory, isAppend);

      // [FIX] Ensure scroll is at top after rendering first page
      if (!isAppend && state.currentView === "library") {
        const container = document.querySelector(".content-container");
        if (container) container.scrollTop = 0;
      }
    } else {
      throw new Error(data ? data.ret : "Fetch failed");
    }
  } catch (err) {
    console.error("[LOAD] Fetch Error:", err);
    ui.statusDot.className = "status-dot error";
    renderFolderContextPanel([]);
  } finally {
    hideLoader();
    state.isLoadingMore = false;
    state.isFreshLoading = false;
    if (ui.statusDot && !ui.statusDot.className.includes("error")) {
        ui.statusDot.className = "status-dot";
    }
  }
}

// ... renderSubCategoryChips ...
function renderSubCategoryChips(folders) {
  const chipContainer = document.getElementById("sub-category-chips");
  if (!chipContainer) return;
  document.body.classList.toggle("has-folder-path", !!state.currentPath);
  document.documentElement.classList.toggle("has-folder-path", !!state.currentPath);

  // Clear previous content
  chipContainer.innerHTML = "";
  chipContainer.style.display = "flex";

  // 1. Home / Root Chip
  const homeChip = document.createElement("div");
  homeChip.className = "chip";
  homeChip.tabIndex = 0;
  // Use category name if at root, otherwise "Home" or Category Name
  homeChip.innerText = state.category
    ? state.category.replace("_", " ").toUpperCase()
    : "ALL";
  homeChip.onclick = () => {
    state.currentPath = "";
    state.pathStack = [];
    loadLibrary();
  };
  chipContainer.appendChild(homeChip);

  // Back action as chip instead of a bulky first card in grid
  if (state.currentPath && state.pathStack.length > 0) {
    const backChip = document.createElement("div");
    backChip.className = "chip chip-back";
    backChip.tabIndex = 0;
    backChip.innerText = "← 이전";
    backChip.onclick = () => {
      state.pathStack.pop();
      state.currentPath = state.pathStack[state.pathStack.length - 1] || "";
      loadLibrary();
    };
    chipContainer.appendChild(backChip);
  }

  // Index Folders chips if passed
  if (!state.currentPath && folders && Array.isArray(folders)) {
    // [FIXED] TV Show Subcategories (Path-based navigation)
    if (state.category === 'tv_show') {
      // Map keywords to folder paths
      const pathMap = {
        '국내': 'VIDEO/국내TV',
        '드라마': 'VIDEO/국내TV/드라마',
        '해외': 'VIDEO/해외TV'
      };
      
      const keywords = ['국내', '드라마', '해외'];
      keywords.forEach(keyword => {
        const chip = document.createElement("div");
        chip.className = "chip";
        if (state.currentPath === pathMap[keyword]) chip.classList.add('active');
        chip.innerText = keyword;
        chip.onclick = () => {
          state.currentPath = pathMap[keyword];
          state.pathStack = [pathMap[keyword]];
          state.query = '';  // Clear query
          loadLibrary();
        };
        chipContainer.appendChild(chip);
      });
    } 
    // Movie Index Folders
    else {
      const indexFolders = folders.filter(f => f.is_dir && f.name.length === 1);
      if (indexFolders.length > 0) {
        indexFolders.forEach(idxFolder => {
          const chip = document.createElement("div");
          chip.className = "chip";
          chip.innerText = idxFolder.name;
          chip.onclick = () => {
            state.pathStack.push(idxFolder.path);
            state.currentPath = idxFolder.path;
            loadLibrary();
          };
          chipContainer.appendChild(chip);
        });
      }
    }
  }

  // 2. Parse current path and Create compact breadcrumbs
  if (state.currentPath) {
    const parts = state.currentPath.split("/");
    let builtPath = "";
    
    // Label mapping for friendly breadcrumbs
    const labelMap = {
        'VIDEO': '', // Skip
        '국내TV': '국내 시리즈',
        '해외TV': '해외 시리즈',
        '드라마': '드라마',
        '예능': '예능',
        '영화': '영화',
        '애니메이션': '애니메이션'
    };

    const crumbQueue = [];
    parts.forEach((part, index) => {
      if (!part) return; 
      builtPath += (builtPath ? "/" : "") + part;

      const displayLabel = labelMap[part] !== undefined ? labelMap[part] : part;
      if (displayLabel === '') return; // Skip if mapped to empty (like VIDEO)
      crumbQueue.push({ label: displayLabel, path: builtPath });
    });

    const visibleCrumbs = crumbQueue.slice(-2);
    visibleCrumbs.forEach(({ label, path }) => {
      const breadcrumb = document.createElement("div");
      breadcrumb.className = "chip";
      breadcrumb.innerText = label;
      breadcrumb.onclick = () => {
        state.currentPath = path;
        if (state.pathStack.includes(path)) {
          state.pathStack = state.pathStack.slice(0, state.pathStack.indexOf(path) + 1);
        } else {
          state.pathStack = [path];
        }
        loadLibrary();
      };
      chipContainer.appendChild(breadcrumb);
    });
  }
}

function hideSubCategoryChips() {
  const chipContainer = document.getElementById("sub-category-chips");
  if (chipContainer) chipContainer.style.display = "none";
  document.body.classList.remove("has-folder-path");
  document.documentElement.classList.remove("has-folder-path");
}

function renderFolderContextPanel(items = []) {
  const panel = document.getElementById("folder-context-panel");
  if (!panel) return;

  if (!state.currentPath) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }

  const pathParts = String(state.currentPath).split("/").filter(Boolean);
  const currentName = pathParts[pathParts.length - 1] || "";
  const parentName = pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";
  const seasonMatch = currentName.match(/^(season|s|시즌)\s*([0-9]+)/i);
  const isSeasonFolder = !!seasonMatch;

  const normalizeTitle = (raw) =>
    String(raw || "")
      .replace(/^[【\[]\s*|\s*[】\]]$/g, "")
      .replace(/\((19|20)\d{2}\)\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

  const seriesTitle = normalizeTitle(isSeasonFolder ? parentName : currentName) || "컬렉션";
  const seasonLabel = isSeasonFolder ? `Season ${seasonMatch[2]}` : normalizeTitle(currentName);
  const parentPath =
    (state.pathStack && state.pathStack.length > 1
      ? state.pathStack[state.pathStack.length - 2]
      : pathParts.slice(0, -1).join("/")) || "";
  const currentMeta = folderMetaCache.get(state.currentPath) || null;
  const parentMeta = parentPath ? folderMetaCache.get(parentPath) : null;
  const episodes = (items || []).filter((i) => i && !i.is_dir);
  const subFolders = (items || []).filter((i) => i && i.is_dir);
  const episodeCount = episodes.length;
  const seasonCount = subFolders.length;
  const firstMedia = episodes[0] || (items || []).find((i) => i && !i.is_dir) || items[0] || null;
  const firstFolder = subFolders[0] || null;
  const mediaPath = firstMedia?.path || "";
  const resolvedSeriesTitle =
    normalizeTitle(currentMeta?.title || currentMeta?.meta_title || currentMeta?.album_info?.title || currentMeta?.name) ||
    normalizeTitle(parentMeta?.title || parentMeta?.meta_title || parentMeta?.album_info?.title || parentMeta?.name) ||
    seriesTitle;
  const backdrop = currentMeta?.meta_poster || currentMeta?.album_info?.posters || currentMeta?.poster ||
    parentMeta?.meta_poster || parentMeta?.album_info?.posters || parentMeta?.poster ||
    firstFolder?.meta_poster || firstFolder?.poster ||
    firstMedia?.meta_poster || firstMedia?.poster || (
    mediaPath
      ? `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${toUrlSafeBase64(mediaPath)}&source_id=${firstMedia?.source_id || 0}&w=960&apikey=${state.apiKey}`
      : `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`
  );
  const summary = (
    currentMeta?.meta_summary || currentMeta?.summary || currentMeta?.desc ||
    parentMeta?.meta_summary || parentMeta?.summary || parentMeta?.desc ||
    firstMedia?.meta_summary || firstMedia?.summary || firstMedia?.desc || ""
  ).trim();
  const countLabel = episodeCount > 0 ? `${episodeCount} Episodes` : `${seasonCount} Seasons`;

  panel.innerHTML = `
    <div class="folder-context-art" style="background-image:url('${backdrop}')"></div>
    <div class="folder-context-body">
      <div class="folder-context-top">SERIES CONTEXT</div>
      <h2 class="folder-context-title">${resolvedSeriesTitle}</h2>
      <div class="folder-context-meta">
        <span class="folder-context-chip season">${seasonLabel}</span>
        <span class="folder-context-chip">${countLabel}</span>
        ${(currentMeta?.year || parentMeta?.year) ? `<span class="folder-context-chip">${currentMeta?.year || parentMeta?.year}</span>` : ""}
      </div>
      ${summary ? `<p class="folder-context-summary">${summary}</p>` : ""}
    </div>
  `;
  panel.classList.remove("hidden");
}


// [PHASE 4] Sort UI Setup
function setupSortUI() {
  const btnSort = document.getElementById("btn-sort");
  const overlay = document.getElementById("sort-menu-overlay");
  const closeBtn = document.getElementById("btn-close-sort");
  const options = document.querySelectorAll(".sort-option");

  if (!btnSort || !overlay) return;

  // Toggle Menu
  btnSort.addEventListener("click", () => {
    overlay.classList.remove("hidden");
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      overlay.classList.add("hidden");
    });
  }

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.add("hidden");
    }
  });

  // Handle Option Selection
  options.forEach(opt => {
    opt.addEventListener("click", () => {
      // Update UI
      options.forEach(o => o.classList.remove("active"));
      opt.classList.add("active");

      // Update State
      state.sortBy = opt.dataset.sort;
      state.sortOrder = opt.dataset.order;

      // Close & Reload
      overlay.classList.add("hidden");
      console.log(`[SORT] Changed to ${state.sortBy} (${state.sortOrder})`);

      // Allow UI animation to finish slightly? No, immediate feels snappy.
      loadLibrary(true); // Force refresh with new sort
    });
  });
}

function setupInfiniteScroll() {
  const container = document.querySelector(".content-container"); // Verify this selector in index.html, usually body or main wrapper
  if (!container) return;

  container.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = container;
    // Check if near bottom (300px threshold)
    if (scrollHeight - scrollTop <= clientHeight + 300) {
      if (state.hasMore && !state.isLoadingMore && state.isFirstFreshLoadDone) {
        console.log(`[SCROLL] Loading more items... offset=${state.offset}`);
        loadLibrary(false, true); // forceRefresh=false, isAppend=true
      }
    }
  });
}

function renderGrid(container, items, isFolderCategory = false, isAppend = false) {
  if (!isAppend) {
    container.innerHTML = "";
  }
  const existingKeys = isAppend
    ? new Set(
        Array.from(container.querySelectorAll("[data-path]"))
          .map((el) => el.getAttribute("data-path"))
          .filter(Boolean),
      )
    : new Set();

  // [MOD] Adaptive Grid Class
  if (state.currentPath) {
    container.parentElement.classList.add("folder-view");
    container.classList.add("folder-view");
  } else {
    container.parentElement.classList.remove("folder-view");
    container.classList.remove("folder-view");
  }

  if ((!items || items.length === 0) && !isAppend) {
    container.innerHTML +=
      '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-secondary)">No items found.</div>';
    return;
  }

  if (!items) return; // Nothing to append

  const getBasename = (p) => {
    if (!p) return "";
    const parts = String(p).split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };

  const cleanSeriesLabel = (raw) => {
    if (!raw) return "";
    return String(raw)
      .replace(/^[【\[]\s*|\s*[】\]]$/g, "")
      .replace(/\((19|20)\d{2}\)\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  const newCards = [];
  items.forEach((item, index) => {
    // [NEW] Robust Deduplication check in the grid itself
    // Key MUST match the logic in loadLibrary deduplication
    const isCatRoot = !state.currentPath;
    const itemKey = getDedupKey(item, isCatRoot);

    if (isAppend && existingKeys.has(itemKey)) {
        console.warn("[GRID] skipping duplicate item:", itemKey);
        return; 
    }
    if (isAppend) existingKeys.add(itemKey);

    const card = document.createElement("div");
    card.setAttribute("data-path", itemKey); // Store key for checking
    card.tabIndex = 0; // Make card focusable for remote navigation
    const isFolder = item.is_dir;
    if (isFolder && item.path) {
      folderMetaCache.set(item.path, {
        path: item.path,
        name: item.name,
        title: item.title || item.meta_title || item.album_info?.title || item.name,
        meta_title: item.meta_title || "",
        meta_summary: item.meta_summary || item.summary || item.desc || "",
        summary: item.summary || "",
        desc: item.desc || "",
        meta_poster: item.meta_poster || item.album_info?.posters || "",
        poster: item.poster || "",
        year: item.year || item.album_info?.release_date || "",
        album_info: item.album_info || null,
        source_id: item.source_id || 0,
      });
    }
    const baseCardClass = `card atv-card ${isFolder ? "is-folder" : "is-file"}`;
    card.className = isAppend
      ? `${baseCardClass} batch-hidden`
      : `${baseCardClass} card-loading`;

    // [MOD] Filename Cleaning for Premium Look
    let displayTitle = item.title || item.name;
    if (!item.title) {
      displayTitle = displayTitle
        .replace(/\.(mkv|mp4|avi|srt|ass)$/i, "")
        .replace(
          /[\. ](1080p|720p|2160p|4k|HEVC|H\.264|x264|WEB-DL|DDP5\.1|Atmos|MA|BYNDR|BluRay|XviD|AC3|KOR|FHD|AMZN|NF)/gi,
          " ",
        )
        .trim();
    }
    if (!isFolder) {
      const epMatch = (item.name || "").match(/S(\d{1,2})E(\d{1,3})/i);
      if (epMatch) {
        const epNo = String(parseInt(epMatch[2], 10)).padStart(2, "0");
        displayTitle = `Episode ${epNo}`;
      }
    }
    const seasonMatch = (item.name || "").match(/^(season|s|시즌)\s*([0-9]+)/i);
    const isSeasonFolder = !!(isFolder && seasonMatch);
    if (isSeasonFolder) {
      const seasonNo = seasonMatch[2];
      displayTitle = `Season ${seasonNo}`;
      card.classList.add("season-card");
    }

    // Poster logic with smart fallback
    const noPoster = `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`;
    let poster = item.meta_poster;
    let usePlaceholder = false;

    if (!poster) {
      if (isFolder) {
        poster = item.poster || null;
        if (!poster && item.path) {
          const itemParts = String(item.path).split("/").filter(Boolean);
          const parentPathForItem = itemParts.slice(0, -1).join("/");
          const parentMeta = folderMetaCache.get(parentPathForItem);
          if (parentMeta?.meta_poster) poster = parentMeta.meta_poster;
          else if (parentMeta?.poster) poster = parentMeta.poster;
        }
      } else {
        const category = item.category || "other";
        if (["video", "animation", "music_video"].includes(category)) {
          const bpath = toUrlSafeBase64(item.path || "");
          poster = `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${bpath}&source_id=${item.source_id || 0}&w=400&apikey=${state.apiKey}`;
        } else if (item.category === "audio") {
          const bpath = toUrlSafeBase64(item.path || "");
          poster = `${state.serverUrl}/gds_dviewer/normal/album_art?bpath=${bpath}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
        }
      }
    }

    if (!poster) usePlaceholder = true;

    // [MOD] Cleaner Subtitle for Folders (No more "0 항목")
    const getFolderSubtitle = (item) => {
      if (isSeasonFolder) {
        const parentSeries = cleanSeriesLabel(getBasename(state.currentPath));
        if (parentSeries) return parentSeries;
      }
      if (item.children_count > 0) return `${item.children_count}개 항목`;
      const catMap = { 'tv_show': '시리즈', 'movie': '영화', 'animation': '애니메이션', 'music_video': 'M/V', 'audio': '음악' };
      return catMap[item.category] || "폴더";
    };

    const subtitle = isFolder
      ? getFolderSubtitle(item)
      : (item.meta_summary || item.summary || item.desc || formatSize(item.size));
    const yearMatch = (item.name || "").match(/\b(19|20)\d{2}\b/);
    const yearTag = yearMatch ? yearMatch[0] : "";
    const mediaLabel = isSeasonFolder
      ? "SEASON"
      : (isFolder ? "COLLECTION" : ((item.category || "MEDIA").replace("_", " ").toUpperCase()));

    // [NEW] Extract Tags for Distinction
    const tags = [];
    const nameStr = item.name || "";
    
    // 1. Resolution
    const resMatch = nameStr.match(/(2160p|1080p|720p|4k)/i);
    if (resMatch) tags.push(resMatch[1].toUpperCase());
    
    // 2. Codec/Source (Concise)
    const extraMatch = nameStr.match(/(x265|HEVC|h264|x264|WEB-DL|BluRay)/i);
    if (extraMatch) {
      let tag = extraMatch[1].toUpperCase();
      if (tag === 'X265' || tag === 'HEVC') tag = 'H.265';
      if (tag === 'X264' || tag === 'H264') tag = 'H.264';
      tags.push(tag);
    }

    // 3. Folder/Version hint (if title is identical)
    if (item.title && item.name && item.name !== item.title) {
        // [MOD] If it's a folder name like "[1080p] Movie Name", extract the bracket part
        const bracketMatch = item.name.match(/^[\[\(\{](.*?)[\]\)\}]/);
        if (bracketMatch && !tags.includes(bracketMatch[1].toUpperCase())) {
            const hint = bracketMatch[1].substring(0, 10).toUpperCase(); // Trim if too long
            if (!['VIDEO', 'MUSIC'].includes(hint)) tags.push(hint);
        }
    }

    const tagsHtml = tags.length > 0 
        ? `<div class="card-tags">${tags.map(t => `<span class="card-tag ${t==='4K'||t==='2160P'?'accent':''}">${t}</span>`).join('')}</div>`
        : '<div class="card-tags"></div>';

    if (usePlaceholder) {
      const icon = isFolder
        ? "folder"
        : item.category === "audio"
          ? "music"
          : "film";
      card.innerHTML = `
        <div class="no-poster-placeholder">
          <i data-lucide="${icon}"></i>
          <span>${isFolder ? "Folder" : item.category || "Media"}</span>
        </div>
        <div class="card-info">
          <div class="card-eyebrow">${mediaLabel}${yearTag ? ` · ${yearTag}` : ""}</div>
          <div class="card-title">${displayTitle}</div>
          ${tagsHtml}
          <div class="card-subtitle">${subtitle}</div>
        </div>
      `;
    } else {
      const imgLoading = !isAppend && index < 14 ? "eager" : "lazy";
      card.innerHTML = `
        <div class="card-poster-skeleton"></div>
        <img class="card-poster" src="${poster}" alt="${item.name}" loading="${imgLoading}" onerror="this.onerror=null; this.src='${noPoster}'">
        <div class="card-info">
          <div class="card-eyebrow">${mediaLabel}${yearTag ? ` · ${yearTag}` : ""}</div>
          <div class="card-title">${displayTitle}</div>
          ${tagsHtml}
          <div class="card-subtitle">${subtitle}</div>
        </div>
      `;
    }


    if (isFolder) {
      card.addEventListener("click", () => {
        state.pathStack.push(item.path);
        state.currentPath = item.path;
        loadLibrary();
      });
    } else {
      card.addEventListener("click", () => playVideo(item));
    }
    container.appendChild(card);
    newCards.push(card);
  });

  if (window.lucide) lucide.createIcons();

  // [BATCH REVEAL + PLACEHOLDER] Keep cards visible first, then reveal viewport images together.
  if (newCards.length > 0) {
    const revealBatch = () => {
      newCards.forEach((card) => card.classList.remove("batch-hidden"));
    };

    if (isAppend) {
      requestAnimationFrame(revealBatch);
    } else {
      const contentContainer = document.querySelector(".content-container");
      const gridStyle = window.getComputedStyle(container);
      const colsRaw = (gridStyle.gridTemplateColumns || "").trim();
      const colCount = Math.max(
        1,
        colsRaw && colsRaw !== "none"
          ? colsRaw.split(/\s+/).length
          : 1,
      );

      const firstCard = newCards[0];
      const cardHeight =
        (firstCard && firstCard.getBoundingClientRect().height) || 320;
      const viewportHeight =
        (contentContainer && contentContainer.clientHeight) || window.innerHeight || 800;
      const estimatedRows = Math.max(2, Math.ceil(viewportHeight / Math.max(cardHeight, 1)) + 1);
      const preloadCount = Math.min(newCards.length, colCount * estimatedRows);
      const cardsWithImages = newCards
        .map((card) => ({ card, img: card.querySelector("img.card-poster") }))
        .filter(({ img }) => !!img);

      const batchTargets = cardsWithImages.slice(0, preloadCount);
      const deferredTargets = cardsWithImages.slice(preloadCount);

      // Below-the-fold cards can reveal individually when each image is ready.
      deferredTargets.forEach(({ card, img }) => {
        if (img.complete) {
          card.classList.remove("card-loading");
          return;
        }
        const revealOne = () => card.classList.remove("card-loading");
        img.addEventListener("load", revealOne, { once: true });
        img.addEventListener("error", revealOne, { once: true });
      });

      if (batchTargets.length === 0) {
        requestAnimationFrame(() => {
          newCards.forEach((card) => card.classList.remove("card-loading"));
        });
      } else {
        const waitForImgs = batchTargets.map(({ img }) => {
          const waitDecode = () => {
            if (typeof img.decode === "function") {
              return img.decode().catch(() => {});
            }
            return Promise.resolve();
          };

          if (img.complete) {
            return waitDecode();
          }

          return new Promise((resolve) => {
            const onDone = () => waitDecode().finally(resolve);
            img.addEventListener("load", onDone, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
        });

        Promise.race([
          Promise.all(waitForImgs),
          new Promise((resolve) => setTimeout(resolve, 3800)),
        ]).then(() =>
          requestAnimationFrame(() => {
            batchTargets.forEach(({ card }) => card.classList.remove("card-loading"));
          }),
        );
      }
    }
  }

  // [REMOTE] Auto-focus first card if coming from tabs or if no focus
  if (
    state.currentView === "library" &&
    !document.activeElement.classList.contains("card")
  ) {
    const firstCard = container.querySelector(".card");
    if (firstCard) firstCard.focus({ preventScroll: true });
  }
}

// Search Logic
function setupSearch() {
  let timeout = null;
  ui.searchInput.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    document.getElementById("search-placeholder").style.display = query
      ? "none"
      : "flex";

    clearTimeout(timeout);
    timeout = setTimeout(() => performSearch(query), 600);
  });
}

async function performSearch(query) {
  const grid = document.getElementById("search-results");
  if (!query) {
    grid.innerHTML = "";
    return;
  }

  // Don't clear grid immediately to avoid flicker; only show loading if it takes too long
  const currentItems = grid.querySelectorAll(".card").length;
  if (currentItems === 0) {
    grid.innerHTML = Array(4)
      .fill('<div class="card skeleton"></div>')
      .join("");
  }

  const invoke =
    window.__TAURI__ && window.__TAURI__.core
      ? window.__TAURI__.core.invoke
      : null;

  try {
    if (invoke) {
      console.log(`[SEARCH] Background search for "${query}"...`);
      const data = await invoke("search_gds", {
        query: query,
        serverUrl: state.serverUrl,
        apiKey: state.apiKey,
        category: "video",
      });
      if (data && (data.ret === "success" || data.list)) {
        renderGrid(grid, data.list || data.data);
      }
    } else {
      console.log("[SEARCH] Falling back to frontend fetch...");
      const params = new URLSearchParams({
        query,
        is_dir: "false",
        limit: "50",
        category: "video",
      });
      const data = await gdsFetch(`search?${params.toString()}`);
      if (data && data.ret === "success") {
        renderGrid(grid, data.list || data.data);
      }
    }
  } catch (err) {
    console.error("[SEARCH] Error:", err);
  }
}

function formatTime(seconds) {
  if (isNaN(seconds)) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const m_str = m.toString().padStart(2, "0");
  const s_str = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${m_str}:${s_str}` : `${m_str}:${s_str}`;
}

// [NEW] Robust Deduplication Key Generator
function getDedupKey(item, isCatRoot) {
  if (!item.path) return (item.name || "") + (item.size || 0);
  
  const normPath = item.path.normalize('NFC');
  if (!isCatRoot) return normPath;

  // For Category Root (Movie/TV), be aggressive to catch duplicates in different folders
  // Use title if available, fallback to name
  const rawTitle = (item.title || item.name || "").normalize('NFC').toUpperCase();
  
  // Try to extract Season/Episode info to avoid merging episodes at root
  const epMatch = rawTitle.match(/S\d{2}E\d{2}/i) || rawTitle.match(/E\d{2,3}/i);
  const epSuffix = epMatch ? `_${epMatch[0].toUpperCase()}` : "";

  // [MOD] Extract quality info to KEEP it in the key (avoid merging 4K/1080p)
  const qualityMatch = rawTitle.match(/(2160p|1080p|720p|4k|x265|HEVC|h264|x264)/i);
  const qualitySuffix = qualityMatch ? `_${qualityMatch[1].toUpperCase()}` : "";

  // Clean aggressively: remove common release group tags, years, etc. (but keep quality info in suffix)
  const cleaned = rawTitle
    .replace(/\.(mp4|mkv|avi|mov|ts|m4v|webm)$/i, "") // extension
    .replace(/[\(\[\{]\d{4}[\)\}\]]/g, "") // Years in any bracket (2024), [2024], {2024}
    .replace(/[\(\[\{].*?[\)\}\]]/g, "") // Any other brackets/tags [4K], [HDR], (Director's Cut) 
    .replace(/[._\-]/g, " ") // Replace separators with space
    .replace(/[^가-힣A-Z0-9\s]/g, "") // Remove special characters entirely except KR/EN/Digits
    .replace(/\s+/g, "") // Remove all whitespace for comparison
    .trim();
  
  const ext = normPath.substring(normPath.lastIndexOf('.')).toUpperCase();
  
  // Combine cleaned name with version info
  return `name_${cleaned}${epSuffix}${qualitySuffix}${ext}` || `path_${normPath}`;
}


// [NEW] URL-safe Base64 Helper for UTF-8 strings
function toUrlSafeBase64(str) {
  if (!str) return "";
  try {
    // 1. Convert UTF-8 to Latin1 (trick for btoa)
    const latin1 = unescape(encodeURIComponent(str));
    // 2. Standard Base64
    const b64 = btoa(latin1);
    // 3. Convert to URL-safe (+ to -, / to _) and remove padding
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (e) {
    console.error("[B64] Encoding failed:", e);
    return "";
  }
}



// [Redundant startWebPlayer removed - Logic moved to playVideo]

// Settings Logic
function setupSettings() {
  const serverUrlInput = document.getElementById("server-url");
  const apiKeyInput = document.getElementById("api-key");
  const btnSave = document.getElementById("save-settings");
  const btnTestConnection = document.getElementById("btn-test-connection");
  const btnSaveCategories = document.getElementById("save-categories");
  const btnResetCategories = document.getElementById("btn-reset-categories");
  const categoryMappingList = document.getElementById("category-mapping-list");

  serverUrlInput.value = state.serverUrl;
  apiKeyInput.value = state.apiKey;

  // [NEW] Subtitle Settings Initialization
  const subtitleSizeInput = document.getElementById("subtitle-size");
  const subtitlePosInput = document.getElementById("subtitle-pos");
  const subtitleSizeVal = document.getElementById("subtitle-size-val");
  const subtitlePosVal = document.getElementById("subtitle-pos-val");

  // Load from state/localStorage
  state.subtitleSize = parseFloat(
    localStorage.getItem("flashplex_sub_size") || "1.0",
  );
  state.subtitlePos = parseFloat(
    localStorage.getItem("flashplex_sub_pos") || "0.0",
  );

  if (subtitleSizeInput) {
    subtitleSizeInput.value = state.subtitleSize;
    subtitleSizeVal.innerText = state.subtitleSize.toFixed(1) + "x";
    subtitleSizeInput.addEventListener("input", (e) => {
      state.subtitleSize = parseFloat(e.target.value);
      subtitleSizeVal.innerText = state.subtitleSize.toFixed(1) + "x";
      localStorage.setItem("flashplex_sub_size", state.subtitleSize);
      // [NEW] Apply in real-time if native player is active
      const inv = getTauriInvoke();
      if (state.isNativeActive && inv) {
        inv("set_subtitle_style", { scale: state.subtitleSize, pos: Math.round(state.subtitlePos) });
      }
    });
  }

  if (subtitlePosInput) {
    subtitlePosInput.value = state.subtitlePos;
    subtitlePosVal.innerText = state.subtitlePos.toFixed(0) + "px";
    subtitlePosInput.addEventListener("input", (e) => {
      state.subtitlePos = parseFloat(e.target.value);
      subtitlePosVal.innerText = state.subtitlePos.toFixed(0) + "px";
      localStorage.setItem("flashplex_sub_pos", state.subtitlePos);
      // [NEW] Apply in real-time if native player is active
      const inv = getTauriInvoke();
      if (state.isNativeActive && inv) {
        inv("set_subtitle_style", { scale: state.subtitleSize, pos: Math.round(state.subtitlePos) });
      }
    });
  }

  // Tab Switching Logic
  document.querySelectorAll(".s-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".s-tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".stab-content")
        .forEach((c) => c.classList.remove("active"));

      tab.classList.add("active");
      const contentId = `stab-${tab.dataset.stab}`;
      document.getElementById(contentId).classList.add("active");

      if (tab.dataset.stab === "category") {
        loadCategoryMapping();
      }
    });
  });

  async function loadCategoryMapping() {
    if (!state.serverUrl || !state.apiKey) return;

    try {
      const data = await gdsFetch("get_category_mapping");
      if (data.ret === "success") {
        state.categoryMapping = data.mapping;
        renderCategoryMappingRows(data.mapping);
      }
    } catch (err) {
      console.error("Failed to load mapping:", err);
    }
  }

  function renderCategoryMappingRows(mapping) {
    categoryMappingList.innerHTML = "";
    Object.entries(mapping).forEach(([cat, keywords]) => {
      const row = document.createElement("div");
      row.className = "category-row";
      row.innerHTML = `
        <label class="category-label">${cat.replace("_", " ")}</label>
        <input type="text" class="category-input" data-cat="${cat}" value="${keywords.join(", ")}" />
      `;
      categoryMappingList.appendChild(row);
    });
  }

  async function saveCategoryMapping() {
    const inputs = categoryMappingList.querySelectorAll(".category-input");
    const newMapping = {};
    inputs.forEach((input) => {
      const cat = input.dataset.cat;
      const keywords = input.value
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k);
      newMapping[cat] = keywords;
    });

    console.log("[DEBUG] Saving mapping:", newMapping);

    const originalHTML = btnSaveCategories.innerHTML;
    try {
      btnSaveCategories.disabled = true;
      btnSaveCategories.innerHTML =
        '<i data-lucide="loader-2" class="animate-spin"></i> Saving...';
      if (window.lucide) lucide.createIcons();

      const bodyParams = new URLSearchParams();
      bodyParams.append("mapping", JSON.stringify(newMapping));
      bodyParams.append("apikey", state.apiKey);

      const data = await gdsFetch(`save_category_mapping`, {
        method: "POST",
        body: bodyParams,
      });

      console.log("[DEBUG] Save response:", data);

      if (data.ret === "success") {
        state.categoryMapping = newMapping;
        btnSaveCategories.innerHTML =
          '<i data-lucide="check-circle"></i> Saved & Synced!';
        btnSaveCategories.classList.add("btn-success");
        if (window.lucide) lucide.createIcons();

        setTimeout(() => {
          btnSaveCategories.innerHTML = originalHTML;
          btnSaveCategories.classList.remove("btn-success");
          if (window.lucide) lucide.createIcons();
        }, 3000);

        loadLibrary(); // Reload to apply changes
      } else {
        alert("❌ Failed to save: " + (data.msg || "Unknown error"));
        btnSaveCategories.innerHTML = originalHTML;
      }
    } catch (err) {
      console.error("[ERROR] Save failed:", err);
      alert("❌ Error saving mapping: " + err.message);
      btnSaveCategories.innerHTML = originalHTML;
    } finally {
      btnSaveCategories.disabled = false;
    }
  }

  btnResetCategories.addEventListener("click", () => {
    if (confirm("Reset categories to defaults?")) {
      const defaults = {
        audio: ["MUSIC", "가수", "곡", "ARTIST", "ALBUM"],
        animation: ["ANIMATION", "애니", "라프텔", "laftel", "극장판 애니"],
        movie: ["MOVIE", "영화", "극장판", "film", "cinema", "시네마"],
        tv_show: [
          "TV",
          "DRAMA",
          "드라마",
          "예능",
          "TV-SHOW",
          "SHOW",
          "미드",
          "series",
          "시리즈",
        ],
        video: ["VIDEO", "영상", "녹화"],
        music_video: ["MV", "뮤직비디오", "직캠", "M/V"],
      };
      renderCategoryMappingRows(defaults);
    }
  });

  btnSaveCategories.addEventListener("click", saveCategoryMapping);

  async function testConnection() {
    const url = serverUrlInput.value.trim();
    const key = apiKeyInput.value.trim();

    if (!url || !key) {
      alert("Please enter both Server URL and API Key");
      return;
    }

    btnTestConnection.disabled = true;
    btnTestConnection.innerHTML =
      '<i data-lucide="loader-2" class="animate-spin"></i> Testing...';
    lucide.createIcons();

    try {
      const testUrl = `${url.replace(/\/$/, "")}/gds_dviewer/normal/search?query=&limit=1&apikey=${key}`;
      const response = await fetch(testUrl);
      const data = await response.json();
      if (data.ret === "success" || data.list) {
        alert("✅ Connection successful!");
      } else {
        alert("❌ Server responded but: " + (data.msg || "Check logs"));
      }
    } catch (err) {
      console.error("Test failed:", err);
      alert(
        "❌ Connection failed. Check URL/Key and CORS.\nError: " + err.message,
      );
    } finally {
      btnTestConnection.disabled = false;
      btnTestConnection.innerHTML = '<i data-lucide="zap"></i> Test';
      lucide.createIcons();
    }
  }

  function saveSettings() {
    const url = serverUrlInput.value.trim().replace(/\/$/, "");
    const key = apiKeyInput.value.trim();

    if (!url || !key) {
      alert("Please enter both Server URL and API Key.");
      return;
    }

    state.serverUrl = url;
    state.apiKey = key;

    localStorage.setItem("gds_server_url", url);
    localStorage.setItem("gds_api_key", key);

    loadLibrary();
    switchView("library");
  }

  btnSave.addEventListener("click", saveSettings);
  btnTestConnection.addEventListener("click", testConnection);
}

// Global Buttons
function setupButtons() {
  // btn-refresh removed


  const exitNativeBtn = document.getElementById("btn-exit-native");
  if (exitNativeBtn) {
    exitNativeBtn.addEventListener("click", () => {
      document.body.classList.remove("player-active");
      document.documentElement.classList.remove("native-player-active");
      document.body.classList.remove("native-player-active");
      
      // [FIX] Ensure we clean up bpath and standardized URLs if they were set globally
      window.currentMpvUrl = null;

      // [NEW] Explicitly tell Rust to kill mpv
      const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
      if (invoke) invoke("close_native_player").catch(console.error);
      state.isNativeActive = false;
      state.nativeSource = null;

      if (ui.playerOverlay) ui.playerOverlay.classList.remove("active");

      // Force restoration of UI visibility
      const elementsToRestore = [
        ".content-container",
        ".glass-header",
        ".view-header",
        ".bottom-nav",
      ];
      elementsToRestore.forEach((sel) => {
        const el = document.querySelector(sel);
        if (el) {
          el.style.opacity = "1";
          el.style.pointerEvents = "auto";
          el.style.display = ""; // Reset display if it was manipulated
        }
      });
    });
  }

  if (ui.btnHeaderSettings) {
    ui.btnHeaderSettings.addEventListener("click", () => {
      console.log("[NAV] Header settings button clicked");
      switchView("settings");
    });
  }
}

// Player Logic
function setupPlayer() {
  if (!ui.mainPlayer) return;

  const player = ui.mainPlayer;
  let hideTimeout;

  const showUI = () => {
    if (ui.customControls) ui.customControls.classList.remove("hidden");
    if (ui.playerHeader) ui.playerHeader.classList.remove("hidden");
    if (ui.btnExitNative) ui.btnExitNative.classList.remove("hidden");
    document.body.style.cursor = "default";

    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      // Auto-hide if video is playing OR if native player is active
      if (!player.paused || state.isNativeActive) {
        if (ui.customControls) ui.customControls.classList.add("hidden");
        if (ui.playerHeader) ui.playerHeader.classList.add("hidden");
        if (ui.btnExitNative) ui.btnExitNative.classList.add("hidden");
        document.body.style.cursor = "none";
      }
    }, 3000);
  };

  // Activity listeners
  document.addEventListener("mousemove", showUI);
  document.addEventListener("keydown", showUI);
  player.addEventListener("play", showUI);

  // Time Sync
  player.addEventListener("timeupdate", () => {
    if (!player.duration) return;
    const percent = (player.currentTime / player.duration) * 100;
    if (ui.progressBarFill) ui.progressBarFill.style.width = percent + "%";
    if (ui.progressSlider) ui.progressSlider.value = percent;
    if (ui.currentTime)
      ui.currentTime.textContent = formatTime(player.currentTime);
  });

  player.addEventListener("loadedmetadata", () => {
    if (ui.totalTime) ui.totalTime.textContent = formatTime(player.duration);
    if (ui.progressSlider) ui.progressSlider.value = 0;
    if (ui.progressBarFill) ui.progressBarFill.style.width = "0%";
    showUI();
  });

  // Seeking
  if (ui.progressSlider) {
    ui.progressSlider.addEventListener("input", (e) => {
      const time = (e.target.value / 100) * player.duration;
      player.currentTime = time;
    });
  }

  // Play/Pause Toggle
  const togglePlay = () => {
    if (player.paused) player.play();
    else player.pause();
    showUI();
  };

  if (ui.btnPlayPause) ui.btnPlayPause.addEventListener("click", togglePlay);
  if (ui.btnCenterPlay) ui.btnCenterPlay.addEventListener("click", togglePlay);
  player.addEventListener("click", togglePlay);

  player.addEventListener("play", () => {
    const playIcons = document.querySelectorAll('[data-lucide="play"]');
    playIcons.forEach((icon) => {
      icon.setAttribute("data-lucide", "pause");
      if (window.lucide) lucide.createIcons();
    });
    if (ui.btnCenterPlay) ui.btnCenterPlay.classList.remove("show");
  });

  player.addEventListener("pause", () => {
    const pauseIcons = document.querySelectorAll('[data-lucide="pause"]');
    pauseIcons.forEach((icon) => {
      icon.setAttribute("data-lucide", "play");
      if (window.lucide) lucide.createIcons();
    });
    if (ui.btnCenterPlay) ui.btnCenterPlay.classList.add("show");
    showUI();
  });

  // Close player toggle
  const btnClose = document.getElementById("btn-close-player");
  if (btnClose) {
    btnClose.addEventListener("click", closePlayer);
  }
}

function closePlayer() {
  console.log("[PLAY] Closing player");

  // Close native player if active
  if (state.isNativeActive) {
    const invoke =
      window.__TAURI__ && window.__TAURI__.core
        ? window.__TAURI__.core.invoke
        : window.__TAURI__
          ? window.__TAURI__.invoke
          : null;
    if (invoke) {
      invoke("close_native_player").catch((e) =>
        console.error("[NATIVE] Close failed:", e),
      );
    }
    state.isNativeActive = false;
    stopNativeStatePolling();
    state.nativeSource = null;
    updateNativeTransparency(false);

    // Restore Web Player UI
    if (ui.mainPlayer) {
      ui.mainPlayer.style.display = "block";
    }
    if (ui.premiumOsc) ui.premiumOsc.classList.add("hidden"); // Hide OSC
    if (ui.playerHeader) ui.playerHeader.style.display = "flex"; // Restore Header
  }

  if (ui.mainPlayer) {
    ui.mainPlayer.pause();
    ui.mainPlayer.src = "";
    while (ui.mainPlayer.firstChild) {
      ui.mainPlayer.removeChild(ui.mainPlayer.firstChild);
    }
  }

  if (ui.playerOverlay) ui.playerOverlay.classList.remove("active");
  document.body.classList.remove("player-active");
}

function startNativeStatePolling() {
  if (nativeStatePollTimer) return;
  const invoke = getTauriInvoke();
  if (!invoke) return;
  console.log("[PLAYER] Starting polling loop for native state...");
  nativeStatePollTimer = setInterval(() => {
    if (!state.isNativeActive) return;
    invoke("get_mpv_state")
      .then((data) => {
        if (!data) return;
        state.nativePos = typeof data.position === "number" ? data.position : 0;
        state.nativeDuration = typeof data.duration === "number" ? data.duration : 0;
        state.nativePaused = !!data.pause;

        if (ui.oscCurrentTime) ui.oscCurrentTime.textContent = formatTime(state.nativePos);
        if (ui.oscTotalTime) ui.oscTotalTime.textContent = formatTime(state.nativeDuration);
        if (ui.oscSubtitle) {
          ui.oscSubtitle.textContent = `${formatTime(state.nativePos)} / ${formatTime(state.nativeDuration)}`;
        }

        if (ui.oscHwBadge) {
          const rawHw = (data.hwdec || "").toLowerCase();
          if (state.lastHwDec !== rawHw) {
            console.log("[PLAYER] HW Status:", rawHw);
            state.lastHwDec = rawHw;
          }
          const isHw = rawHw !== "no" && rawHw !== "" && (
            rawHw.includes("videotoolbox") ||
            rawHw.includes("vtb") ||
            rawHw.includes("auto") ||
            rawHw.includes("yes")
          );
          ui.oscHwBadge.textContent = isHw ? "HW" : "SW";
          ui.oscHwBadge.className = isHw ? "hw-badge hw" : "hw-badge sw";
        }

        const percent = state.nativeDuration > 0 ? (state.nativePos / state.nativeDuration) * 100 : 0;
        if (ui.oscProgressFill) ui.oscProgressFill.style.width = percent + "%";
        if (ui.oscProgressSlider && !state.isDraggingOscSlider) ui.oscProgressSlider.value = percent;

        const icon = state.nativePaused ? "play" : "pause";
        if (ui.btnOscPlayPause) {
          ui.btnOscPlayPause.innerHTML = `<i data-lucide="${icon}"></i>`;
          if (window.lucide) lucide.createIcons();
        }
        if (ui.btnOscCenterPlay) {
          ui.btnOscCenterPlay.style.display = state.nativePaused ? "flex" : "none";
          ui.btnOscCenterPlay.innerHTML = `<i data-lucide="${icon}"></i>`;
          if (window.lucide) lucide.createIcons();
        }
      })
      .catch(() => {});
  }, 500);
}

function stopNativeStatePolling() {
  if (nativeStatePollTimer) {
    clearInterval(nativeStatePollTimer);
    nativeStatePollTimer = null;
  }
}

// [NEW] Native Mode transparency helper
function updateNativeTransparency(active) {
  console.log(`[UI] updateNativeTransparency: ${active}`);
  if (active) {
    document.body.classList.add("native-player-active");
    if (ui.videoContainer)
      ui.videoContainer.style.backgroundColor = "transparent";
    // Do NOT hide headers or tabs here, css handles opacity
  } else {
    document.body.classList.remove("native-player-active");
    if (ui.videoContainer) {
      ui.videoContainer.style.backgroundColor = "#000";
      // Force repaint
      ui.videoContainer.style.display = "none";
      ui.videoContainer.offsetHeight; // trigger reflow
      ui.videoContainer.style.display = "flex";
    }
  }
}

function playVideo(item) {
  window.currentPlayItem = item; // Debugging
  if (window.tlog) window.tlog(`[PLAY] Entry for: ${item?.name || 'null'}`);
  
  if (!item) {
     if (window.tlog) window.tlog("[PLAY] Error: No item provided");
     return;
  }
  
  // Defensive recovery if UI elements are lost
  if (!ui.playerOverlay) {
      if (window.tlog) window.tlog("[PLAY] UI objects missing, re-initializing...");
      initElements();
  }
  
  const displayTitle = item.meta_title || item.title || item.name || "Unknown";
  if (window.tlog) window.tlog(`[PLAY] Attempting: ${displayTitle}`);

  // [NEW] Handle Folder Playback (e.g. from Hero Carousel)
  if (item.is_dir) {
    if (window.tlog) window.tlog("[PLAY] Folder detected, resolving first video...");
    const bpath = toUrlSafeBase64(item.path || "");
    // [FIX] Use existing list_directory API instead of non-existent 'playlist'
    const endpoint = `explorer/list?bpath=${bpath}&source_id=${item.source_id || 0}&limit=50&apikey=${state.apiKey}`;
    
    if (window.tlog) window.tlog(`[PLAY] Fetching folder contents: ${endpoint}`);
    
    gdsFetch(endpoint)
      .then(data => {
        const items = data.list || data.data || [];
        // Find first playable video file (not a folder)
        const videoExtensions = ['mp4', 'mkv', 'avi', 'webm', 'mov', 'm4v', 'ts'];
        const firstVideo = items.find(f => {
          if (f.is_dir) return false;
          const ext = (f.name || "").split('.').pop().toLowerCase();
          return videoExtensions.includes(ext);
        });
        
        if (firstVideo) {
          if (window.tlog) window.tlog(`[PLAY] Resolved to: ${firstVideo.name}`);
          playVideo(firstVideo);
        } else {
          // Maybe it's a nested folder (Season 1, etc.) - try to go one level deeper
          const subFolder = items.find(f => f.is_dir);
          if (subFolder) {
            if (window.tlog) window.tlog(`[PLAY] No direct video, diving into: ${subFolder.name}`);
            playVideo(subFolder); // Recursive call
          } else {
            if (window.tlog) window.tlog("[PLAY] No videos found in folder");
            if (ui.playerTitle) ui.playerTitle.textContent = "No playable content found";
          }
        }
      }).catch(err => {
        if (window.tlog) window.tlog(`[PLAY] GDS Fetch error: ${err.message || err}`);
        console.error("[PLAY] Failed to fetch folder contents:", err);
      });
    return;
  }

  // 1. Show Overlay & Setup Metadata
  if (ui.playerOverlay) ui.playerOverlay.classList.add("active");
  const cleanTitle = displayTitle;
  if (ui.playerTitle) ui.playerTitle.textContent = cleanTitle + " (Loading...)";

  const premiumTitle = document.getElementById("player-video-title");
  if (premiumTitle) premiumTitle.textContent = cleanTitle;

  // 2. Clear Existing Player State
  if (ui.mainPlayer) {
    ui.mainPlayer.pause();
    ui.mainPlayer.src = "";
    while (ui.mainPlayer.firstChild) {
      ui.mainPlayer.removeChild(ui.mainPlayer.firstChild);
    }
  }

  // Reset progress and slider (Force 0 and 100 max)
  if (ui.progressBarFill) ui.progressBarFill.style.width = "0%";
  if (ui.progressSlider) {
    // Definitive Fix: Force DOM Re-render of the range thumb
    const slider = ui.progressSlider;
    slider.min = "0";
    slider.max = "100";
    slider.value = "0";
    slider.setAttribute("value", "0");

    // Nudge the element to force TV browser repaint
    slider.style.opacity = "0.99";
    setTimeout(() => {
      slider.style.opacity = "1";
      slider.value = "0";
      console.log("[DEBUG] Seek bar thumb forced to 0%");
    }, 50);

    // [NEW] Log the attempt to play
    console.log("[PLAY] playVideo item:", item.name);

    requestAnimationFrame(() => {
      if (ui.progressSlider) {
        ui.progressSlider.value = "0";
        console.log(
          "[DEBUG] Slider value reset confirmed:",
          ui.progressSlider.value,
        );
      }
    });
  }
  if (ui.currentTime) ui.currentTime.textContent = "00:00";
  if (ui.totalTime) ui.totalTime.textContent = "00:00";

  // 3. Robust URL & Extension Parsing
  // [FIX] Use path= for stream (proven) and bpath= for subtitles (solves encoding issues there)
  // [FIX] Apply NFC normalization for macOS/Linux compatibility
  let cleanPath = (item.path || "").normalize("NFC");

  // [FIX] Ensure path starts with a slash if it doesn't - common for GDS server
  if (cleanPath && !cleanPath.startsWith("/")) {
    cleanPath = "/" + cleanPath;
  }

  const bpath = toUrlSafeBase64(cleanPath);
  const encodedPath = encodeURIComponent(cleanPath);

  let streamUrl = `${state.serverUrl}/gds_dviewer/normal/stream?bpath=${bpath}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
  const subtitleUrl = bpath ? `${state.serverUrl}/gds_dviewer/normal/external_subtitle?bpath=${bpath}&source_id=${item.source_id || 0}&apikey=${state.apiKey}` : null;

  const extension = (cleanPath || "").split(".").pop().toLowerCase();
  console.log("[PLAY] Extension Detected:", extension);
  console.log("[PLAY] Standardized Stream URL (path):", streamUrl);
  console.log("[PLAY] Standardized Subtitle URL (bpath):", subtitleUrl);

  // 4. [HYBRID] Native Playback Routing
  const isAudio =
    item.category === "audio" || ["flac", "mp3", "m4a"].includes(extension);



  // Tauri v2 invoke access detection
  const invoke = getTauriInvoke();

  console.log("[PLAYBACK] Routing Diagnostics:", {
    hasTauri: !!window.__TAURI__,
    hasCore: !!(window.__TAURI__ && window.__TAURI__.core),
    hasInvoke: !!invoke,
    isDesktop,
    isAudio,
  });

  if (isDesktop && !isAudio && !invoke) {
    console.error("[PLAYBACK] Native player required but Tauri backend not found.");
    return;
  }

  if (invoke) {
    // Desktop Native (MPV for Video)
    if (isDesktop && !isAudio) {
      console.log("[PLAYBACK] Launching Native MPV for:", cleanTitle);
      state.nativeSource = { title: cleanTitle, url: streamUrl, subtitleUrl };

      // [FIX] Force UI Redraw / Transparency Refresh
      document.body.classList.remove("native-player-active");
      document.documentElement.classList.remove("native-player-active");
      void document.body.offsetWidth; // Force Reflow

      // Add player-active class for transparency
      document.body.classList.add("native-player-active");
      document.documentElement.classList.add("native-player-active");

      const cmd = "launch_mpv_player";
      state.isNativeActive = true;

      invoke(cmd, {
        title: cleanTitle,
        url: streamUrl,
        subtitle_url: subtitleUrl,
      })
        .then(() => {
          console.log(`[PLAYBACK] ${cmd} Success`);
          startNativeStatePolling();
          invoke("resize_native_player", {}).catch(() => {});
          invoke("set_quality_profile", { profile: normalizeQualityProfile(state.qualityProfile) }).catch(() => {});

          // [UI] Success - Switch to Native UI
          if (ui.premiumOsc) {
            ui.premiumOsc.classList.remove("hidden");
            ui.premiumOsc.style.display = "flex";
          }
          if (ui.customControls) ui.customControls.style.display = "none";
          if (ui.playerHeader) ui.playerHeader.style.display = "none";

          ui.playerOverlay.classList.add("active");

          // [INTEL-MAC-FIX] Force transparency updates
          document.body.classList.add("native-player-active");
          if (typeof updateNativeTransparency === 'function') {
            updateNativeTransparency(true);
          } else {
            // Inline fallback if function missing in main.js
            if (ui.videoContainer) ui.videoContainer.style.backgroundColor = "transparent";
          }

          // [NEW] Check/Auto-select Subtitles after delay
          setTimeout(() => {
            checkAndSelectSubtitles();
            
            // [NEW] Use native_log for terminal visibility
            const videoInfoUrl = `${state.serverUrl}/gds_dviewer/normal/get_video_info?bpath=${bpath}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
            if (window.tlog) window.tlog(`[SUB] Fetching video info: ${videoInfoUrl}`);
            
            fetch(videoInfoUrl)
              .then(r => r.json())
              .then(res => {
                if (window.tlog) window.tlog(`[SUB] API Response: ${res.ret}, tracks: ${res.data?.subtitles?.length || 0}`);
                if (res.ret === 'success' && res.data && res.data.subtitles) {
                  const sidecars = res.data.subtitles.filter(s => s.type === 'sidecar');
                  if (window.tlog) window.tlog(`[SUB] Sidecar match count: ${sidecars.length}`);
                  
                  const sidecarPromises = sidecars.map(s => {
                    let fullUrl = s.url.startsWith('http') ? s.url : `${state.serverUrl}${s.url}&apikey=${state.apiKey}`;
                    if (window.tlog) window.tlog(`[SUB] Injecting: ${s.title}`);
                    return invoke("native_sub_add", { url: fullUrl, title: s.title }).catch(err => {
                         console.warn("[SUB] native_sub_add failed:", err);
                    });
                  });

                  // Once all sidecars are sent, wait a bit and re-run selection to pick the best one
                  Promise.all(sidecarPromises).then(() => {
                    setTimeout(() => {
                        if (window.tlog) window.tlog("[SUB] Re-running selection after sidecar injection");
                        checkAndSelectSubtitles(3); // Retry 3 times
                    }, 1000);
                  });
                }
              }).catch(e => {
                  if (window.tlog) window.tlog(`[SUB] Fetch Error: ${e.message}`);
              });

            // [NEW] Apply saved settings (Volume & Subtitles)
            const inv = getTauriInvoke();
            if (inv) {
              inv("native_set_volume", { volume: state.volume }).catch(e => console.error("[VOL] Init failed:", e));
              
              const applySubPos = (typeof state.subtitlePos === 'number') ? state.subtitlePos : 100.0;
              inv("set_subtitle_style", {
                scale: state.subtitleSize,
                pos: Math.round(applySubPos)
              }).catch(e => console.error("[SUB] Style apply failed:", e));
            }
          }, 1500); // 1.5s delay to ensure MPV is ready

          ui.playerTitle.textContent = cleanTitle;
          state.isNativeActive = true;

          // [OSC] Set Title
          if (ui.oscTitle) ui.oscTitle.textContent = cleanTitle;

          // Hide video container to show transparent hole
          if (ui.videoContainer) {
            ui.videoContainer.style.opacity = "0";
          }
          if (ui.mainPlayer) {
            ui.mainPlayer.pause();
          }
        })
        .catch((err) => {
          console.error(`[PLAYBACK] All native attempts failed:`, err);
          document.body.classList.remove("native-player-active");
          state.isNativeActive = false;
          stopNativeStatePolling();
          state.nativeSource = null;

          // [UI] Reset Native UI if failed
          if (ui.premiumOsc) ui.premiumOsc.style.display = "none";

          if (ui.videoContainer) ui.videoContainer.style.opacity = "1";
          if (ui.mainPlayer) ui.mainPlayer.style.display = "block";

          // Only fallback if NOT desktop video (to avoid NotSupportedError)
          startWebPlayback(item, streamUrl, isAudio);
        });
      return;
    }
  }

  // 5. [WEB] Default Web Player Logic
  startWebPlayback(item, streamUrl, isAudio);
}

function startWebPlayback(item, streamUrl, isAudio = false) {
  console.log("[PLAY] Starting Web Playback:", streamUrl);

  // [UI] Reset for Web Playback
  if (ui.premiumOsc) ui.premiumOsc.style.display = "none"; // Hide native OSC
  if (ui.customControls) ui.customControls.style.display = "flex"; // Show web controls
  if (ui.playerHeader) ui.playerHeader.style.display = "flex";

  if (ui.videoContainer) ui.videoContainer.style.opacity = "1";
  if (ui.mainPlayer) ui.mainPlayer.style.display = "block";
  document.body.classList.remove("native-player-active");

  if (isAudio) {
    ui.videoContainer.classList.add("audio-mode");
    ui.audioVisual.style.display = "flex";
    ui.audioTitle.textContent = item.name;
    ui.audioArtist.textContent = item.cast || item.folder || "";

    const bpath = toUrlSafeBase64(item.path || "");
    const albumArtUrl =
      item.meta_poster ||
      `${state.serverUrl}/gds_dviewer/normal/album_art?bpath=${bpath}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
    ui.audioPoster.src = albumArtUrl;
    ui.playerBg.style.backgroundImage = `url(${albumArtUrl})`;
    ui.playerBg.style.display = "block";
  } else {
    ui.videoContainer.classList.remove("audio-mode");
    ui.audioVisual.style.display = "none";
    ui.playerBg.style.display = "none";

    // Add Subtitles
    const bpath = toUrlSafeBase64(item.path || "");
    const subtitleUrl = `${state.serverUrl}/gds_dviewer/normal/external_subtitle?bpath=${bpath}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
    const track = document.createElement("track");
    Object.assign(track, {
      kind: "subtitles",
      label: "한국어",
      srclang: "ko",
      src: subtitleUrl,
      default: true,
    });
    ui.mainPlayer.appendChild(track);

    ui.mainPlayer.addEventListener(
      "loadedmetadata",
      () => {
        ui.playerTitle.textContent = item.name;
        if (ui.mainPlayer.textTracks.length > 0) {
          ui.mainPlayer.textTracks[0].mode = "showing";
        }
      },
      { once: true },
    );
  }

  ui.mainPlayer.src = streamUrl;
  ui.mainPlayer.load();
  ui.mainPlayer.play().catch((err) => {
    console.error("[PLAY] Web playback error:", err);
  });
}

// [PHASE 4] Auto-hide UI on scroll
function setupScrollBehavior() {
  const container = document.querySelector(".content-container");
  const bottomNav = document.querySelector(".bottom-nav");
  // const mainHeader = document.querySelector(".glass-header"); // Optional: Hide header too? User asked for bottom nav first.

  let lastScrollTop = 0;
  const hideThreshold = 20; // Sensitivity

  if (!container || !bottomNav) return;

  container.addEventListener(
    "scroll",
    () => {
      const scrollTop = container.scrollTop;

      // prevent negative scroll bounce affecting logic
      if (scrollTop < 0) return;

      const diff = Math.abs(scrollTop - lastScrollTop);
      if (diff < 10) return; // Ignore tiny scrolls

      // 1. Scrolling Down -> Hide
      if (scrollTop > lastScrollTop && scrollTop > hideThreshold) {
        bottomNav.classList.add("nav-hidden");
      }
      // 2. Scrolling Up -> Show
      else if (scrollTop < lastScrollTop) {
        bottomNav.classList.remove("nav-hidden");
      }

      lastScrollTop = scrollTop;
    },
    { passive: true },
  );
}

// [REMOVED] Manual Dragging Fallback - Relying on CSS -webkit-app-region: drag

// [PHASE 4] Dynamic Hero Carousel Logic
let heroTimer = null;
let currentHeroIndex = 0;
let isHeroLoading = false; // [NEW] 

async function initHeroCarousel() {
  if (isHeroLoading) return;
  isHeroLoading = true;
  
  try {
    // [FIX] Wait for DOM if container not ready
    let container = document.getElementById("hero-carousel");
    if (!container) {
      console.warn("[HERO] Container not found, waiting for DOM...");
      await new Promise(resolve => setTimeout(resolve, 200)); 
      container = document.getElementById("hero-carousel");
      if (!container) {
        console.error("[HERO] Container still not found after retry, aborting");
        return;
      }
    }

    const params = new URLSearchParams({
      query: "",
      limit: "50", 
      sort_by: "date",
      sort_order: "desc",
      recursive: "true",
      has_metadata: "true", 
      source_id: "-1", 
      apikey: state.apiKey
    });

    params.append("category", "tv_show,movie,animation");

    const data = await gdsFetch(`search?${params.toString()}`);
    console.log("[HERO] Fetch Result:", data);
    const contentContainer = document.querySelector(".content-container");

    let items = [];
    if (data && data.ret === "success") {
      items = data.list || data.data || [];
    }

    if (items.length === 0 && state.library && state.library.length > 0) {
      items = state.library.slice(0, 10);
    }

    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    const validHeroItems = items.filter(item => {
      const isVideo = !item.is_dir && videoExtensions.some(ext => item.name.toLowerCase().endsWith(ext));
      const isSeriesWithPoster = item.is_dir && (item.meta_poster || item.meta_id);
      return isVideo || isSeriesWithPoster;
    });

    const shuffled = validHeroItems.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 10);

    if (selected.length > 0) {
      if (contentContainer) contentContainer.classList.remove("no-hero");
      renderHeroSlides(selected, container); 
      startHeroTimer();
    } else {
      if (contentContainer) contentContainer.classList.remove("no-hero");
      renderHeroPlaceholder(container);
    }
  } catch (err) {
    console.warn("[HERO] Failed to initialize carousel:", err);
  } finally {
    isHeroLoading = false;
  }
}

function renderHeroPlaceholder(heroCarouselContainer) {
  // [FIX] This function now expects #hero-carousel, not .hero-section
  if (!heroCarouselContainer) return;
  heroCarouselContainer.innerHTML = `
        <div class="hero-slide active">
            <div class="hero-overlay"></div>
            <div class="hero-content">
                <div class="hero-tag">GDS Player</div>
                <div class="hero-title">Welcome</div>
                <div class="hero-meta">No featured content available</div>
            </div>
        </div>
    `;
}

function renderHeroSlides(items, container) {
  if (!container) return;
  container.innerHTML = ""; 
  const heroFallback = `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`;

  items.forEach((item, index) => {
    const slide = document.createElement("div");
    slide.className = index === 0 ? "hero-slide active" : "hero-slide";

    // [FIX] Prioritize meta_poster (high quality) and ALWAYS proxy external URLs to avoid CSP/CORS
    let rawImgUrl = item.meta_poster || '';
    let imgUrl = '';
    
    if (rawImgUrl) {
        imgUrl = `${state.serverUrl}/gds_dviewer/normal/proxy?url=${encodeURIComponent(rawImgUrl)}&apikey=${state.apiKey}`;
    } else {
        const bpath = toUrlSafeBase64(item.path || "");
        imgUrl = `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${bpath}&source_id=${item.source_id || 0}&w=1080&apikey=${state.apiKey}`;
    }
    slide.style.background = `center center / cover no-repeat url("${imgUrl}")`;

    // Clean Title
    let displayTitle = item.meta_title || item.title || item.name;
    displayTitle = displayTitle.replace(/\.(mkv|mp4|avi|srt|ass)$/i, "")
      .replace(/[\. ](1080p|720p|2160p|4k|HEVC|H\.264|WEB-DL|DDP5\.1|Atmos|MA|BluRay|XviD|AC3|KOR|FHD|AMZN|NF|Obbe|H\.265|x265|10bit|HDR)/gi, " ")
      .trim();

    slide.innerHTML = `
      <img src="${imgUrl}" class="hero-img" alt="${displayTitle}"
           onload="this.closest('.hero-slide').style.background='center center / cover no-repeat url(${imgUrl})'; console.log('[HERO] Image loaded: ${displayTitle}')"
           onerror="console.error('[HERO] Image failed to load: ${displayTitle}'); this.src='${heroFallback}'; this.closest('.hero-slide').style.background='center center / cover no-repeat url(${heroFallback})'">
      <div class="hero-overlay"></div>
      <div class="hero-content">
        <span class="hero-tag">Trending Now</span>
        <h1 class="hero-title">${displayTitle}</h1>
        <div class="hero-meta">
           <span><i data-lucide="star" style="width:14px; color:#ffb800; fill:#ffb800"></i> ${item.meta_rating || '8.5'}</span>
           <span>${item.meta_year || '2024'}</span>
           <span class="hw-badge">4K HDR</span>
        </div>
        <div class="hero-btns">
           <button class="btn btn-primary btn-play-hero"><i data-lucide="play"></i> Watch Now</button>
        </div>
      </div>
    `;

    // Click to play
    const handlePlay = (e) => {
        if (e) e.stopPropagation();
        const displayTitle = item.meta_title || item.title || item.name;
        console.log(`[HERO] Play Triggered: ${displayTitle}`, { path: item.path, id: item.source_id });
        if (window.tlog) window.tlog(`[HERO] Play Triggered: ${displayTitle}`);
        
        if (!item.path) {
            console.error("[HERO] Item missing path!", item);
            if (window.tlog) window.tlog("[HERO] ERROR: Missing path");
            return;
        }
        playVideo(item);
    };

    const playBtn = slide.querySelector('.btn-play-hero');
    if (playBtn) playBtn.onclick = handlePlay;
    slide.onclick = handlePlay;

    container.appendChild(slide);
  });

  if (window.lucide) window.lucide.createIcons();
}

function startHeroTimer() {
  if (heroTimer) clearInterval(heroTimer);
  console.log("[HERO] Starting timer...");
  currentHeroIndex = 0; 
  
  heroTimer = setInterval(() => {
    const slides = document.querySelectorAll(".hero-slide");
    if (slides.length < 2) return;

    slides[currentHeroIndex].classList.remove("active");
    currentHeroIndex = (currentHeroIndex + 1) % slides.length;
    slides[currentHeroIndex].classList.add("active");
  }, 6000); 
}

/**
 * [NEW] Render My List (Favorites)
 */
function renderFavorites() {
  const grid = document.getElementById("library-grid");
  const hero = document.querySelector(".hero-section");
  if (grid) grid.innerHTML = '<div style="grid-column:1/-1; padding:100px 0; text-align:center; color:var(--text-secondary);"><i data-lucide="heart" style="width:48px;height:48px;margin-bottom:15px; opacity:0.3;"></i><p>내가 찜한 리스트가 비어 있습니다.</p></div>';
  if (hero) hero.style.display = "none"; // Hide hero in favorites view
  if (window.lucide) window.lucide.createIcons();
}

window.handleAndroidBack = function () {
  const playerOverlay =
    document.getElementById("premium-osc") ||
    document.getElementById("player-overlay");

  // 1. If native player is active (check UI state)
  if (state.isNativeActive) {
    closePlayer();
    return "handled";
  }

  // 2. If viewing a folder (pathStack > 0)
  if (state.currentPath) {
    state.pathStack.pop();
    state.currentPath = state.pathStack[state.pathStack.length - 1] || "";
    loadLibrary();
    return "handled";
  }

  // 3. Default (minimize app)
  return "default";
};

// [NEW] Android TV Remote (Spatial) Navigation Manager
function setupRemoteNavigation() {
  console.log("[REMOTE] Initializing spatial navigation...");

  window.addEventListener("keydown", (e) => {
    const key = e.key;
    const current = document.activeElement;

    // DEBUG: Log all keys to see what the remote sends
    console.log(
      "[REMOTE] KeyDown:",
      key,
      "Code:",
      e.code,
      "KeyCode:",
      e.keyCode,
    );

    // Handle Enter/Select
    if (key === "Enter") {
      if (current && current !== document.body) {
        console.log("[REMOTE] Enter on:", current);
        current.click();
      }
      return;
    }

    // Handle Back/Escape
    const backKeys = [
      "Escape",
      "Backspace",
      "BrowserBack",
      "GoBack",
      "XF86Back",
      "Back",
    ];
    const isBackKey =
      backKeys.includes(key) || e.keyCode === 4 || e.keyCode === 27;

    if (isBackKey) {
      window.handleAndroidBack();
      e.preventDefault();
      e.stopPropagation();
    }

    // Spatial Navigation Logic
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
      const playerOverlay = ui.playerOverlay;
      const isPlayerActive =
        playerOverlay && playerOverlay.classList.contains("active");

      if (isPlayerActive) {
        const videoPlayer = ui.mainPlayer;
        const overlayUI = document.getElementById("custom-controls");
        const isOverlayHidden =
          overlayUI && overlayUI.classList.contains("hidden");

        // If overlay hidden, show it on any key and do nothing else
        if (isOverlayHidden) {
          // Trigger a move/click to show UI
          const event = new MouseEvent("mousemove", { bubbles: true });
          document.dispatchEvent(event);
          e.preventDefault();
          return;
        }

        // If overlay is visible, handle focus within it
        const playerFocusables = Array.from(
          overlayUI.querySelectorAll('button, input[type="range"]'),
        );
        const focusedIdx = playerFocusables.indexOf(current);

        if (focusedIdx === -1) {
          if (playerFocusables[0]) playerFocusables[0].focus();
          e.preventDefault();
          return;
        }

        // Navigate between controls
        if (key === "ArrowRight" || key === "ArrowDown") {
          const nextIdx = (focusedIdx + 1) % playerFocusables.length;
          playerFocusables[nextIdx].focus();
          e.preventDefault();
        } else if (key === "ArrowLeft" || key === "ArrowUp") {
          const prevIdx =
            (focusedIdx - 1 + playerFocusables.length) %
            playerFocusables.length;
          playerFocusables[prevIdx].focus();
          e.preventDefault();
        }
        return;
      }

      console.log("[REMOTE] Moving focus:", key);
      e.preventDefault();
      moveFocus(key);
    }
  });

  // Initial Focus
  setTimeout(() => {
    const firstTab =
      document.querySelector(".tab.active") || document.querySelector(".tab");
    if (firstTab) firstTab.focus();
  }, 1000);
}

function moveFocus(direction) {
  const current = document.activeElement;
  const focusables = Array.from(
    document.querySelectorAll(
      'button, input, [tabindex="0"], .card, .tab, .nav-item:not(.active-placeholder)',
    ),
  ).filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0);

  if (!current || current === document.body) {
    if (focusables.length > 0) focusables[0].focus();
    return;
  }

  const currentRect = current.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2,
  };

  const findBestCandidate = (penalty) => {
    let bestCandidate = null;
    let minDistance = Infinity;

    focusables.forEach((candidate) => {
      if (candidate === current) return;

      const candidateRect = candidate.getBoundingClientRect();
      const candidateCenter = {
        x: candidateRect.left + candidateRect.width / 2,
        y: candidateRect.top + candidateRect.height / 2,
      };

      const dx = candidateCenter.x - currentCenter.x;
      const dy = candidateCenter.y - currentCenter.y;

      // Directional Filtering
      let isCorrectDirection = false;
      if (direction === "ArrowUp") isCorrectDirection = dy < -1;
      if (direction === "ArrowDown") isCorrectDirection = dy > 1;
      if (direction === "ArrowLeft") isCorrectDirection = dx < -1;
      if (direction === "ArrowRight") isCorrectDirection = dx > 1;

      if (isCorrectDirection) {
        // Distance Metric with penalty for perpendicular movement
        const dist =
          direction.includes("ArrowUp") || direction.includes("ArrowDown")
            ? Math.abs(dy) + Math.abs(dx) * penalty
            : Math.abs(dx) + Math.abs(dy) * penalty;

        if (dist < minDistance) {
          minDistance = dist;
          bestCandidate = candidate;
        }
      }
    });
    return bestCandidate;
  };

  // 1. Try with strict alignment (stay in column/row)
  let target = findBestCandidate(8);

  // 2. Try with relaxed alignment (if trapped)
  if (!target) {
    target = findBestCandidate(1);
  }

  // 3. FINAL PANIC ESCAPE: If stuck in bottom nav, jump to library content
  if (!target && direction === "ArrowUp" && current.closest(".bottom-nav")) {
    console.log(
      "[REMOTE] Panic escape from bottom nav: Jumping to first content item",
    );
    // Try to find the most relevant "Up" target
    target = document.querySelector(".card, .tab.active, .tab, #search-input");
  }

  // Double check Target logic for Player
  if (
    !target &&
    direction === "ArrowDown" &&
    current.closest(".player-header")
  ) {
    target =
      document.getElementById("btn-center-play") ||
      document.getElementById("progress-slider");
  }

  if (target) {
    console.log("[REMOTE] Success: Moving focus to", target);
    target.focus();
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    console.warn("[REMOTE] No focusable candidate found for:", direction);
  }
}

// Utils
function formatSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
// [NEW] Premium OSC Logic
function setupPremiumOSC() {
  const osc = ui.premiumOsc;
  if (!osc) {
    console.warn("[OSC] Premium OSC element not found, skipping setup.");
    return;
  }

  let oscHideTimeout;

  const showOSC = () => {
    if (state.nativeRecreating) return;
    if (osc) {
      if (osc.classList.contains("hidden")) {
        console.log("[OSC] Showing OSC UI");
        osc.classList.remove("hidden");
        if (window.lucide) lucide.createIcons();
      }
    }
    document.body.style.cursor = "default";
    clearTimeout(oscHideTimeout);
    oscHideTimeout = setTimeout(() => {
      const isWebPlaying = ui.mainPlayer && !ui.mainPlayer.paused;
      const isActuallyActive = isWebPlaying || (state.isNativeActive && !state.nativePaused);

      if (isActuallyActive) {
        if (osc) {
          console.log("[OSC] Auto-hiding OSC UI");
          osc.classList.add("hidden");
        }
        document.body.style.cursor = "none";
      }
    }, 4000);
  };

  const seekTo = (seconds) => {
    const targetTime = Math.max(0, seconds);
    console.log("[PLAYER-ACTION] seekTo requested:", targetTime);
    if (state.isNativeActive) {
      const invoke =
        window.__TAURI__ && window.__TAURI__.core
          ? window.__TAURI__.core.invoke
          : window.__TAURI__
            ? window.__TAURI__.invoke
            : null;
      if (invoke) {
        invoke("native_seek", { seconds: targetTime })
          .catch(err => console.error("[PLAYER-ERROR] native_seek failed:", err));
      }
    } else if (ui.mainPlayer) {
      ui.mainPlayer.currentTime = targetTime;
    }
  };

  const togglePlay = (e) => {
    if (e) e.stopPropagation();
    console.log("[PLAYER-ACTION] togglePlay. NativeActive:", state.isNativeActive, "NativePaused:", state.nativePaused);

    if (state.isNativeActive) {
      const nextPause = !state.nativePaused;
      const invoke =
        window.__TAURI__ && window.__TAURI__.core
          ? window.__TAURI__.core.invoke
          : window.__TAURI__
            ? window.__TAURI__.invoke
            : null;
      if (invoke) {
        invoke("native_play_pause", { pause: nextPause })
          .then(() => {
            console.log("[PLAYER-SUCCESS] native_play_pause success");
            state.nativePaused = nextPause;
          })
          .catch(err => console.error("[PLAYER-ERROR] native_play_pause failed:", err));
      }
    } else if (ui.mainPlayer) {
      if (ui.mainPlayer.paused) ui.mainPlayer.play();
      else ui.mainPlayer.pause();
    }
    showOSC();
  };

  // Bind Buttons
  const bind = (el, name, fn) => {
    if (el) {
      console.log(`[INIT] Binding OSC button: ${name}`);
      el.addEventListener("click", (e) => {
        console.log(`[OSC-CLICK] ${name} clicked`);
        fn(e);
      });
    } else {
      console.warn(`[INIT] OSC button not found: ${name}`);
    }
  };

  bind(ui.btnOscPlayPause, "Play/Pause", togglePlay);
  bind(ui.btnOscCenterPlay, "Center Play", togglePlay);
  bind(ui.oscCenterControls, "Center Overlay", togglePlay);

  bind(ui.btnOscBack, "Back", (e) => { e.stopPropagation(); closePlayer(); });

  bind(ui.btnOscPrev, "Prev/SkipBack", (e) => {
    e.stopPropagation();
    const current = state.isNativeActive ? state.nativePos : (ui.mainPlayer ? ui.mainPlayer.currentTime : 0);
    seekTo(current - 10);
  });

  bind(ui.btnOscNext, "Next/SkipForward", (e) => {
    e.stopPropagation();
    const current = state.isNativeActive ? state.nativePos : (ui.mainPlayer ? ui.mainPlayer.currentTime : 0);
    const total = state.isNativeActive ? state.nativeDuration : (ui.mainPlayer ? ui.mainPlayer.duration : Infinity);
    seekTo(Math.min(total, current + 10));
  });

  // [FIX] Force select button to ensure binding
  const btnSub = document.getElementById("btn-osc-subtitles");
  if (btnSub) {
    console.log("[INIT] Force binding Subtitle Button");
    btnSub.onclick = (e) => {
      e.stopPropagation();
      console.log("[DEBUG] Subtitle Button CLICKED (Direct Bind)");
      // alert("Subtitle Button Clicked"); // User feedback
      showSubtitleMenu();
    };
  } else {
    console.error("[INIT] Subtitle Button NOT FOUND in DOM");
  }

  /*
  bind(ui.btnOscSubtitles, "Subtitles", (e) => {
    e.stopPropagation();
    console.log("[DEBUG] Subtitle Button CLICKED");
    showSubtitleMenu();
  });
  */

  bind(ui.btnOscFullscreen, "Fullscreen", async (e) => {
    e.stopPropagation();
    const invoke = getTauriInvoke();
    const applyWindowFullscreenClass = (isFs) => {
      document.body.classList.toggle("window-fullscreen", !!isFs);
      document.documentElement.classList.toggle("window-fullscreen", !!isFs);
    };
    const scheduleNativeResize = () => {
      if (!state.isNativeActive || !invoke) return;
      [0, 120, 450].forEach((delay) => {
        setTimeout(() => {
          invoke("resize_native_player", {}).catch((err) => {
            console.error("[PLAYER] resize_native_player failed:", err);
          });
        }, delay);
      });
    };
    try {
      // [FIX] Use explicit fullscreen state set (more reliable than toggle on macOS).
      if (invoke) {
        setNativeTransitionMask(true);
        const currentFs = await invoke("native_get_fullscreen").catch(() => false);
        const targetFs = !currentFs;
        await invoke("native_set_fullscreen", { fullscreen: targetFs });
        await new Promise((r) => setTimeout(r, 180));

        const afterFs = await invoke("native_get_fullscreen").catch(() => currentFs);
        if (afterFs !== targetFs) {
          console.warn("[PLAYER] Fullscreen first attempt mismatch. Retrying once...");
          await invoke("native_set_fullscreen", { fullscreen: targetFs });
        }
        applyWindowFullscreenClass(targetFs);

        console.log("[PLAYER] Native Fullscreen Set:", targetFs);
        scheduleNativeResize();
        // Single deterministic flow: after parent fullscreen settles, recreate once.
        if (state.isNativeActive) {
          await new Promise((r) => setTimeout(r, targetFs ? 220 : 140));
          await recreateNativePlayerAfterResize(targetFs ? "fullscreen-enter" : "fullscreen-exit");
        } else {
          setTimeout(() => setNativeTransitionMask(false), 160);
        }
      } else {
        throw new Error("Tauri Invoke not available");
      }
    } catch (err) {
      console.error("[PLAYER] Native Fullscreen Error:", err);
      setNativeTransitionMask(false);
      // Fallback to DOM fullscreen if native fails
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(console.error);
      else if (document.exitFullscreen) document.exitFullscreen();
      applyWindowFullscreenClass(!!document.fullscreenElement);
    }
  });

  // Keep embedded MPV container in sync with parent window size/fullscreen state.
  if (!window.__nativeResizeSyncBound) {
    window.__nativeResizeSyncBound = true;
    const applyWindowFullscreenClass = (isFs) => {
      document.body.classList.toggle("window-fullscreen", !!isFs);
      document.documentElement.classList.toggle("window-fullscreen", !!isFs);
    };
    const syncNativeResize = () => {
      const inv = getTauriInvoke();
      if (!state.isNativeActive || !inv) return;
      inv("resize_native_player", {}).catch((err) => {
        console.error("[PLAYER] Resize sync failed:", err);
      });
    };
    const onNativeFullscreenChange = () => {
      syncNativeResize();
      const inv = getTauriInvoke();
      if (inv) {
        inv("native_get_fullscreen")
          .then((isFs) => {
            applyWindowFullscreenClass(isFs);
            inv("native_set_mpv_fullscreen", { fullscreen: !!isFs }).catch(() => {});
          })
          .catch(() => {});
      } else {
        applyWindowFullscreenClass(!!document.fullscreenElement);
      }
      // Keep fullscreen transition stable: avoid recreate here.
      // Recreate can reintroduce fixed-size fallback on some macOS setups.
    };
    window.addEventListener("resize", syncNativeResize);
    document.addEventListener("fullscreenchange", onNativeFullscreenChange);
    setTimeout(onNativeFullscreenChange, 200);
  }

  bind(ui.btnOscSubtitles, "Subtitles", (e) => {
    e.stopPropagation();
    if (!state.isNativeActive && ui.mainPlayer) {
      const tracks = ui.mainPlayer.textTracks;
      if (tracks.length > 0) tracks[0].mode = (tracks[0].mode === "showing" ? "hidden" : "showing");
    }
    showOSC();
  });

  bind(ui.btnOscSettings, "Settings", (e) => {
    e.stopPropagation();
    showQualityMenu();
    showOSC();
  });

  // Global overlay click (ensure it's not a button/input)
  // [PHASE 5.5] Subtitle Menu Logic
  // [NEW] Shared logic for checking/selecting subs and updating badge with retry
  // (MOVED TO GLOBAL SCOPE)

  async function showSubtitleMenu() {
    try {
      let tracks = await invoke("get_subtitle_tracks");
      console.log("[SUB] Tracks:", tracks);
      renderSubtitleMenu(tracks);
    } catch (e) {
      console.error("[SUB] Failed to load tracks:", e);
      alert("Failed to load subtitle tracks");
    }
  }

  function showQualityMenu() {
    const existing = document.getElementById("quality-menu-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "quality-menu-overlay";
    overlay.className = "item-options-overlay active";

    const current = normalizeQualityProfile(state.qualityProfile);
    const options = [
      { id: "balanced", label: "Balanced", desc: "기본 추천" },
      { id: "quality", label: "Quality", desc: "고화질(부하 증가)" },
      { id: "smooth", label: "Smooth", desc: "부드러움 우선" },
    ];

    overlay.innerHTML = `
      <div class="options-content" style="max-height: 55vh; display:flex; flex-direction:column;">
        <div class="options-header">
          <h3>Playback Quality</h3>
          <button class="close-options-btn"><i data-lucide="x"></i></button>
        </div>
        <div class="subtitle-track-list" style="overflow-y:auto; flex:1;">
          ${options.map((opt) => `
            <button class="sort-option ${opt.id === current ? "active" : ""}" data-qprofile="${opt.id}" style="width:100%; border:none;">
              <span style="display:flex; flex-direction:column; align-items:flex-start; gap:2px;">
                <strong>${opt.label}</strong>
                <small style="opacity:0.75;">${opt.desc}</small>
              </span>
              ${opt.id === current ? '<i data-lucide="check" style="width:16px;"></i>' : ""}
            </button>
          `).join("")}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons();

    const closeMenu = () => overlay.remove();
    overlay.querySelector(".close-options-btn").addEventListener("click", closeMenu);
    overlay.addEventListener("click", (evt) => {
      if (evt.target === overlay) closeMenu();
    });

    overlay.querySelectorAll("[data-qprofile]").forEach((el) => {
      el.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        const profile = normalizeQualityProfile(el.dataset.qprofile || "balanced");
        await applyNativeQualityProfile(profile);
        closeMenu();
      });
    });
  }

  function renderSubtitleMenu(tracks) {
    // Remove existing menu if any
    const existing = document.getElementById("subtitle-menu-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "subtitle-menu-overlay";
    overlay.className = "item-options-overlay active"; // Reuse existing overlay style

    // Content
    let html = `
        <div class="options-content" style="max-height: 60vh; display:flex; flex-direction:column;">
            <div class="options-header">
                <h3>Subtitles</h3>
                <button class="close-options-btn"><i data-lucide="x"></i></button>
            </div>
            <div class="subtitle-track-list" style="overflow-y:auto; flex:1; margin-bottom:15px;">
      `;

    if (!tracks || tracks.length === 0) {
      html += `<div style="padding:15px; text-align:center; color:#888;">No subtitles found</div>`;
    } else {
      tracks.forEach(t => {
        const label = t.title || t.lang || `Track ${t.id}`;
        const isSelected = t.selected;
        const icon = isSelected ? '<i data-lucide="check" style="width:16px;"></i>' : '';
        const badge = t.external ? '<span style="font-size:10px; background:#333; padding:2px 4px; border-radius:4px; margin-left:5px;">EXT</span>' : '';

        html += `
                <div class="sort-option ${isSelected ? 'active' : ''}" data-sid="${t.id}">
                    <span style="flex:1;">${label} ${badge}</span>
                    ${icon}
                </div>
              `;
      });
      // Add 'Off' option
      html += `
                <div class="sort-option" data-sid="-1">
                    <span style="flex:1;">Off (끄기)</span>
                </div>
              `;
    }

    html += `</div>
            <div class="subtitle-settings" style="border-top:1px solid rgba(255,255,255,0.1); padding-top:10px;">
                <div style="font-size:0.9rem; margin-bottom:8px; color:#ccc;">Settings</div>
                <div style="display:flex; gap:10px; align-items:center;">
                    <span style="font-size:0.8rem; width:50px;">Size</span>
                    <button class="icon-btn-sm" id="sub-size-down"><i data-lucide="minus"></i></button>
                    <button class="icon-btn-sm" id="sub-size-up"><i data-lucide="plus"></i></button>
                    <span style="flex:1;"></span>
                    <span style="font-size:0.8rem; width:50px;">Pos</span>
                     <button class="icon-btn-sm" id="sub-pos-up"><i data-lucide="arrow-up"></i></button>
                    <button class="icon-btn-sm" id="sub-pos-down"><i data-lucide="arrow-down"></i></button>
                </div>
            </div>
        </div>
      `;

    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons();

    // Close handler
    overlay.querySelector(".close-options-btn").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Track selection
    overlay.querySelectorAll(".sort-option").forEach(el => {
      el.addEventListener("click", async () => {
        const sid = parseInt(el.dataset.sid);
        console.log("[SUB] Selecting sid:", sid);
        await invoke("set_subtitle_track", { sid: sid });
        overlay.remove();
        // Update badge immediately
        checkAndSelectSubtitles();
      });
    });

    // Settings handlers (Current state management needed? For now just inc/dec)
    // We don't verify current scale, just send absolute or relative commands?
    // Backend expects 'scale' (f64). Let's assume current is in state or start at 1.0
    // Ideally we read from get_mpv_state but it's not there.
    // Let's use local state for now or send relative steps if backend supported it.
    // Backend: set_subtitle_style(scale: Option<f64>, pos: ...) sets absolute.
    // We will increment local state `state.subtitleScale` (default 1.0)

    const updateStyle = () => {
      invoke("set_subtitle_style", { scale: state.subtitleSize, pos: state.subtitlePos });
      localStorage.setItem("flashplex_sub_size", state.subtitleSize);
      localStorage.setItem("flashplex_sub_pos", state.subtitlePos);
    };

    document.getElementById("sub-size-up").addEventListener("click", () => {
      state.subtitleSize = Math.min(3.0, (state.subtitleSize || 1.1) + 0.1);
      updateStyle();
    });
    document.getElementById("sub-size-down").addEventListener("click", () => {
      state.subtitleSize = Math.max(0.5, (state.subtitleSize || 1.1) - 0.1);
      updateStyle();
    });
    document.getElementById("sub-pos-up").addEventListener("click", () => {
      state.subtitlePos = Math.max(0, (state.subtitlePos || 0) - 5);
      updateStyle();
    });
    document.getElementById("sub-pos-down").addEventListener("click", () => {
      state.subtitlePos = Math.min(150, (state.subtitlePos || 0) + 5);
      updateStyle();
    });
  }

  if (ui.playerOverlay) {
    let isDraggingSub = false;
    let startY = 0;
    let startSubPos = 0;

    /* [REMOVED] Conflict with native Tauri V2 drag region
    ui.playerOverlay.addEventListener('mousedown', (e) => {
      // Only trigger if clicking in the lower 30% of the screen (where subtitles usually are)
      // and NOT clicking on a specific button
      if (e.target.closest('.osc-ctrl-btn') || e.target.closest('input')) return;
      
      const rect = ui.playerOverlay.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      
      if (clickY > rect.height * 0.6) { // Bottom 40% area
        isDraggingSub = true;
        startY = e.clientY;
        startSubPos = state.subtitlePos || 0;
        console.log("[SUB-DRAG] Start dragging at Y:", startY, "Current Pos:", startSubPos);
      }
    });
    */

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingSub) return;
      
      const deltaY = e.clientY - startY;
      // Invert or direct depending on MPV's 'sub-pos' behavior
      // MPV sub-pos 100 is bottom, lower is higher? Actually sub-pos is 0-100.
      // But we are using our backend 'pos' which is absolute px/units.
      // Let's assume +deltaY means moving down -> increase subtitlePos.
      let newPos = startSubPos + (deltaY * 0.5); // Sensitivity 0.5
      newPos = Math.max(0, Math.min(150, newPos));
      
      state.subtitlePos = newPos;
      const inv = getTauriInvoke();
      if (inv) {
        inv("set_subtitle_style", { scale: state.subtitleSize, pos: Math.round(newPos) });
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingSub) {
        isDraggingSub = false;
        localStorage.setItem("flashplex_sub_pos", state.subtitlePos);
        console.log("[SUB-DRAG] Finished dragging. Saved Pos:", state.subtitlePos);
      }
    });

    ui.playerOverlay.addEventListener('click', (e) => {
      if (isDraggingSub) return; // Don't toggle play if we were dragging
      if (e.target.closest('.osc-ctrl-btn') || e.target.closest('input')) return;
      console.log("[OSC-EVENT] Overlay background click -> togglePlay");
      togglePlay();
    });
  }

  // Activity listeners
  document.addEventListener("mousemove", showOSC);
  document.addEventListener("keydown", showOSC);
  document.addEventListener("mousedown", showOSC);

  // Clock Update
  const updateClock = () => {
    if (ui.oscClock) {
      const now = new Date();
      ui.oscClock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };
  setInterval(updateClock, 10000);
  updateClock();

  // Progress Slider
  if (ui.oscProgressSlider) {
    ui.oscProgressSlider.addEventListener("mousedown", () => {
      console.log("[OSC-DRAG] Progress slider drag START");
      state.isDraggingOscSlider = true;
    });
    ui.oscProgressSlider.addEventListener("mouseup", () => {
      console.log("[OSC-DRAG] Progress slider drag END");
      state.isDraggingOscSlider = false;
    });
    ui.oscProgressSlider.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      if (ui.oscProgressFill) ui.oscProgressFill.style.width = val + "%";
      if (state.isNativeActive) {
        if (state.nativeDuration > 0) {
          const seekTime = (val / 100) * state.nativeDuration;
          seekTo(seekTime);
        }
      } else if (ui.mainPlayer && ui.mainPlayer.duration) {
        ui.mainPlayer.currentTime = (val / 100) * ui.mainPlayer.duration;
      }
    });
  }

  // Volume Slider
  if (ui.oscVolumeSlider) {
    ui.oscVolumeSlider.value = state.volume; // Init slider
    ui.oscVolumeSlider.addEventListener("input", (e) => {
      const vol = parseInt(e.target.value);
      state.volume = vol;
      localStorage.setItem("flashplex_volume", vol);
      console.log("[OSC-DRAG] Volume change:", vol);
      if (state.isNativeActive) {
        const invoke = getTauriInvoke();
        if (invoke) invoke("native_set_volume", { volume: vol }).catch(console.error);
      } else if (ui.mainPlayer) {
        ui.mainPlayer.volume = vol / 100;
      }
    });
  }


  showOSC();
}
