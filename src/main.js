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
  subtitleSize: 1.0, // Default font scale
  subtitlePos: 0.0, // Default vertical offset

  // [PHASE 4] Infinite Scroll State
  offset: 0,
  limit: 50, // Batch size
  isLoadingMore: false,
  hasMore: true,

  // [PHASE 4] Sorting State
  sortBy: "date",
  sortOrder: "desc",
};

// Platform Detection
const isAndroid = /Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isDesktop = !isAndroid && !isIOS;

// Helper for cross-version Tauri invoke
function getTauriInvoke() {
  if (!window.__TAURI__) return null;
  return (window.__TAURI__.core && window.__TAURI__.core.invoke) || window.__TAURI__.invoke;
}

// [NEW] Shared logic for checking/selecting subs and updating badge with retry
async function checkAndSelectSubtitles(retries = 4) {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  try {
    let tracks = await invoke("get_subtitle_tracks");
    // console.log(`[SUB] Checking subtitles (retries left: ${retries})...`);

    // Update Badge
    const hasSelection = tracks && tracks.some((t) => t.selected);
    const badge = document.getElementById("osc-sub-badge");
    if (badge) badge.style.display = hasSelection ? "block" : "none";

    // Auto-Selection Logic
    if (!hasSelection && tracks && tracks.length > 0) {
      const koTrack = tracks.find(
        (t) =>
          t.lang === "ko" ||
          t.title?.toLowerCase().includes("korean") ||
          t.title?.includes("한국어"),
      );
      if (koTrack) {
        console.log("[SUB] Auto-selecting Korean track:", koTrack.id);
        await invoke("set_subtitle_track", { sid: koTrack.id });
        if (badge) badge.style.display = "block";
        return true; // We selected something
      }
    }

    // Retry if no tracks found OR we haven't selected anything yet (maybe tracks load late)
    if (retries > 0 && !hasSelection) {
      setTimeout(() => checkAndSelectSubtitles(retries - 1), 1500); // Retry every 1.5s
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
  setupScrollBehavior(); // [PHASE 4] Auto-hide Nav
  setupInfiniteScroll(); // [PHASE 4] Infinite Scroll
  setupSortUI(); // [PHASE 4] Sort UI
  initHeroCarousel(); // [FIX] Call Hero Init explicitly


  // [CRITICAL] Re-init layout fixes
  setTimeout(() => {
    // Force re-calc of layout if needed
  }, 500);
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

  state.currentView = viewName;
}

// Tabs Logic
function setupTabs() {
  if (!ui.categoryTabs) return;
  ui.categoryTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      ui.categoryTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.category = tab.dataset.category;
      state.currentPath = "";
      state.pathStack = [];
      loadLibrary();
    });
  });
}

