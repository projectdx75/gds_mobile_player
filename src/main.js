// Tauri v2 GDS Mobile Player - main.js

// State Management (Hardcoded for testing as requested)
const state = {
  serverUrl: 'https://music.yommi.mywire.org',
  apiKey: 'gommikey',
  currentView: 'library',
  category: 'tv_show', // Default to TV/Show
  query: '',           // Current search query
  library: [],
  currentPath: '', // For folder navigation
  pathStack: [],   // Navigation history
  categoryMapping: {}
};

// Platform Detection
const isAndroid = /Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isDesktop = !isAndroid && !isIOS;

// DOM Elements (Cached on load)
let ui = {};

function initElements() {
  try {
    ui = {
      views: {
        library: document.getElementById('view-library'),
        search: document.getElementById('view-search'),
        settings: document.getElementById('view-settings')
      },
      grid: document.getElementById('library-grid'),
      heroSection: document.querySelector('.hero-section'),
      searchInput: document.getElementById('search-input'),
      navItems: document.querySelectorAll('.nav-item'),
      categoryTabs: document.querySelectorAll('.tab'),
      playerOverlay: document.getElementById('player-overlay'),
      mainPlayer: document.getElementById('main-player'),
      playerTitle: document.getElementById('player-video-title') || document.getElementById('player-title'),
      statusDot: document.getElementById('status-indicator'),
      playerBg: document.getElementById('player-bg'),
      audioVisual: document.getElementById('audio-visual'),
      audioPoster: document.getElementById('audio-poster'),
      audioTitle: document.getElementById('audio-title'),
      audioArtist: document.getElementById('audio-artist'),
      videoContainer: document.querySelector('.video-container'),
      playerTitleInfo: document.querySelector('.player-title-info'),
      progressBarFill: document.getElementById('progress-bar-fill'),
      progressSlider: document.getElementById('progress-slider'),
      currentTime: document.getElementById('current-time'),
      totalTime: document.getElementById('total-time'),
      customControls: document.getElementById('custom-controls'),
      btnCenterPlay: document.getElementById('btn-center-play'),
      btnPlayPause: document.getElementById('btn-play-pause'),
      playerHeader: document.querySelector('.player-header')
    };
    console.log('[INIT] UI Elements initialized safely.');
  } catch (err) {
    console.error('[INIT] Failed to initialize elements:', err);
  }
}

// Initialize
window.addEventListener('DOMContentLoaded', () => {
  console.log('[STARTUP] Application booting...');
  // alert('GDS Mobile App v0.1.31-2 Booting...'); // Debug
  initElements();
  
  // Register robust global listeners
  document.addEventListener('click', (e) => {
    const navItem = e.target.closest('.nav-item');
    if (navItem && navItem.dataset.view) {
      switchView(navItem.dataset.view);
    }
  });

  setupNavigation();
  setupTabs();
  
  // Setup other modules with safety
  try {
    const defaultTab = document.querySelector('.tab[data-category="tv_show"]');
    if (defaultTab) defaultTab.classList.add('active');
    
    setupSearch();
    setupPlayer();
    setupButtons();
    setupSettings();
    setupDragging();
    setupRemoteNavigation();
  } catch (err) {
    console.error('[STARTUP] Setup error:', err);
  }
  
  // Initial data load
  if (state.serverUrl && state.apiKey) {
    console.log('[STARTUP] Starting initial library load...');
    loadLibrary();
    switchView('library');
  } else {
    switchView('settings');
  }
});

// Navigation Logic
function setupNavigation() {
  // delegation handled in global listener above
  console.log('[NAV] Global navigation listener active.');
}

function switchView(viewName) {
  console.log('[NAV] Switching to view:', viewName);
  const views = ui.views || {};
  const navItems = ui.navItems || [];
  
  if (!views[viewName]) {
      console.error('[NAV] Target view not found:', viewName);
      return;
  }

  Object.keys(views).forEach(key => {
    if (views[key]) views[key].classList.toggle('active', key === viewName);
  });
  
  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });
  
  state.currentView = viewName;
}

// Tabs Logic
function setupTabs() {
  if (!ui.categoryTabs) return;
  ui.categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      ui.categoryTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.category = tab.dataset.category;
      state.currentPath = ''; 
      state.pathStack = [];
      loadLibrary();
    });
  });
}

