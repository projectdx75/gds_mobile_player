// Tauri v2 GDS Mobile Player - main.js

// State Management
const state = {
  serverUrl: localStorage.getItem('gds_server_url') || '',
  apiKey: localStorage.getItem('gds_api_key') || '',
  currentView: 'library',
  category: 'video', // 'video', 'audio', 'animation', 'music_video', or ''
  library: [],
  currentPath: '', // For folder navigation
  pathStack: []    // Navigation history
};

// DOM Elements
const views = {
  library: document.getElementById('view-library'),
  search: document.getElementById('view-search'),
  settings: document.getElementById('view-settings')
};

const searchInput = document.getElementById('search-input');
const navItems = document.querySelectorAll('.nav-item');
const categoryTabs = document.querySelectorAll('.tab');
const playerOverlay = document.getElementById('player-overlay');
const mainPlayer = document.getElementById('main-player');
const playerTitle = document.getElementById('player-title');
const statusDot = document.getElementById('status-indicator');
const playerBg = document.getElementById('player-bg');
const audioVisual = document.getElementById('audio-visual');
const audioPoster = document.getElementById('audio-poster');
const audioTitle = document.getElementById('audio-title');
const audioArtist = document.getElementById('audio-artist');
const videoContainer = document.querySelector('.video-container');

// Initialize
window.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupTabs();
  setupSettings();
  setupSearch();
  setupPlayer();
  setupButtons();
  
  if (state.serverUrl && state.apiKey) {
    loadLibrary();
  } else {
    switchView('settings');
  }
});

// Navigation Logic
function setupNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      switchView(item.dataset.view);
    });
  });
}

function switchView(viewName) {
  Object.keys(views).forEach(key => {
    views[key].classList.toggle('active', key === viewName);
  });
  
  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });
  
  state.currentView = viewName;
}

// Tabs Logic
function setupTabs() {
  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      categoryTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.category = tab.dataset.category;
      state.currentPath = ''; // Reset path when switching tabs
      state.pathStack = [];
      loadLibrary();
    });
  });
}

// Global API Fetch
async function gdsFetch(endpoint) {
  if (!state.serverUrl || !state.apiKey) throw new Error('Setup required');
  
  const url = `${state.serverUrl}/gds_dviewer/normal/explorer/${endpoint.replace(/^\//, '')}`;
  const separator = url.includes('?') ? '&' : '?';
  const finalUrl = `${url}${separator}apikey=${state.apiKey}`;

  console.log(`[GDS-API] Calling: ${finalUrl}`);

  // Tauri HTTP Plugin Fallback
  const tauriHttp = window.__TAURI_PLUGIN_HTTP__ || (window.__TAURI__ && window.__TAURI__.http);
  if (tauriHttp) {
    try {
      const response = await tauriHttp.fetch(finalUrl, { method: 'GET', connectTimeout: 5000 });
      return await response.json();
    } catch (err) {
      console.warn('Tauri HTTP failed, using browser fetch:', err);
    }
  }

  const response = await fetch(finalUrl);
  return await response.json();
}