// Global API Fetch
async function gdsFetch(endpoint, options = {}) {
  if (!state.serverUrl || !state.apiKey) throw new Error("Setup required");

  let baseUrl = state.serverUrl.trim();
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = `http://${baseUrl}`;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/gds_dviewer/normal/explorer/${endpoint.replace(/^\//, "")}`;
  const method = options.method || "GET";

  // URL에 API Key 추가 (POST body에 이미 있으면 생략해도 되지만 안전을 위해 유지)
  const separator = url.includes("?") ? "&" : "?";
  const finalUrl = `${url}${separator}apikey=${state.apiKey}`;

  console.log(`[GDS-API] Calling (${method}): ${finalUrl}`);

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
    console.log(`[GDS-API] Final URL: ${finalUrl}`);
    console.log(`[GDS-API] Response Content:`, data);
    return data;
  } catch (e) {
    console.error("[GDS-API] Fetch Error:", e);
    throw e;
  }
}

// Data Loading

async function loadLibrary(forceRefresh = false, isAppend = false) {
  const grid = ui.grid;
  const heroSection = ui.heroSection;
  if (!grid) return;

  // [Pagination] Reset or Check
  if (!isAppend) {
    state.offset = 0;
    state.hasMore = true;
    state.isLoadingMore = false;
    state.library = []; // Clear current library state reference
  } else {
    if (!state.hasMore || state.isLoadingMore) return;
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

  // Cache Logic (Only for first page)
  const cacheKey = `library_${state.category}_${state.currentPath || "root"}_${state.query || ""}`;
  const cachedData = localStorage.getItem(cacheKey);

  if (!isAppend && cachedData && !forceRefresh) {
    try {
      console.log("[CACHE] Loaded from local storage");
      let cachedItems = JSON.parse(cachedData);

      // [FIX] Apply Season Filter to Cache (Prevent Flash of Unfiltered Content)
      if (state.category === 'tv_show' && !state.currentPath) {
        const seasonRegex = /^(season|s|시즌)\s*\d+|specials/i;
        cachedItems = cachedItems.filter(i => {
          if (!i.is_dir) return true;
          return !seasonRegex.test(i.name);
        });
      }

      state.library = cachedItems;
      state.offset = state.library.length; // Update offset based on cached items length
      // Render immediately
      renderGrid(grid, state.library, isFolderCategory, false);

      if (heroSection) {
        heroSection.style.display =
          state.currentView === "library" && !state.currentPath
            ? "block"
            : "none";
      }
      // Trigger background update if needed, but for now just use cache
      // return; // Let it fetch fresh data to sync? Or trust cache? 
      // User expects freshness usually. Let's let it flow, but maybe silent update?
    } catch (e) {
      console.warn("[CACHE] Corrupt cache:", e);
    }
  } else if (!isAppend) {
    // Show skeletons only if NO cache exists (and not appending)
    grid.innerHTML = Array(6)
      .fill('<div class="card skeleton"></div>')
      .join("");
    if (heroSection) heroSection.style.display = "none";
  }

  try {
    if (!isAppend && ui.statusDot) ui.statusDot.className = "status-dot loading";
    let data;

    // Common Params
    const commonParams = {
      limit: state.limit.toString(),
      offset: state.offset.toString(),
      sort_by: state.sortBy,
      sort_order: state.sortOrder
    };

    // FETCH LOGIC
    let currentList = [];

    if (isFolderCategory && isAtRoot) {
      const params = new URLSearchParams({
        query: state.query || "",
        is_dir: "true",
        recursive: "true", // [REVERT] Recursive needed to find moved items
        ...commonParams
      });
      if (state.category) params.append("category", state.category);
      data = await gdsFetch(`search?${params.toString()}`);

      const rawList = data.list || data.data || [];
      currentList = rawList; // Use local var

      if (!isAppend) {
        if (data.ret === "success" && state.category) {
          renderSubCategoryChips(currentList); // Extract chips from first batch
        } else {
          hideSubCategoryChips();
        }
      }
    } else if (state.currentPath) {
      // List API
      if (!isAppend) renderSubCategoryChips([]);
      const params = new URLSearchParams({ path: state.currentPath, ...commonParams });
      data = await gdsFetch(`list?${params.toString()}`);
      if (data.ret === "success") {
        currentList = data.items || data.list || data.data || [];
      }
    } else {
      // General Search
      if (!isAppend) hideSubCategoryChips();
      const params = new URLSearchParams({
        query: state.query || "",
        is_dir: "false",
        ...commonParams
      });
      if (state.category) params.append("category", state.category);
      data = await gdsFetch(`search?${params.toString()}`);
      if (data.ret === "success") {
        currentList = data.list || data.data || [];
      }
    }

    if (data && data.ret === "success") {
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
        // Update Cache (only first page)
        try {
          localStorage.setItem(cacheKey, JSON.stringify(finalItems));
        } catch (e) {
          console.warn("[CACHE] Storage full, skipping cache:", e);
        }
      }

      // [NEW] Filter out "Season" folders for TV Shows (Only at Root)
      console.log(`[FILTER] Cat: ${state.category}, Path: '${state.currentPath}'`);

      if (state.category === 'tv_show' && !state.currentPath) {
        console.log("[FILTER] Applying Season Filter...");
        // Regex to match "Season 1", "S1", "시즌1", "Specials"
        const seasonRegex = /^(season|s|시즌)\s*\d+|specials/i;
        const initialCount = finalItems.length;
        finalItems = finalItems.filter(i => {
          if (!i.is_dir) return true;
          return !seasonRegex.test(i.name);
        });
        console.log(`[FILTER] Removed ${initialCount - finalItems.length} season folders`);
      }

      // [MOD] Category Logic: Movie Index Folders
      // ... (Filtering logic remains, filtering might affect page size slightly but acceptable)
      let displayItems = finalItems;
      if (state.category === 'movie' && !state.currentPath) {
        if (!isAppend) {
          const indexFolders = finalItems.filter(i => i.is_dir && i.name.length === 1);
          renderSubCategoryChips(indexFolders);
        }
        // Filter out from grid
        displayItems = finalItems.filter(i => !(i.is_dir && i.name.length === 1));
      } else if (!isFolderCategory && !state.currentPath && !isAppend) {
        renderSubCategoryChips(null);
      }

      // Final Render
      if (!isAppend) {
        ui.statusDot.className = "status-dot success";
        if (heroSection) {
          // [MOD] User requested to STOP slides but KEEP layout
          // Show section and render static placeholder
          heroSection.style.display =
            state.currentView === "library" && !state.currentPath
              ? "block"
              : "none";

          if (state.currentView === "library" && !state.currentPath) {
            // No carousel init, just placeholder
            renderHeroPlaceholder(heroSection);
          }
        }
      }

      renderGrid(grid, displayItems, isFolderCategory, isAppend);

    } else {
      state.isLoadingMore = false;
      throw new Error(data ? data.ret : "Fetch failed");
    }
  } catch (err) {
    state.isLoadingMore = false;
    console.error("[LOAD] Fetch Error:", err);
    ui.statusDot.className = "status-dot error";
  }
}

// ... renderSubCategoryChips ...
function renderSubCategoryChips(folders) {
  const chipContainer = document.getElementById("sub-category-chips");
  if (!chipContainer) return;

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

  // Index Folders chips if passed
  if (!state.currentPath && folders && Array.isArray(folders)) {
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

  // 2. Parse current path and Create Breadcrumbs
  if (state.currentPath) {
    const parts = state.currentPath.split("/");
    let builtPath = "";

    parts.forEach((part, index) => {
      if (!part) return; // Skip empty
      builtPath += (builtPath ? "/" : "") + part;

      const breadcrumb = document.createElement("div");
      breadcrumb.className = "chip";
      breadcrumb.innerText = part; // Folder Name

      // We need to capture the specific path for this breadcrumb
      const pathForThisChip = builtPath;

      breadcrumb.onclick = () => {
        // Go back to this specific level
        state.currentPath = pathForThisChip;
        // Rebuild stack up to this point
        state.pathStack = state.pathStack.slice(
          0,
          state.pathStack.indexOf(pathForThisChip) + 1,
        );
        loadLibrary();
      };

      chipContainer.appendChild(breadcrumb);
    });
  }
}

function hideSubCategoryChips() {
  const chipContainer = document.getElementById("sub-category-chips");
  if (chipContainer) chipContainer.style.display = "none";
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
      if (state.hasMore && !state.isLoadingMore) {
        console.log("[SCROLL] Loading more items...");
        loadLibrary(false, true); // forceRefresh=false, isAppend=true
      }
    }
  });
}