// Global API Fetch
async function gdsFetch(endpoint, options = {}) {
  if (!state.serverUrl || !state.apiKey) throw new Error('Setup required');
  
  let baseUrl = state.serverUrl.trim();
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = `http://${baseUrl}`;
  }
  
  const url = `${baseUrl.replace(/\/$/, '')}/gds_dviewer/normal/explorer/${endpoint.replace(/^\//, '')}`;
  const method = options.method || 'GET';
  
  // URL에 API Key 추가 (POST body에 이미 있으면 생략해도 되지만 안전을 위해 유지)
  const separator = url.includes('?') ? '&' : '?';
  const finalUrl = `${url}${separator}apikey=${state.apiKey}`;
  
  console.log(`[GDS-API] Calling (${method}): ${finalUrl}`);

  // Tauri HTTP Plugin Logic
  const tauriHttp = window.__TAURI_PERMISSION_HTTP__ || (window.__TAURI__ && window.__TAURI__.http);
  // v2에서는 __TAURI__.http 대신 플러그인을 직접 쓸 수도 있음. 
  // 여기서는 fetch API가 자동으로 Tauri에 의해 가로채지지 않는 경우 대비
  const tauriPlugin = window.__TAURI_PLUGIN_HTTP__;

  // Browser fetch fallback with enhanced error reporting
  try {
    const fetchOptions = {
        method,
        headers: options.headers || {},
        body: options.body
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
            console.warn('[GDS-API] Tauri Plugin HTTP failed:', perr.message || perr);
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
    console.error('[GDS-API] Fetch Error:', e);
    throw e;
  }
}