// Data Loading
async function loadLibrary() {
  const grid = document.getElementById('library-grid');
  grid.innerHTML = Array(6).fill('<div class="card skeleton"></div>').join('');
  
  try {
    statusDot.className = 'status-dot loading';
    
    // Folder-based categories (Animation, M/V) show folders first when at root
    const isFolderCategory = ['animation', 'music_video'].includes(state.category);
    const isAtRoot = !state.currentPath;
    
    let data;
    
    if (isFolderCategory && isAtRoot) {
      // Show anime/MV title folders first - folders now have category set
      const params = new URLSearchParams({
        query: '',
        is_dir: 'true',  // Folders only
        limit: '100',
        sort_by: 'date',
        sort_order: 'desc'
      });
      if (state.category) params.append('category', state.category);
      data = await gdsFetch(`search?${params.toString()}`);
    } else if (state.currentPath) {

      // Inside a folder - show its contents
      const params = new URLSearchParams({
        path: state.currentPath
      });
      data = await gdsFetch(`list?${params.toString()}`);
      // Transform list response to match search format
      if (data.ret === 'success' && data.items) {
        data.list = data.items;
      }
    } else {
      // Default: show files for non-folder categories
      const params = new URLSearchParams({
        query: '',
        is_dir: 'false',
        limit: '100',
        sort_by: 'date',
        sort_order: 'desc'
      });
      if (state.category) params.append('category', state.category);
      data = await gdsFetch(`search?${params.toString()}`);
    }

    
    if (data.ret === 'success') {
      state.library = data.list;
      renderGrid(grid, data.list, isFolderCategory);
      statusDot.className = 'status-dot success';
    } else {

      throw new Error(data.ret);
    }
  } catch (err) {
    console.error('Connection Error:', err);
    grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-secondary)">
      <p>Failed to connect to GDS server.</p>
      <small>${err.message}</small>
    </div>`;
    statusDot.className = 'status-dot error';
  }
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
    card.className = 'card';
    card.style.animation = `fadeIn 0.4s ease forwards ${index * 0.04}s`;
    card.style.opacity = '0';
    
    const isFolder = item.is_dir;
    
    // Poster logic with smart fallback
    let poster = item.meta_poster;
    if (!poster) {
      if (isFolder) {
        // For folders, try to get poster from yaml or use placeholder
        poster = item.poster || 'https://via.placeholder.com/300x450/1a1a2e/eee?text=📁';
      } else {
        // For video/animation/music_video, use server thumbnail extraction
        const category = item.category || 'other';
        if (['video', 'animation', 'music_video'].includes(category)) {
          poster = `${state.serverUrl}/gds_dviewer/normal/explorer/thumbnail?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&w=400&apikey=${state.apiKey}`;
        } else if (category === 'audio') {
          poster = `${state.serverUrl}/gds_dviewer/normal/explorer/album_art?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
        } else {
          poster = 'https://via.placeholder.com/300x450/111/333?text=No+Preview';
        }
      }
    }
    
    // Use meta_summary if available, otherwise parent folder
    const subtitle = isFolder 
      ? `${item.children_count || ''} 항목`
      : (item.meta_summary || item.title || item.path.split('/').slice(-2, -1)[0] || formatSize(item.size));
    
    card.innerHTML = `
      <img class="card-poster" src="${poster}" alt="${item.name}" loading="lazy" onerror="this.src='https://via.placeholder.com/300x450/111/333?text=Error'">
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
}


// Search Logic
function setupSearch() {
  let timeout = null;
  searchInput.addEventListener('input', (e) => {
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

// Settings Logic
function setupSettings() {
  const serverUrlInput = document.getElementById('server-url');
  const apiKeyInput = document.getElementById('api-key');
  const btnSave = document.getElementById('save-settings');
  const btnTestConnection = document.getElementById('btn-test-connection');
  
  serverUrlInput.value = state.serverUrl;
  apiKeyInput.value = state.apiKey;
  
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
      // Use the generic explorer/search for testing
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
  document.getElementById('btn-refresh').addEventListener('click', loadLibrary);
}

// Player Logic
function setupPlayer() {
  document.getElementById('btn-close-player').addEventListener('click', () => {
    mainPlayer.pause();
    playerOverlay.style.display = 'none';
    mainPlayer.src = '';
  });
}

function playVideo(item) {
  playerTitle.textContent = item.name;
  
  // Audio Player Mode logic
  const isAudio = item.category === 'audio' || item.ext === 'flac' || item.ext === 'mp3' || item.ext === 'm4a';
  
  if (isAudio) {
    videoContainer.classList.add('audio-mode');
    audioVisual.style.display = 'flex';
    audioTitle.textContent = item.name;
    audioArtist.textContent = item.cast || item.folder || 'GDS Audio Library';
    
    // Robust Album Art Retrieval
    const albumArtUrl = item.meta_poster || `${state.serverUrl}/gds_dviewer/normal/explorer/album_art?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
    audioPoster.src = albumArtUrl;
    playerBg.style.backgroundImage = `url(${albumArtUrl})`;
    playerBg.style.display = 'block';
  } else {
    videoContainer.classList.remove('audio-mode');
    audioVisual.style.display = 'none';
    playerBg.style.display = 'none';
  }

  let streamUrl = item.stream_url;
  if (!streamUrl.includes('apikey=')) {
    const separator = streamUrl.includes('?') ? '&' : '?';
    streamUrl += `${separator}apikey=${state.apiKey}`;
  }
  
  console.log('[PLAY] URL:', streamUrl);
  
  // Clear existing tracks
  while (mainPlayer.firstChild) {
    mainPlayer.removeChild(mainPlayer.firstChild);
  }
  
  mainPlayer.src = streamUrl;
  
  // Add subtitle track for video files
  if (!isAudio) {
    const subtitleUrl = `${state.serverUrl}/gds_dviewer/normal/explorer/external_subtitle?path=${encodeURIComponent(item.path)}&source_id=${item.source_id || 0}&apikey=${state.apiKey}`;
    
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = '한국어';
    track.srclang = 'ko';
    track.src = subtitleUrl;
    track.default = true;
    
    mainPlayer.appendChild(track);
    
    // Ensure track is showing
    mainPlayer.addEventListener('loadedmetadata', () => {
      if (mainPlayer.textTracks.length > 0) {
        mainPlayer.textTracks[0].mode = 'showing';
      }
    }, { once: true });
    
    console.log('[SUBTITLE] Added track:', subtitleUrl);
  }
  
  playerOverlay.style.display = 'flex';
  
  mainPlayer.play().catch(err => {
    console.error('[PLAY_ERROR]', err);
    if (err.name === 'NotSupportedError') {
      alert('This format is not supported by your device browser. Try another file.');
    }
  });
}


// Utils
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