function renderGrid(container, items, isFolderCategory = false, isAppend = false) {
  if (!isAppend) {
    container.innerHTML = "";
  }

  // [MOD] Adaptive Grid Class
  if (state.currentPath) {
    container.parentElement.classList.add("folder-view");
    container.classList.add("folder-view");
  } else {
    container.parentElement.classList.remove("folder-view");
    container.classList.remove("folder-view");
  }

  // Add back button logic handles itself (only when not appending)
  if (state.currentPath && !isAppend) {
    const backBtn = document.createElement("div");
    // ... (Keep existing back button code) ...
    backBtn.className = "card back-card";
    backBtn.tabIndex = 0;
    backBtn.innerHTML = `
      <div class="back-icon"><i data-lucide="arrow-left"></i></div>
      <div class="card-info">
        <div class="card-title">돌아가기</div>
        <div class="card-subtitle">이전 폴더로</div>
      </div>
    `;
    backBtn.addEventListener("click", () => {
      state.pathStack.pop();
      state.currentPath = state.pathStack[state.pathStack.length - 1] || "";
      loadLibrary();
    });
    container.appendChild(backBtn);
  }

  if ((!items || items.length === 0) && !isAppend) {
    container.innerHTML +=
      '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-secondary)">No items found.</div>';
    return;
  }

  if (!items) return; // Nothing to append

  items.forEach((item, index) => {
    // ... (Keep existing card generation) ...
    const card = document.createElement("div");
    // ...
    card.tabIndex = 0; // Make card focusable for remote navigation
    card.className = "card";
    card.style.animation = `fadeIn 0.6s cubic-bezier(0.23, 1, 0.32, 1) forwards ${index * 0.05}s`;
    card.style.opacity = "0";

    const isFolder = item.is_dir;

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

    // Poster logic with smart fallback
    const noPoster = `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`;
    let poster = item.meta_poster;
    let usePlaceholder = false;

    if (!poster) {
      if (isFolder) {
        poster = item.poster || null;
      } else {
        const category = item.category || "other";
        if (["video", "animation", "music_video"].includes(category)) {
          poster = `${state.serverUrl}/gds_dviewer/normal/explorer/thumbnail?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&w=400&apikey=${state.apiKey}`;
        } else if (category === "audio") {
          poster = `${state.serverUrl}/gds_dviewer/normal/explorer/album_art?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
        }
      }
    }

    if (!poster) usePlaceholder = true;

    // Use meta_summary if available, otherwise format size
    const subtitle = isFolder
      ? `${item.children_count || 0} 항목`
      : item.meta_summary || formatSize(item.size);

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
          <div class="card-title">${isFolder ? "📁 " : ""}${displayTitle}</div>
          <div class="card-subtitle">${subtitle}</div>
        </div>
      `;
    } else {
      card.innerHTML = `
        <img class="card-poster" src="${poster}" alt="${item.name}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=no-poster-placeholder><i data-lucide=film></i><span>Media</span></div>'+this.parentElement.querySelector('.card-info').outerHTML">
        <div class="card-info">
          <div class="card-title">${isFolder ? "📁 " : ""}${displayTitle}</div>
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
  });

  if (window.lucide) lucide.createIcons();

  // [REMOTE] Auto-focus first card if coming from tabs or if no focus
  if (
    state.currentView === "library" &&
    !document.activeElement.classList.contains("card")
  ) {
    const firstCard = container.querySelector(".card");
    if (firstCard) firstCard.focus();
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
      const testUrl = `${url.replace(/\/$/, "")}/gds_dviewer/normal/explorer/search?query=&limit=1&apikey=${key}`;
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

      // [NEW] Explicitly tell Rust to kill mpv
      const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
      if (invoke) invoke("close_native_player").catch(console.error);

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
  if (!item) return;
  console.log("[PLAY] Initiating playback for:", item.name);
  // alert('Playing: ' + item.name); // Debug

  // 1. Show Overlay & Setup Metadata
  if (ui.playerOverlay) ui.playerOverlay.classList.add("active");
  const cleanTitle = item.name || item.title || "Unknown Title";
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
  // 3. Robust URL & Extension Parsing
  let streamUrlRaw = item.stream_url || item.url;

  // If URL is missing (e.g. from raw list_directory), construct it
  if (!streamUrlRaw && item.path) {
    streamUrlRaw = `${state.serverUrl}/gds_dviewer/normal/explorer/stream?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}`;
    console.log("[PLAY] Constructed Stream URL:", streamUrlRaw);
  }

  if (!streamUrlRaw) {
    console.error("[PLAY] No valid URL or path provided for item");
    return;
  }

  let streamUrl = streamUrlRaw;
  if (!streamUrl.includes("apikey=")) {
    const separator = streamUrl.includes("?") ? "&" : "?";
    streamUrl += `${separator}apikey=${state.apiKey}`;
  }

  // Improved extension parser: Prefer item.path, then fallback to URL without query params
  const extension = (item.path || streamUrlRaw.split("?")[0] || "")
    .split(".")
    .pop()
    .toLowerCase();

  console.log("[PLAY] Extension Detected:", extension, "isAndroid:", isAndroid);

  // 4. [HYBRID] Native Playback Routing
  const isAudio =
    item.category === "audio" || ["flac", "mp3", "m4a"].includes(extension);



  // Tauri v2 invoke access detection
  const invoke =
    window.__TAURI__ && window.__TAURI__.core
      ? window.__TAURI__.core.invoke
      : window.__TAURI__
        ? window.__TAURI__.invoke
        : null;

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


      // [FIX] Use bpath (Base64) for subtitle URL (Standard Base64 + URL Encoded)
      // "Invalid Base64 path" on server means it likely expects standard Base64 w/ padding,
      // but correctly URL-encoded so '+' doesn't become ' '.
      const bpath = encodeURIComponent(btoa(unescape(encodeURIComponent(item.path))));
      const subtitleUrl = `${state.serverUrl}/gds_dviewer/normal/explorer/external_subtitle?bpath=${bpath}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;

      // [NEW] Show Premium OSC / Hide Web Controls (Moved to success callback)
      // if (ui.premiumOsc) ...
      // if (ui.customControls) ...

      // Add player-active class for transparency
      document.body.classList.add("native-player-active");

      const cmd = "launch_mpv_player";

      state.isNativeActive = true;

      console.log(`[PLAYBACK] Attempting ${cmd}...`);
      invoke(cmd, {
        title: cleanTitle,
        url: streamUrl,
        subtitle_url: subtitleUrl,
      })
        .then(() => {
          console.log(`[PLAYBACK] ${cmd} Success`);

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
            // [NEW] Apply saved subtitle settings
            invoke("set_subtitle_style", {
              scale: state.subtitleSize,
              pos: Math.round(state.subtitlePos)
            }).catch(e => console.error("[SUB] Style apply failed:", e));
          }, 1000); // 1s delay to ensure tracks loaded

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

    const albumArtUrl =
      item.meta_poster ||
      `${state.serverUrl}/gds_dviewer/normal/explorer/album_art?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
    ui.audioPoster.src = albumArtUrl;
    ui.playerBg.style.backgroundImage = `url(${albumArtUrl})`;
    ui.playerBg.style.display = "block";
  } else {
    ui.videoContainer.classList.remove("audio-mode");
    ui.audioVisual.style.display = "none";
    ui.playerBg.style.display = "none";

    // Add Subtitles
    const subtitleUrl = `${state.serverUrl}/gds_dviewer/normal/explorer/external_subtitle?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
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

async function initHeroCarousel() {
  const params = new URLSearchParams({
    query: "",
    is_dir: "false",
    limit: "8", // Fetch top 8 for carousel
    sort_by: "date", // Newest first
    sort_order: "desc",
    recursive: "true", // [FIX] Search deeper for files
  });

  // Optional: Match current category if set
  if (state.category) params.append("category", state.category);

  try {
    const data = await gdsFetch(`search?${params.toString()}`);
    const container = document.getElementById("hero-carousel");
    const contentContainer = document.querySelector(".content-container");

    let items = [];
    if (data && data.ret === "success") {
      items = data.list || data.data || [];
    }

    // Fallback: If nothing from search, try state.library
    if (items.length === 0 && state.library && state.library.length > 0) {
      console.log("[HERO] No search results, using library fallback");
      items = state.library.slice(0, 5);
    }

    if (items.length > 0) {
      if (contentContainer) contentContainer.classList.remove("no-hero");
      renderHeroSlides(items);
    } else {
      // Absolute Fallback: Render a placeholder to maintain layout
      if (contentContainer) contentContainer.classList.remove("no-hero");
      renderHeroPlaceholder(container);
    }
  } catch (err) {
    console.warn("[HERO] Failed to fetch hero content:", err);
  }
}

function renderHeroPlaceholder(container) {
  if (!container) return;
  container.innerHTML = `
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

function renderHeroSlides(items) {
  const container = document.getElementById("hero-carousel");
  if (!container) return;

  container.innerHTML = ""; // Clear placeholders
  currentHeroIndex = 0;

  items.forEach((item, index) => {
    const slide = document.createElement("div");
    slide.className = `hero-slide ${index === 0 ? "active" : ""}`;

    // Logic for Poster/Backdrop
    // Use backdrop/fanart if available for hero, fall back to poster
    // Since we don't have explicit fanart field in basic item, use poster for now or special API?
    // Let's use the thumbnail API with a large width.
    const imgUrl = `${state.serverUrl}/gds_dviewer/normal/explorer/thumbnail?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&w=1280&apikey=${state.apiKey}`;

    // Clean Title
    let displayTitle = item.title || item.name;
    displayTitle = displayTitle.replace(/\.(mkv|mp4|avi|srt|ass)$/i, "")
      .replace(/[\. ](1080p|720p|2160p|4k|HEVC|H\.264|WEB-DL|DDP5\.1|Atmos|MA|BluRay|XviD|AC3|KOR|FHD|AMZN|NF|Obbe|H\.265|x265|10bit|HDR)/gi, " ")
      .trim();

    slide.innerHTML = `
      <img src="${imgUrl}" class="hero-img" alt="${displayTitle}">
      <div class="hero-overlay"></div>
      <div class="hero-content">
        <div class="hero-tag">새로 업데이트</div>
        <div class="hero-title">${displayTitle}</div>
        <div class="hero-meta">${formatSize(item.size)}</div>
      </div>
    `;

    // Click to Play
    slide.onclick = () => {
      playVideo(item, displayTitle);
    };

    container.appendChild(slide);
  });

  startHeroTimer();
}

function startHeroTimer() {
  if (heroTimer) clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    const slides = document.querySelectorAll(".hero-slide");
    if (slides.length < 2) return;

    // Remove active from current
    slides[currentHeroIndex].classList.remove("active");

    // Next index
    currentHeroIndex = (currentHeroIndex + 1) % slides.length;

    // Add active to next
    slides[currentHeroIndex].classList.add("active");
  }, 6000); // 6 Seconds
}

// Global handler for Android back button (called from MainActivity.kt)
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

// Global handler for Android back button (called from MainActivity.kt)
window.handleAndroidBack = function () {
  const playerOverlay =
    ui.playerOverlay || document.getElementById("player-overlay");
  const isPlayerActive =
    playerOverlay &&
    (playerOverlay.classList.contains("active") ||
      playerOverlay.style.display === "block" ||
      window.getComputedStyle(playerOverlay).display !== "none");

  console.log(
    "[REMOTE] Global Back triggered. isPlayerActive:",
    isPlayerActive,
  );

  if (isPlayerActive) {
    console.log("[REMOTE] Back on player - Closing player");

    if (ui.mainPlayer) {
      ui.mainPlayer.pause();
      ui.mainPlayer.src = "";
    }

    if (playerOverlay) {
      playerOverlay.classList.remove("active");
      playerOverlay.style.display = "none"; // Force hide
    }

    // Focus back to something logical
    setTimeout(() => {
      const lastFocused = document.querySelector(
        ".card:focus, .tab:focus, .nav-item:focus",
      );
      if (!lastFocused) {
        const firstGridItem = document.querySelector(".card");
        if (firstGridItem) firstGridItem.focus();
      }
    }, 100);
  } else if (state.pathStack.length > 0) {
    console.log("[REMOTE] Back on library - Going up");
    state.pathStack.pop();
    state.currentPath = state.pathStack[state.pathStack.length - 1] || "";
    loadLibrary();
  } else if (state.currentView !== "library") {
    console.log("[REMOTE] Back on non-library view - Returning to library");
    switchView("library");
  } else {
    console.log(
      "[REMOTE] Back at root - Ready to exit? (Optional: Notify app to finish)",
    );
  }
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
// [PHASE 10] Web Player Controls Logic
function setupPlayerControls() {
  const overlay = ui.playerOverlay;
  const video = ui.mainPlayer;
  const playBtn = document.getElementById("btn-play-pause");
  const centerPlayBtn = document.getElementById("btn-center-play");
  const closeBtn = document.getElementById("btn-close-player");
  const slider = document.getElementById("progress-slider");
  const currentTimeLabel = document.getElementById("current-time");
  const durationLabel = document.getElementById("duration");

  if (!video || !overlay) return;

  function togglePlay() {
    if (video.paused) {
      video.play();
      if (centerPlayBtn) centerPlayBtn.style.opacity = "0";
      if (playBtn)
        playBtn.innerHTML = '<i data-lucide="pause" style="width:24px;"></i>';
      lucide.createIcons();
    } else {
      video.pause();
      if (centerPlayBtn) centerPlayBtn.style.opacity = "1";
      if (playBtn)
        playBtn.innerHTML = '<i data-lucide="play" style="width:24px;"></i>';
      lucide.createIcons();
    }
  }

  // Bind Play/Pause Buttons
  if (playBtn)
    playBtn.onclick = (e) => {
      e.stopPropagation();
      togglePlay();
    };
  if (centerPlayBtn)
    centerPlayBtn.onclick = (e) => {
      e.stopPropagation();
      togglePlay();
    };

  // Bind Close Button
  if (closeBtn)
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closePlayer(); // Call the global close function which handles native close
    };

  // Update Progress Bar
  video.addEventListener("timeupdate", () => {
    if (!slider || isDraggingSlider) return;
    const percent = (video.currentTime / video.duration) * 100;
    slider.value = isNaN(percent) ? 0 : percent;
    if (currentTimeLabel)
      currentTimeLabel.textContent = formatTime(video.currentTime);
  });

  video.addEventListener("loadedmetadata", () => {
    if (durationLabel) durationLabel.textContent = formatTime(video.duration);
  });

  // Slider Seek Logic
  let isDraggingSlider = false;
  if (slider) {
    slider.addEventListener("input", () => {
      isDraggingSlider = true;
    });
    slider.addEventListener("change", () => {
      isDraggingSlider = false;
      const time = (slider.value / 100) * video.duration;
      video.currentTime = time;
    });
  }
}

// Ensure icons are created
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  setupPlayerControls();
});

// [NEW] Premium OSC Logic
function setupPremiumOSC() {
  const osc = ui.premiumOsc;
  if (!osc) {
    console.warn("[OSC] Premium OSC element not found, skipping setup.");
    return;
  }

  let oscHideTimeout;

  const showOSC = () => {
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

  bind(ui.btnOscFullscreen, "Fullscreen", (e) => {
    e.stopPropagation();
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(console.error);
    else document.exitFullscreen();
  });

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
      invoke("set_subtitle_style", { scale: state.subtitleScale, pos: state.subtitlePos });
      // console.log(`[SUB] Style: Scale ${state.subtitleScale}, Pos ${state.subtitlePos}`);
    };

    document.getElementById("sub-size-up").addEventListener("click", () => {
      state.subtitleScale = Math.min(3.0, (state.subtitleScale || 1.0) + 0.1);
      updateStyle();
    });
    document.getElementById("sub-size-down").addEventListener("click", () => {
      state.subtitleScale = Math.max(0.5, (state.subtitleScale || 1.0) - 0.1);
      updateStyle();
    });
    document.getElementById("sub-pos-up").addEventListener("click", () => {
      state.subtitlePos = Math.max(0, (state.subtitlePos || 100) - 5);
      updateStyle();
    });
    document.getElementById("sub-pos-down").addEventListener("click", () => {
      state.subtitlePos = Math.min(150, (state.subtitlePos || 100) + 5);
      updateStyle();
    });
  }

  if (ui.playerOverlay) {
    ui.playerOverlay.addEventListener('click', (e) => {
      if (e.target.closest('.osc-ctrl-btn') || e.target.closest('input')) return;
      console.log("[OSC-EVENT] Overlay background click -> togglePlay");
      togglePlay(e);
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
    ui.oscVolumeSlider.addEventListener("input", (e) => {
      const vol = parseInt(e.target.value);
      console.log("[OSC-DRAG] Volume change:", vol);
      if (state.isNativeActive) {
        const invoke =
          window.__TAURI__ && window.__TAURI__.core
            ? window.__TAURI__.core.invoke
            : window.__TAURI__
              ? window.__TAURI__.invoke
              : null;
        if (invoke) invoke("native_set_volume", { volume: vol }).catch(console.error);
      } else if (ui.mainPlayer) {
        ui.mainPlayer.volume = vol / 100;
      }
    });
  }

  // [TAURI BRIDGE] Event Listener Setup (Replaced with Polling for Stability)
  const getTauriListen = () => {
    if (!window.__TAURI__) return null;
    return (window.__TAURI__.core && window.__TAURI__.core.invoke) || window.__TAURI__.invoke;
  };

  const invoke = getTauriListen();

  if (invoke) {
    console.log("[PLAYER] Starting polling loop for native state...");
    setInterval(() => {
      invoke("get_mpv_state")
        .then(data => {
          if (data) {
            // [DEBUG] Check HW status
            // if (data.hwdec) console.log("[POLL] hwdec:", data.hwdec);

            state.isNativeActive = true;
            state.nativePos = typeof data.position === 'number' ? data.position : 0;
            state.nativeDuration = typeof data.duration === 'number' ? data.duration : 0;
            state.nativePaused = !!data.pause;

            // UI Update
            if (ui.oscCurrentTime) ui.oscCurrentTime.textContent = formatTime(state.nativePos);
            if (ui.oscTotalTime) ui.oscTotalTime.textContent = formatTime(state.nativeDuration);

            // [OSC] Update Subtitle (Time Text)
            if (ui.oscSubtitle) {
              ui.oscSubtitle.textContent = `${formatTime(state.nativePos)} / ${formatTime(state.nativeDuration)}`;
            }

            // [OSC] HW/SW Badge
            if (ui.oscHwBadge) {
              const rawHw = (data.hwdec || "").toLowerCase();

              // Log change for debugging
              if (state.lastHwDec !== rawHw) {
                console.log("[PLAYER] HW Status:", rawHw);
                state.lastHwDec = rawHw;
              }

              // Check for specific HW keywords or generic "not no"
              const isHw = rawHw !== "no" && rawHw !== "" && (
                rawHw.includes("videotoolbox") ||
                rawHw.includes("vtb") ||
                rawHw.includes("auto") ||
                rawHw.includes("yes")
              );

              ui.oscHwBadge.textContent = isHw ? "HW" : "SW";
              ui.oscHwBadge.className = isHw ? "hw-badge hw" : "hw-badge sw";
            }

            const percent = (state.nativeDuration > 0) ? (state.nativePos / state.nativeDuration) * 100 : 0;
            if (ui.oscProgressFill) ui.oscProgressFill.style.width = percent + "%";
            if (ui.oscProgressSlider && !state.isDraggingOscSlider) ui.oscProgressSlider.value = percent;

            // Icons
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
          }
        })
        .catch(err => {
          // Squelch errors if player closed
          // console.warn("[POLL] Fail:", err);
        });
    }, 500);
  } else {
    console.error("[CRITICAL] window.__TAURI__.invoke NOT FOUND. Time sync will fail.");
  }

  showOSC();
}