// Data Loading
async function loadLibrary() {
  const grid = ui.grid || document.getElementById('library-grid');
  const heroSection = ui.heroSection || document.querySelector('.hero-section');
  
  if (!grid) {
      console.error('[LIBRARY] Grid container missing!');
      return;
  }

  // Hide hero if searching or deep in folders
  if (heroSection) {
    heroSection.style.display = (state.currentView === 'library' && !state.currentPath) ? 'block' : 'none';
  }

  grid.innerHTML = Array(6).fill('<div class="card skeleton"></div>').join('');
  
  // [REMOTE] Store current focus to restore if possible
  const previouslyFocusedId = document.activeElement ? (document.activeElement.dataset.path || document.activeElement.id) : null;

  try {
    ui.statusDot.className = 'status-dot loading';
    
    // Folder-based categories (Animation, TV, Movie, M/V) show folders first when at root
    const isFolderCategory = ['animation', 'music_video', 'tv_show', 'movie', 'video'].includes(state.category);
    const isAtRoot = !state.currentPath;
    
    let data;
    
    if (isFolderCategory && isAtRoot) {
      // Special check: If we're on Android and the path looks like a local one, use native listing
      if (isAndroid && state.currentPath && (state.currentPath.startsWith('/') || state.currentPath.includes(':'))) {
          try {
              console.log('[EXPLORER] Using Native Android listing for:', state.currentPath);
              if (window.PlayerBridge && window.PlayerBridge.listAndroidFiles) {
                  const nativeStr = window.PlayerBridge.listAndroidFiles(state.currentPath);
                  const nativeFiles = nativeStr ? nativeStr.split('|') : [];
                  if (nativeFiles && nativeFiles.length > 0) {
                      // Transform native strings into item-like objects for the grid
                      data = {
                          ret: 'success',
                          list: nativeFiles.map(name => ({
                              name: name,
                              title: name,
                              path: `${state.currentPath.replace(/\/$/, '')}/${name}`,
                              is_dir: !name.includes('.'), // Simple heuristic for now
                              category: state.category,
                              source_id: 0
                          }))
                      };
                  }
              }
          } catch (nerr) {
              console.warn('[EXPLORER] Native listing failed, falling back to server:', nerr);
          }
      }

      if (!data) {
        // Show sub-category chips (folders at root level)
      const params = new URLSearchParams({
        query: state.query || '',
        is_dir: 'true',
        recursive: 'true',
        limit: '50',
        sort_by: 'date',
        sort_order: 'desc'
      });
      if (state.category) params.append('category', state.category);
      console.warn(`[GDS-SEARCH] Sending Request with Category: "${state.category}"`);
      console.log(`[DEBUG] Params: ${params.toString()}`);
      data = await gdsFetch(`search?${params.toString()}`);
      
      const rawList = data.list || data.data || [];
      if (data.ret === 'success' && state.category) {
        data.list = rawList;
        // Render Chips
        renderSubCategoryChips(data.list);
      } else {
        data.list = rawList;
        hideSubCategoryChips();
        }
      }
    } else if (state.currentPath) {
      hideSubCategoryChips();
      // Inside a folder - show its contents
      const params = new URLSearchParams({
        path: state.currentPath
      });
      data = await gdsFetch(`list?${params.toString()}`);
      if (data.ret === 'success') {
        data.list = data.items || data.list || data.data;
      }
    } else {
      hideSubCategoryChips();
      // Default: show files for non-folder categories
      const params = new URLSearchParams({
        query: state.query || '',
        is_dir: 'false',
        limit: '100',
        sort_by: 'date',
        sort_order: 'desc'
      });
      if (state.category) params.append('category', state.category);
      data = await gdsFetch(`search?${params.toString()}`);
    }

    if (data.ret === 'success') {
      const finalItems = data.list || data.data || [];
      state.library = finalItems;
      renderGrid(grid, finalItems, isFolderCategory);
      ui.statusDot.className = 'status-dot success';
    } else {
      throw new Error(data.ret);
    }
  } catch (err) {
    console.error('Connection Error:', err);
    grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-secondary)">
      <p>Failed to connect to GDS server.</p>
      <small>${err.message}</small>
    </div>`;
    ui.statusDot.className = 'status-dot error';
  }
}

function renderSubCategoryChips(folders) {
  const chipContainer = document.getElementById('sub-category-chips');
  if (!chipContainer) return;
  
  if (!folders || folders.length === 0) {
    chipContainer.style.display = 'none';
    return;
  }

  chipContainer.style.display = 'flex';
  chipContainer.innerHTML = '';
  
  // Use a Map to keep unique folder names based on their path depth if possible, 
  // but for now, just unique names to act as "Keywords/Categories"
  const uniqueFolderMap = new Map();
  folders.forEach(f => {
    if (!uniqueFolderMap.has(f.name)) {
      uniqueFolderMap.set(f.name, f);
    }
  });

  const uniqueFolders = Array.from(uniqueFolderMap.values()).slice(0, 20);
  
  uniqueFolders.forEach(folder => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.tabIndex = 0; // [REMOTE] Support TV navigation
    chip.innerText = folder.name;
    chip.addEventListener('click', () => {
      state.pathStack.push(folder.path);
      state.currentPath = folder.path;
      loadLibrary();
    });
    chipContainer.appendChild(chip);
  });
}

function hideSubCategoryChips() {
  const chipContainer = document.getElementById('sub-category-chips');
  if (chipContainer) chipContainer.style.display = 'none';
}

function renderGrid(container, items, isFolderCategory = false) {
  container.innerHTML = '';
  
  // Add back button if inside a folder
  if (state.currentPath) {
    const backBtn = document.createElement('div');
    backBtn.className = 'card back-card';
    backBtn.innerHTML = `
      <div class="back-icon">←</div>
      <div class="card-info">
        <div class="card-title">돌아가기</div>
        <div class="card-subtitle">뒤로</div>
      </div>
    `;
    backBtn.addEventListener('click', () => {
      state.pathStack.pop();
      state.currentPath = state.pathStack[state.pathStack.length - 1] || '';
      loadLibrary();
    });
    container.appendChild(backBtn);
  }
  
  if (!items || items.length === 0) {
    container.innerHTML += '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-secondary)">No items found.</div>';
    return;
  }

  items.forEach((item, index) => {
    const card = document.createElement('div');
    card.tabIndex = 0; // Make card focusable for remote navigation
    card.className = 'card';
    card.style.animation = `fadeIn 0.6s cubic-bezier(0.23, 1, 0.32, 1) forwards ${index * 0.05}s`;
    card.style.opacity = '0';
    
    const isFolder = item.is_dir;
    
    // Poster logic with smart fallback
    const noPoster = `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`;
    let poster = item.meta_poster;
    if (!poster) {
      if (isFolder) {
        // For folders, try to get poster from yaml or use fallback
        poster = item.poster || noPoster;
      } else {
        // For video/animation/music_video, use server thumbnail extraction
        const category = item.category || 'other';
        if (['video', 'animation', 'music_video'].includes(category)) {
          poster = `${state.serverUrl}/gds_dviewer/normal/explorer/thumbnail?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&w=400&apikey=${state.apiKey}`;
        } else if (category === 'audio') {
          poster = `${state.serverUrl}/gds_dviewer/normal/explorer/album_art?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
        } else {
          poster = noPoster;
        }
      }
    }
    
    // Use meta_summary if available, otherwise parent folder
    const subtitle = isFolder 
      ? `${item.children_count || ''} 항목`
      : (item.meta_summary || item.title || item.path.split('/').slice(-2, -1)[0] || formatSize(item.size));
    
    card.innerHTML = `
      <img class="card-poster" src="${poster}" alt="${item.name}" loading="lazy" onerror="this.src='${noPoster}'">
      <div class="card-info">
        <div class="card-title">${isFolder ? '📁 ' : ''}${item.title || item.name}</div>
        <div class="card-subtitle">${subtitle}</div>
      </div>
    `;
    
    if (isFolder) {
      // Navigate into folder
      card.addEventListener('click', () => {
        state.pathStack.push(item.path);
        state.currentPath = item.path;
        loadLibrary();
      });
    } else {
      // Play file
      card.addEventListener('click', () => playVideo(item));
    }
    container.appendChild(card);
  });
  
  if (window.lucide) lucide.createIcons();

  // [REMOTE] Auto-focus first card if coming from tabs or if no focus
  if (state.currentView === 'library' && !document.activeElement.classList.contains('card')) {
      const firstCard = container.querySelector('.card');
      if (firstCard) firstCard.focus();
  }
}


// Search Logic
function setupSearch() {
  let timeout = null;
  ui.searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    document.getElementById('search-placeholder').style.display = query ? 'none' : 'flex';
    
    clearTimeout(timeout);
    timeout = setTimeout(() => performSearch(query), 600);
  });
}

async function performSearch(query) {
  const grid = document.getElementById('search-results');
  if (!query) {
    grid.innerHTML = '';
    return;
  }
  
  grid.innerHTML = Array(4).fill('<div class="card skeleton"></div>').join('');
  
  try {
    const params = new URLSearchParams({
      query,
      is_dir: 'false',
      limit: '50',
      category: 'video' // Default search to video for player focus
    });
    const data = await gdsFetch(`search?${params.toString()}`);
    if (data.ret === 'success') {
      renderGrid(grid, data.list);
    }
  } catch (err) {
    console.error('Search error:', err);
  }
}


function formatTime(seconds) {
  if (isNaN(seconds)) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const m_str = m.toString().padStart(2, '0');
  const s_str = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${m_str}:${s_str}` : `${m_str}:${s_str}`;
}

// [Redundant startWebPlayer removed - Logic moved to playVideo]

// Settings Logic
function setupSettings() {
  const serverUrlInput = document.getElementById('server-url');
  const apiKeyInput = document.getElementById('api-key');
  const btnSave = document.getElementById('save-settings');
  const btnTestConnection = document.getElementById('btn-test-connection');
  const btnSaveCategories = document.getElementById('save-categories');
  const btnResetCategories = document.getElementById('btn-reset-categories');
  const categoryMappingList = document.getElementById('category-mapping-list');
  
  serverUrlInput.value = state.serverUrl;
  apiKeyInput.value = state.apiKey;
  
  // Tab Switching Logic
  document.querySelectorAll('.s-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.stab-content').forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      const contentId = `stab-${tab.dataset.stab}`;
      document.getElementById(contentId).classList.add('active');
      
      if (tab.dataset.stab === 'category') {
        loadCategoryMapping();
      }
    });
  });

  async function loadCategoryMapping() {
    if (!state.serverUrl || !state.apiKey) return;
    
    try {
      const data = await gdsFetch('get_category_mapping');
      if (data.ret === 'success') {
        state.categoryMapping = data.mapping;
        renderCategoryMappingRows(data.mapping);
      }
    } catch (err) {
      console.error('Failed to load mapping:', err);
    }
  }

  function renderCategoryMappingRows(mapping) {
    categoryMappingList.innerHTML = '';
    Object.entries(mapping).forEach(([cat, keywords]) => {
      const row = document.createElement('div');
      row.className = 'category-row';
      row.innerHTML = `
        <label class="category-label">${cat.replace('_', ' ')}</label>
        <input type="text" class="category-input" data-cat="${cat}" value="${keywords.join(', ')}" />
      `;
      categoryMappingList.appendChild(row);
    });
  }

  async function saveCategoryMapping() {
    const inputs = categoryMappingList.querySelectorAll('.category-input');
    const newMapping = {};
    inputs.forEach(input => {
      const cat = input.dataset.cat;
      const keywords = input.value.split(',').map(k => k.trim()).filter(k => k);
      newMapping[cat] = keywords;
    });

    console.log('[DEBUG] Saving mapping:', newMapping);

    const originalHTML = btnSaveCategories.innerHTML;
    try {
      btnSaveCategories.disabled = true;
      btnSaveCategories.innerHTML = '<i data-lucide="loader-2" class="animate-spin"></i> Saving...';
      if (window.lucide) lucide.createIcons();

      const bodyParams = new URLSearchParams();
      bodyParams.append('mapping', JSON.stringify(newMapping));
      bodyParams.append('apikey', state.apiKey);

      const data = await gdsFetch(`save_category_mapping`, {
        method: 'POST',
        body: bodyParams
      });
      
      console.log('[DEBUG] Save response:', data);

      if (data.ret === 'success') {
        state.categoryMapping = newMapping;
        btnSaveCategories.innerHTML = '<i data-lucide="check-circle"></i> Saved & Synced!';
        btnSaveCategories.classList.add('btn-success');
        if (window.lucide) lucide.createIcons();

        setTimeout(() => {
          btnSaveCategories.innerHTML = originalHTML;
          btnSaveCategories.classList.remove('btn-success');
          if (window.lucide) lucide.createIcons();
        }, 3000);

        loadLibrary(); // Reload to apply changes
      } else {
        alert('❌ Failed to save: ' + (data.msg || 'Unknown error'));
        btnSaveCategories.innerHTML = originalHTML;
      }
    } catch (err) {
      console.error('[ERROR] Save failed:', err);
      alert('❌ Error saving mapping: ' + err.message);
      btnSaveCategories.innerHTML = originalHTML;
    } finally {
      btnSaveCategories.disabled = false;
    }
  }

  btnResetCategories.addEventListener('click', () => {
    if (confirm('Reset categories to defaults?')) {
      const defaults = {
        'audio': ['MUSIC', '가수', '곡', 'ARTIST', 'ALBUM'],
        'animation': ['ANIMATION', '애니', '라프텔', 'laftel', '극장판 애니'],
        'movie': ['MOVIE', '영화', '극장판', 'film', 'cinema', '시네마'],
        'tv_show': ['TV', 'DRAMA', '드라마', '예능', 'TV-SHOW', 'SHOW', '미드', 'series', '시리즈'],
        'video': ['VIDEO', '영상', '녹화'],
        'music_video': ['MV', '뮤직비디오', '직캠', 'M/V']
      };
      renderCategoryMappingRows(defaults);
    }
  });

  btnSaveCategories.addEventListener('click', saveCategoryMapping);
  
  async function testConnection() {
    const url = serverUrlInput.value.trim();
    const key = apiKeyInput.value.trim();
    
    if (!url || !key) {
      alert('Please enter both Server URL and API Key');
      return;
    }

    btnTestConnection.disabled = true;
    btnTestConnection.innerHTML = '<i data-lucide="loader-2" class="animate-spin"></i> Testing...';
    lucide.createIcons();

    try {
      const testUrl = `${url.replace(/\/$/, '')}/gds_dviewer/normal/explorer/search?query=&limit=1&apikey=${key}`;
      const response = await fetch(testUrl);
      const data = await response.json();
      if (data.ret === 'success' || data.list) {
        alert('✅ Connection successful!');
      } else {
        alert('❌ Server responded but: ' + (data.msg || 'Check logs'));
      }
    } catch (err) {
      console.error('Test failed:', err);
      alert('❌ Connection failed. Check URL/Key and CORS.\nError: ' + err.message);
    } finally {
      btnTestConnection.disabled = false;
      btnTestConnection.innerHTML = '<i data-lucide="zap"></i> Test';
      lucide.createIcons();
    }
  }

  function saveSettings() {
    const url = serverUrlInput.value.trim().replace(/\/$/, '');
    const key = apiKeyInput.value.trim();
    
    if (!url || !key) {
      alert('Please enter both Server URL and API Key.');
      return;
    }

    state.serverUrl = url;
    state.apiKey = key;
    
    localStorage.setItem('gds_server_url', url);
    localStorage.setItem('gds_api_key', key);
    
    loadLibrary();
    switchView('library');
  }

  btnSave.addEventListener('click', saveSettings);
  btnTestConnection.addEventListener('click', testConnection);
}

// Global Buttons
function setupButtons() {
  document.getElementById('btn-refresh').addEventListener('click', () => {
    loadLibrary();
  });
  
  const exitNativeBtn = document.getElementById('btn-exit-native');
  if (exitNativeBtn) {
    exitNativeBtn.addEventListener('click', () => {
      document.documentElement.classList.remove('native-player-active');
      document.body.classList.remove('native-player-active');
      
      // [NEW] Explicitly tell Rust to kill mpv
      window.__TAURI__.core.invoke('close_native_player').catch(console.error);
      
      // Force restoration of UI visibility
      const elementsToRestore = ['.content-container', '.glass-header', '.view-header', '.bottom-nav'];
      elementsToRestore.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) {
          el.style.opacity = '1';
          el.style.pointerEvents = 'auto';
          el.style.display = ''; // Reset display if it was manipulated
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
    if (ui.customControls) ui.customControls.classList.remove('hidden');
    if (ui.playerHeader) ui.playerHeader.classList.remove('hidden');
    document.body.style.cursor = 'default';
    
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (!player.paused) {
        if (ui.customControls) ui.customControls.classList.add('hidden');
        if (ui.playerHeader) ui.playerHeader.classList.add('hidden');
        document.body.style.cursor = 'none';
      }
    }, 3000);
  };

  // Activity listeners
  document.addEventListener('mousemove', showUI);
  document.addEventListener('keydown', showUI);
  player.addEventListener('play', showUI);

  // Time Sync
  player.addEventListener('timeupdate', () => {
    if (!player.duration) return;
    const percent = (player.currentTime / player.duration) * 100;
    if (ui.progressBarFill) ui.progressBarFill.style.width = percent + '%';
    if (ui.progressSlider) ui.progressSlider.value = percent;
    if (ui.currentTime) ui.currentTime.textContent = formatTime(player.currentTime);
  });

  player.addEventListener('loadedmetadata', () => {
    if (ui.totalTime) ui.totalTime.textContent = formatTime(player.duration);
    if (ui.progressSlider) ui.progressSlider.value = 0;
    if (ui.progressBarFill) ui.progressBarFill.style.width = '0%';
    showUI();
  });

  // Seeking
  if (ui.progressSlider) {
    ui.progressSlider.addEventListener('input', (e) => {
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

  if (ui.btnPlayPause) ui.btnPlayPause.addEventListener('click', togglePlay);
  if (ui.btnCenterPlay) ui.btnCenterPlay.addEventListener('click', togglePlay);
  player.addEventListener('click', togglePlay);

  player.addEventListener('play', () => {
    const playIcons = document.querySelectorAll('[data-lucide="play"]');
    playIcons.forEach(icon => {
      icon.setAttribute('data-lucide', 'pause');
      if (window.lucide) lucide.createIcons();
    });
    if (ui.btnCenterPlay) ui.btnCenterPlay.classList.remove('show');
  });

  player.addEventListener('pause', () => {
    const pauseIcons = document.querySelectorAll('[data-lucide="pause"]');
    pauseIcons.forEach(icon => {
      icon.setAttribute('data-lucide', 'play');
      if (window.lucide) lucide.createIcons();
    });
    if (ui.btnCenterPlay) ui.btnCenterPlay.classList.add('show');
    showUI();
  });

  // Close player
  const btnClose = document.getElementById('btn-close-player');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      player.pause();
      player.src = "";
      ui.playerOverlay.classList.remove('active');
    });
  }
}


function playVideo(item) {
  if (!item) return;
  console.log('[PLAY] Initiating playback for:', item.name);
  // alert('Playing: ' + item.name); // Debug

  // 1. Show Overlay & Setup Metadata
  if (ui.playerOverlay) ui.playerOverlay.classList.add('active');
  const cleanTitle = item.name || item.title || "Unknown Title";
  if (ui.playerTitle) ui.playerTitle.textContent = cleanTitle + " (Loading...)";
  
  const premiumTitle = document.getElementById('player-video-title');
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
  if (ui.progressBarFill) ui.progressBarFill.style.width = '0%';
  if (ui.progressSlider) {
    // Definitive Fix: Force DOM Re-render of the range thumb
    const slider = ui.progressSlider;
    slider.min = "0";
    slider.max = "100";
    slider.value = "0";
    slider.setAttribute('value', '0');
    
    // Nudge the element to force TV browser repaint
    slider.style.opacity = '0.99'; 
    setTimeout(() => { 
        slider.style.opacity = '1';
        slider.value = "0";
        console.log('[DEBUG] Seek bar thumb forced to 0%');
    }, 50);

    requestAnimationFrame(() => {
       if (ui.progressSlider) {
         ui.progressSlider.value = "0";
         console.log('[DEBUG] Slider value reset confirmed:', ui.progressSlider.value);
       }
    });
  }
  if (ui.currentTime) ui.currentTime.textContent = '00:00';
  if (ui.totalTime) ui.totalTime.textContent = '00:00';
  
  // 3. Robust URL & Extension Parsing
  // 3. Robust URL & Extension Parsing
  let streamUrlRaw = item.stream_url || item.url;
  
  // If URL is missing (e.g. from raw list_directory), construct it
  if (!streamUrlRaw && item.path) {
    streamUrlRaw = `${state.serverUrl}/gds_dviewer/normal/explorer/stream?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}`;
    console.log('[PLAY] Constructed Stream URL:', streamUrlRaw);
  }

  if (!streamUrlRaw) {
      console.error('[PLAY] No valid URL or path provided for item');
      return;
  }
  
  let streamUrl = streamUrlRaw;
  if (!streamUrl.includes('apikey=')) {
    const separator = streamUrl.includes('?') ? '&' : '?';
    streamUrl += `${separator}apikey=${state.apiKey}`;
  }

  // Improved extension parser: Prefer item.path, then fallback to URL without query params
  const extension = (item.path || streamUrlRaw.split('?')[0] || '').split('.').pop().toLowerCase();
  
  console.log('[PLAY] Extension Detected:', extension, 'isAndroid:', isAndroid);

  // 4. [HYBRID] Native Playback Routing
  const isAudio = item.category === 'audio' || ['flac', 'mp3', 'm4a'].includes(extension);
  
  // Android Native (ExoPlayer for MKV/AVI/TS) - Direct Bridge Priority
  if (isAndroid && ['mkv', 'avi', 'ts'].includes(extension)) {
    console.log('[PLAYBACK] Checking Native ExoPlayer Bridge...', extension);
    if (window.PlayerBridge && window.PlayerBridge.openExoPlayer) {
        console.log('[PLAYBACK] Triggering Native ExoPlayer for:', cleanTitle);
        window.PlayerBridge.openExoPlayer(cleanTitle, streamUrl);
        ui.playerOverlay.classList.remove('active');
        return;
    } else {
        console.warn('[PLAYBACK] PlayerBridge not available, falling back to web.');
    }
  }

  // Use Tauri v2 invoke if available
  const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;

  if (invoke) {
    // Desktop Native (MPV for Video)
    if (isDesktop && !isAudio) {
      console.log('[PLAYBACK] Launching Native MPV for:', cleanTitle);
      const subtitleUrl = `${state.serverUrl}/gds_dviewer/normal/explorer/external_subtitle?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
      
      invoke('open_native_player', { 
        title: cleanTitle, 
        url: streamUrl, 
        subtitle_url: subtitleUrl 
      }).then(() => {
        ui.playerOverlay.classList.remove('active');
      }).catch(err => {
        console.error('[PLAYBACK] MPV failed:', err);
        startWebPlayback(item, streamUrl, isAudio);
      });
      return;
    }
  }

  // 5. [WEB] Default Web Player Logic
  startWebPlayback(item, streamUrl, isAudio);
}

function startWebPlayback(item, streamUrl, isAudio = false) {
  console.log('[PLAY] Starting Web Playback:', streamUrl);
  
  if (isAudio) {
    ui.videoContainer.classList.add('audio-mode');
    ui.audioVisual.style.display = 'flex';
    ui.audioTitle.textContent = item.name;
    ui.audioArtist.textContent = item.cast || item.folder || '';
    
    const albumArtUrl = item.meta_poster || `${state.serverUrl}/gds_dviewer/normal/explorer/album_art?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
    ui.audioPoster.src = albumArtUrl;
    ui.playerBg.style.backgroundImage = `url(${albumArtUrl})`;
    ui.playerBg.style.display = 'block';
  } else {
    ui.videoContainer.classList.remove('audio-mode');
    ui.audioVisual.style.display = 'none';
    ui.playerBg.style.display = 'none';
    
    // Add Subtitles
    const subtitleUrl = `${state.serverUrl}/gds_dviewer/normal/explorer/external_subtitle?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
    const track = document.createElement('track');
    Object.assign(track, {
      kind: 'subtitles',
      label: '한국어',
      srclang: 'ko',
      src: subtitleUrl,
      default: true
    });
    ui.mainPlayer.appendChild(track);
    
    ui.mainPlayer.addEventListener('loadedmetadata', () => {
      ui.playerTitle.textContent = item.name;
      if (ui.mainPlayer.textTracks.length > 0) {
        ui.mainPlayer.textTracks[0].mode = 'showing';
      }
    }, { once: true });
  }

  ui.mainPlayer.src = streamUrl;
  ui.mainPlayer.load();
  ui.mainPlayer.play().catch(err => {
    console.error('[PLAY] Web playback error:', err);
  });
}

// [NEW] Auto-hide Header Logic
function setupScrollHeader() {
  const container = document.querySelector('.content-container');
  const mainHeader = document.querySelector('.glass-header');
  const tabsHeader = document.querySelector('.view-header');
  
  let lastScrollTop = 0;
  const hideThreshold = 50; // Minimum scroll to trigger hide
  
  container.addEventListener('scroll', () => {
    const scrollTop = container.scrollTop;
    
    // Always show at the very top
    if (scrollTop < 10) {
      if (mainHeader) mainHeader.classList.remove('header-hidden');
      if (tabsHeader) tabsHeader.classList.remove('header-hidden');
      return;
    }
    
    // Scroll Down -> Hide (Disabled)
    if (scrollTop > lastScrollTop && scrollTop > hideThreshold) {
      // Logic removed
    } 
    // Scroll Up -> Show
    else if (scrollTop < lastScrollTop) {
      if (mainHeader) mainHeader.classList.remove('header-hidden');
      if (tabsHeader) tabsHeader.classList.remove('header-hidden');
    }
    
    lastScrollTop = scrollTop;
  }, { passive: true });
}

// [NEW] Programmatic Dragging Fallback for Tauri v2 Mac Overlay
function setupDragging() {
  const stableBar = document.getElementById('stable-drag-bar');
  const mainHeader = document.querySelector('.glass-header');
  const tabsHeader = document.querySelector('.view-header');
  
  const handleDrag = async (e) => {
    console.log('[DRAG] mousedown on header', e.target);
    // Ignore interactive elements
    if (e.target.closest('button, input, .tab, .icon-btn, #status-indicator')) return;
    
    try {
      // Tauri v2 Global API structure check
      const tauri = window.__TAURI__;
      if (tauri) {
        let appWindow = null;
        if (tauri.window && tauri.window.getCurrentWindow) {
           appWindow = tauri.window.getCurrentWindow();
        } else if (tauri.webviewWindow && tauri.webviewWindow.getCurrentWebviewWindow) {
           appWindow = tauri.webviewWindow.getCurrentWebviewWindow();
        } else if (tauri.window && tauri.window.Window && tauri.window.Window.getCurrent) {
           appWindow = tauri.window.Window.getCurrent();
        }
        
        if (appWindow && appWindow.startDragging) {
          await appWindow.startDragging();
        }
      }
    } catch (err) {
      console.error('[DRAG_ERROR]', err);
    }
  };
  
  if (stableBar) stableBar.addEventListener('mousedown', handleDrag);
  if (mainHeader) mainHeader.addEventListener('mousedown', handleDrag);
  if (tabsHeader) tabsHeader.addEventListener('mousedown', handleDrag);
}


// [NEW] Android TV Remote (Spatial) Navigation Manager
function setupRemoteNavigation() {
  console.log('[REMOTE] Initializing spatial navigation...');
  
  window.addEventListener('keydown', (e) => {
    const key = e.key;
    const current = document.activeElement;
    
    // DEBUG: Log all keys to see what the remote sends
    console.log('[REMOTE] KeyDown:', key, 'Code:', e.code, 'KeyCode:', e.keyCode);
    
    // Handle Enter/Select
    if (key === 'Enter') {
      if (current && current !== document.body) {
        console.log('[REMOTE] Enter on:', current);
        current.click();
      }
      return;
    }
    
    // Handle Back/Escape
    const backKeys = ['Escape', 'Backspace', 'BrowserBack', 'GoBack', 'XF86Back', 'Back'];
    const isBackKey = backKeys.includes(key) || e.keyCode === 4 || e.keyCode === 27;

    if (isBackKey) {
        const playerOverlay = ui.playerOverlay || document.getElementById('player-overlay');
        const isPlayerActive = playerOverlay && (playerOverlay.classList.contains('active') || playerOverlay.style.display === 'block' || window.getComputedStyle(playerOverlay).display !== 'none');
        
        console.log('[REMOTE] Back key detected. isPlayerActive:', isPlayerActive);
        
        if (isPlayerActive) {
            console.log('[REMOTE] Back on player - Closing player');
            e.preventDefault();
            e.stopPropagation();
            
            if (ui.mainPlayer) {
              ui.mainPlayer.pause();
              ui.mainPlayer.src = '';
            }
            
            if (playerOverlay) {
              playerOverlay.classList.remove('active');
              playerOverlay.style.display = 'none'; // Force hide
            }
            
            // Focus back to something logical
            setTimeout(() => {
              const lastFocused = document.querySelector('.card:focus, .tab:focus, .nav-item:focus');
              if (!lastFocused) {
                 const firstGridItem = document.querySelector('.card');
                 if (firstGridItem) firstGridItem.focus();
              }
            }, 100);
            return;
        } else if (state.pathStack.length > 0) {
            console.log('[REMOTE] Back on library - Going up');
            e.preventDefault();
            e.stopPropagation();
            state.pathStack.pop();
            state.currentPath = state.pathStack[state.pathStack.length - 1] || '';
            loadLibrary();
            return;
        } else if (state.currentView !== 'library') {
            console.log('[REMOTE] Back on non-library view - Returning to library');
            e.preventDefault();
            e.stopPropagation();
            switchView('library');
            return;
        }
    }

    // Spatial Navigation Logic
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
      const playerOverlay = ui.playerOverlay;
      const isPlayerActive = playerOverlay && playerOverlay.classList.contains('active');
      
      if (isPlayerActive) {
          const videoPlayer = ui.mainPlayer;
          const overlayUI = document.getElementById('custom-controls');
          const isOverlayHidden = overlayUI.classList.contains('hidden');

          // If overlay hidden, show it on any key and do nothing else
          if (isOverlayHidden) {
              showUI(); // Call the actual function
              e.preventDefault();
              return;
          }

          // If overlay is visible, handle focus within it
          // Get all focusable elements in player UI
          const playerFocusables = Array.from(overlayUI.querySelectorAll('button, input[type="range"]'));
          const focusedIdx = playerFocusables.indexOf(current);

          if (focusedIdx === -1) {
              // Not focused on any player control, focus the first one (Play/Pause)
              if (playerFocusables[0]) playerFocusables[0].focus();
              e.preventDefault();
              return;
          }

          // Navigate between controls
          if (key === 'ArrowRight' || key === 'ArrowDown') {
              const nextIdx = (focusedIdx + 1) % playerFocusables.length;
              playerFocusables[nextIdx].focus();
              e.preventDefault();
          } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
              const prevIdx = (focusedIdx - 1 + playerFocusables.length) % playerFocusables.length;
              playerFocusables[prevIdx].focus();
              e.preventDefault();
          }
          
          return;
      }

      console.log('[REMOTE] Key pressed:', key);
      e.preventDefault();
      moveFocus(key);
    }
  });

  // Initial Focus
  setTimeout(() => {
    const firstTab = document.querySelector('.tab.active') || document.querySelector('.tab');
    if (firstTab) firstTab.focus();
  }, 1000);
}

function moveFocus(direction) {
  const current = document.activeElement;
  const focusables = Array.from(document.querySelectorAll('button, input, [tabindex="0"], .card, .tab, .nav-item:not(.active-placeholder)'))
                    .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
  
  if (!current || current === document.body) {
    if (focusables.length > 0) focusables[0].focus();
    return;
  }

  const currentRect = current.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2
  };

  const findBestCandidate = (penalty) => {
    let bestCandidate = null;
    let minDistance = Infinity;

    focusables.forEach(candidate => {
      if (candidate === current) return;
      
      const candidateRect = candidate.getBoundingClientRect();
      const candidateCenter = {
        x: candidateRect.left + candidateRect.width / 2,
        y: candidateRect.top + candidateRect.height / 2
      };

      const dx = candidateCenter.x - currentCenter.x;
      const dy = candidateCenter.y - currentCenter.y;

      // Directional Filtering
      let isCorrectDirection = false;
      if (direction === 'ArrowUp') isCorrectDirection = dy < -1;
      if (direction === 'ArrowDown') isCorrectDirection = dy > 1;
      if (direction === 'ArrowLeft') isCorrectDirection = dx < -1;
      if (direction === 'ArrowRight') isCorrectDirection = dx > 1;

      if (isCorrectDirection) {
        // Distance Metric with penalty for perpendicular movement
        const dist = direction.includes('ArrowUp') || direction.includes('ArrowDown') 
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
  if (!target && direction === 'ArrowUp' && current.closest('.bottom-nav')) {
    console.log('[REMOTE] Panic escape from bottom nav: Jumping to first content item');
    // Try to find the most relevant "Up" target
    target = document.querySelector('.card, .tab.active, .tab, #search-input');
  }

  // Double check Target logic for Player
  if (!target && direction === 'ArrowDown' && current.closest('.player-header')) {
       target = document.getElementById('btn-center-play') || document.getElementById('progress-slider');
  }

  if (target) {
    console.log('[REMOTE] Success: Moving focus to', target);
    target.focus();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    console.warn('[REMOTE] No focusable candidate found for:', direction);
  }
}

// Utils
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
