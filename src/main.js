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
  sourceId: 0,

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
  appendStallCount: 0,
  terminalProbeDone: false,
  lastAppendRequestAt: 0,
  scrollLoadArmed: false,
  autoFillTriggered: false,
  freshRequestSeq: 0,
  freshAbortController: null,
  episodeMetaReqSeq: 0,
  episodeMetaCache: new Map(),
  nativeFullscreenTransition: false,
  nativeSeekPreviewPos: null,
  nativeSeekPreviewTs: 0,
  nativeSeekPendingSteps: 0,
  nativeSeekBasePos: null,
  nativeArch: "unknown",
  fullscreenEnterRepairAttempted: false,
  lastFullscreenToggleAt: 0,
  domesticVirtualCategory: "방송중",
  movieVirtualCategory: "전체",
  animationVirtualCategory: "전체",
  moviePreviewOffset: 0,
  moviePreviewHasMore: true,
  moviePreviewLoading: false,
  moviePreviewSeenKeys: new Set(),
  moviePreviewItemMap: new Map(),
  animationRailOffset: 0,
  animationRailHasMore: true,
  animationRailLoading: false,
  animationRailSeenKeys: new Set(),
  animationPreviewItemMap: new Map(),
  dramaRailOffset: 0,
  dramaRailHasMore: true,
  dramaRailLoading: false,
  dramaRailSeenKeys: new Set(),
  dramaPreviewItemMap: new Map(),
  dramaPreviewCache: new Map(),
  folderContextPrimaryItem: null,
  previewAutoplayUnlocked: false,
  episodeDrawerOpen: false,
};

// Platform Detection
const isAndroid = /Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isDesktop = !isAndroid && !isIOS;
const DEBUG_LOG = localStorage.getItem("flashplex_debug_logs") === "1";
const dlog = (...args) => { if (DEBUG_LOG) console.log(...args); };
const dwarn = (...args) => { if (DEBUG_LOG) console.warn(...args); };
const folderMetaCache = new Map();
const folderMetaHydrateReq = new Map();
let nativeStatePollTimer = null;
let infiniteObserver = null;
let observedInfiniteSentinel = null;
let nativeResizeDebounceTimer = null;
let moviePreviewHoverTimer = null;
let activeMoviePreviewCard = null;
let pendingPreviewRequest = null;
let moviePreviewScrollTimer = null;
let moviePreviewAutoSlideTimer = null;
let moviePreviewUserInteracting = false;
const MOVIE_PREVIEW_DELAY_MS = 2000;
const PREVIEW_PLAYABLE_EXTS = new Set(["mp4", "m4v", "webm"]);
const PREVIEW_SOURCE_EXTS = new Set(["mp4", "m4v", "webm", "mkv", "avi", "mov", "ts"]);
const PREVIEW_RANDOM_SEEK_MIN_RATIO = 0.12;
const PREVIEW_RANDOM_SEEK_MAX_RATIO = 0.72;
const PREVIEW_START_TIMEOUT_MS = 4500;
const PREVIEW_STALL_RETRY_LIMIT = 2;
const PREVIEW_DEFAULT_VOLUME = 0.35;
const ANIMATION_PREVIEW_FETCH_LIMIT = 120;
const ANIMATION_PREVIEW_RENDER_LIMIT = 20;
const PREVIEW_AUTO_SLIDE_ENABLED = false;
const TRICKPLAY_DEFAULT_INTERVAL = 10;
const TRICKPLAY_DEFAULT_W = 320;
const TRICKPLAY_DEFAULT_H = 180;
const TRICKPLAY_HIDE_MS = 1200;
let animationRailAutoSlideTimer = null;
let dramaRailAutoSlideTimer = null;
let dramaRailUserInteracting = false;
const trickplayManifestCache = new Map();
let trickplayHideTimer = null;

function resetNativeSeekPending() {
  state.nativeSeekPendingSteps = 0;
  state.nativeSeekBasePos = null;
  state.nativeSeekPreviewPos = null;
  state.nativeSeekPreviewTs = 0;
}

function unlockPreviewAutoplay() {
  if (state.previewAutoplayUnlocked) return;
  state.previewAutoplayUnlocked = true;
  console.log("[PREVIEW] autoplay unlocked by user interaction");
  if (pendingPreviewRequest) {
    const { card, item } = pendingPreviewRequest;
    pendingPreviewRequest = null;
    scheduleMoviePreviewPlayback(card, item, true);
  }
}

function getPathExtension(pathValue) {
  const raw = String(pathValue || "");
  const idx = raw.lastIndexOf(".");
  if (idx < 0) return "";
  return raw.slice(idx + 1).toLowerCase();
}

function getParentPath(pathValue) {
  const raw = String(pathValue || "").replace(/\\/g, "/");
  const idx = raw.lastIndexOf("/");
  if (idx <= 0) return "";
  return raw.slice(0, idx);
}

function splitPathSegments(pathValue) {
  return String(pathValue || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
}

function cleanMediaTitle(rawTitle) {
  return String(rawTitle || "")
    .replace(/\.(mkv|mp4|avi|srt|ass|m4v|webm|ts)$/i, "")
    .replace(/[._]/g, " ")
    .trim();
}

function normalizeWorkTitle(rawTitle) {
  return cleanMediaTitle(rawTitle)
    .toUpperCase()
    .replace(/\b(2160P|1080P|720P|4K|UHD|HDR|DV|HEVC|X265|X264|H\.?265|H\.?264|WEB[\s\-]?DL|BLURAY|AAC|DDP?5?\.?1|ATMOS|KOR|JPN|ENG)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericAnimeBucket(name) {
  const n = String(name || "").toLowerCase();
  const generic = new Set([
    "video", "ani", "anime", "animation", "애니", "애니메이션",
    "라프텔", "laftel", "방영중", "완결", "신작", "최신",
    "tv", "극장판", "더빙", "자막", "고전", "기타",
  ]);
  return generic.has(n) || n.length <= 1;
}

function isGenericMovieBucket(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return true;
  if (n.length <= 1) return true;
  if (/^[가-힣]$/.test(n)) return true;
  if (/^[a-z]$/.test(n)) return true;
  if (/^\d+[a-z]?$/.test(n)) return true; // e.g. 0, 0z
  const generic = new Set([
    "movie", "movies", "영화", "기타", "others", "etc", "up", "upload", "업로드",
    "국내영화", "외국영화", "한글", "영문", "숫자",
  ]);
  return generic.has(n);
}

function isSeasonLikeName(name) {
  const n = String(name || "").trim().toLowerCase();
  return /^s\d{1,2}$/.test(n) ||
    /^season\s*\d+/.test(n) ||
    /^시즌\s*\d+/.test(n) ||
    /^\d+\s*기$/.test(n) ||
    /^part\s*\d+/.test(n) ||
    /^cour\s*\d+/.test(n) ||
    /^vol(?:ume)?\s*\d+/.test(n) ||
    /^chapter\s*\d+/.test(n) ||
    n === "specials" ||
    n === "ova";
}

function extractEpisodeLabel(item) {
  const fileName = String(item?.name || item?.title || "");
  const fromMeta = Number(item?.meta_episode);
  if (Number.isFinite(fromMeta)) return `EP ${String(fromMeta).padStart(2, "0")}`;

  const sxe = fileName.match(/S(\d{1,2})E(\d{1,3})/i);
  if (sxe) return `S${sxe[1].padStart(2, "0")}E${sxe[2].padStart(2, "0")}`;

  const ep = fileName.match(/(?:EP?|E|제)\s*\.?(\d{1,3})(?:화)?/i);
  if (ep) return `EP ${String(ep[1]).padStart(2, "0")}`;
  return "";
}

function extractEpisodeNumber(item) {
  const fromMeta = Number(item?.meta_episode);
  if (Number.isFinite(fromMeta)) return fromMeta;
  const fileName = String(item?.name || item?.title || "");
  const sxe = fileName.match(/S(\d{1,2})E(\d{1,3})/i);
  if (sxe) return Number(sxe[2]);
  const ep = fileName.match(/(?:EP?|E|제)\s*\.?(\d{1,3})(?:화)?/i);
  if (ep) return Number(ep[1]);
  return -1;
}

function inferSeriesTitleFromFileName(item) {
  const base = cleanMediaTitle(item?.meta_title || item?.title || item?.name || "Untitled");
  return base
    .replace(/\bS\d{1,2}E\d{1,3}\b/ig, " ")
    .replace(/\b(?:EP?|E|제)\s*\.?\d{1,3}(?:화)?\b/ig, " ")
    .replace(/\b(2160P|1080P|720P|4K|UHD|HDR|HEVC|X265|X264|WEB[\s\-]?DL|BLURAY|AAC|DDP?5?\.?1|ATMOS)\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferWorkTitleFromPath(pathValue) {
  const fileName = String(pathValue || "").split("/").filter(Boolean).pop() || "";
  if (!fileName) return "";
  return cleanMediaTitle(fileName)
    .replace(/\bS\d{1,2}E\d{1,3}\b/ig, " ")
    .replace(/\b(?:EP?|E|제)\s*\.?\d{1,3}(?:화)?\b/ig, " ")
    .replace(/\b(2160P|1080P|720P|4K|UHD|HDR|DV|HEVC|X265|X264|H\.?265|H\.?264|WEB[\s\-]?DL|BLURAY|AAC|DDP?5?\.?1|ATMOS|KOR|JPN|ENG)\b/ig, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\{[^}]+\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUnusableWorkTitle(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (isGenericMovieBucket(t)) return true;
  return false;
}

function isTechnicalMovieFolderName(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  return /(1080p|2160p|720p|4k|uhd|bluray|web[\s\-]?dl|webrip|x26[45]|h\.?26[45]|hevc|aac|ddp|atmos|\[[^\]]+\])/.test(n);
}

function firstUsableMovieTitle(candidates = []) {
  for (const raw of candidates) {
    const t = cleanMediaTitle(raw);
    if (!isUnusableWorkTitle(t)) return t;
  }
  return cleanMediaTitle(candidates.find(Boolean) || "");
}

function buildMoviePreviewIdentity(item, folderPath) {
  const folderLeaf = splitPathSegments(folderPath).slice(-1)[0] || "";
  const hierarchyTitle = inferMovieTitleFromPathHierarchy(item?.path || "");
  const inferredTitle = firstUsableMovieTitle([
    item?.meta_title,
    item?.title,
    hierarchyTitle,
    inferSeriesTitleFromFileName(item),
    inferWorkTitleFromPath(item?.path || ""),
    item?.name,
    "Untitled",
  ]);
  const isBucketFolder = isGenericMovieBucket(folderLeaf);
  const groupKey = isBucketFolder
    ? `${folderPath}::${normalizeWorkTitle(inferredTitle)}`
    : folderPath;
  return { folderLeaf, hierarchyTitle, inferredTitle, isBucketFolder, groupKey };
}

function resolveMoviePreviewTitle(identity, item, folderMeta, parentMeta) {
  if (identity.isBucketFolder) {
    return firstUsableMovieTitle([
      identity.inferredTitle,
      identity.hierarchyTitle,
      inferWorkTitleFromPath(item?.path || ""),
      item?.meta_title,
      item?.title,
      item?.name,
      "Untitled",
    ]);
  }
  return firstUsableMovieTitle([
    folderMeta?.meta_title,
    folderMeta?.title,
    folderMeta?.album_info?.title,
    parentMeta?.meta_title,
    parentMeta?.title,
    parentMeta?.album_info?.title,
    isTechnicalMovieFolderName(identity.folderLeaf) ? "" : identity.folderLeaf,
    identity.hierarchyTitle,
    identity.inferredTitle,
    inferWorkTitleFromPath(item?.path || ""),
    item?.meta_title,
    item?.title,
    item?.name,
    "Untitled",
  ]);
}

function inferMovieTitleFromPathHierarchy(pathValue) {
  const segs = splitPathSegments(String(pathValue || "").normalize("NFC"));
  if (!segs.length) return "";
  // Drop filename segment when path points to a media file.
  const last = segs[segs.length - 1] || "";
  const hasMediaExt = /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i.test(last);
  const end = hasMediaExt ? segs.length - 2 : segs.length - 1;
  for (let i = end; i >= 0; i -= 1) {
    const name = cleanMediaTitle(segs[i] || "");
    if (!name) continue;
    if (isGenericMovieBucket(name)) continue;
    if (isTechnicalMovieFolderName(name)) continue;
    if (isSeasonLikeName(name)) continue;
    return name;
  }
  return "";
}

function resolveAnimeSeriesMeta(item) {
  const normalizedPath = String(item?.path || "").normalize("NFC");
  const segs = splitPathSegments(normalizedPath);
  if (segs.length === 0) {
    return { seriesPath: "", seriesTitle: cleanMediaTitle(item?.meta_title || item?.title || item?.name || "Untitled") };
  }

  // Walk upward from file parent and pick first meaningful folder as series anchor.
  let folderIdx = Math.max(0, segs.length - 2);
  while (folderIdx > 0) {
    const name = segs[folderIdx];
    if (!isSeasonLikeName(name) && !isGenericAnimeBucket(name)) break;
    folderIdx -= 1;
  }

  const chosen = segs[folderIdx] || "";
  const chosenIsGeneric = isGenericAnimeBucket(chosen) || chosen.toLowerCase() === "video";
  const fallbackTitle = inferSeriesTitleFromFileName(item);
  const seriesTitle = cleanMediaTitle(chosenIsGeneric ? (fallbackTitle || chosen || "Untitled") : chosen);
  const prefixPath = ("/" + segs.slice(0, Math.max(1, folderIdx + 1)).join("/")).normalize("NFC");
  // If folder bucket is too generic, include inferred title in key path to avoid collapsing all titles.
  const seriesPath = chosenIsGeneric ? `${prefixPath}::${seriesTitle}` : prefixPath;
  return { seriesPath, seriesTitle };
}

function findNearestFolderMeta(pathValue, maxDepth = 8) {
  let p = String(pathValue || "").replace(/^\/+/, "");
  let depth = 0;
  while (p && depth < maxDepth) {
    const m = folderMetaCache.get(p) || folderMetaCache.get(`/${p}`) || null;
    if (m && (m.meta_title || m.title || m.meta_poster || m.poster || m.meta_summary || m.summary || m.desc)) {
      return m;
    }
    p = getParentPath(p).replace(/^\/+/, "");
    depth += 1;
  }
  return null;
}

function cacheFolderMetaEntry(item) {
  if (!item || !item.is_dir || !item.path) return;
  const normalizedPath = String(item.path || "").replace(/^\/+/, "").normalize("NFC");
  if (!normalizedPath) return;
  folderMetaCache.set(normalizedPath, {
    path: normalizedPath,
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
    meta_json: item.meta_json || null,
    genre: item.genre || [],
    source_id: Number(normalizeSourceId(item.source_id)),
  });
}

async function hydrateFolderMetaFromParent(pathValue, sourceId = 0) {
  const normalizedPath = String(pathValue || "").replace(/^\/+/, "").normalize("NFC");
  if (!normalizedPath) return null;
  const existing = folderMetaCache.get(normalizedPath) || null;
  if (existing && (existing.meta_poster || existing.poster || existing.meta_title || existing.title)) {
    return existing;
  }

  const reqKey = `${normalizeSourceId(sourceId)}:${normalizedPath}`;
  if (folderMetaHydrateReq.has(reqKey)) return folderMetaHydrateReq.get(reqKey);

  const reqPromise = (async () => {
    const parentPath = String(getParentPath(normalizedPath) || "").replace(/^\/+/, "").normalize("NFC");
    if (!parentPath) return null;
    const params = new URLSearchParams({
      path: parentPath,
      recursive: "false",
      limit: "300",
      offset: "0",
      sort_by: "date",
      sort_order: "desc",
      source_id: normalizeSourceId(sourceId),
    });
    const data = await gdsFetch(`list?${params.toString()}`);
    if (!data || data.ret !== "success") return null;
    const list = data.list || data.data || [];
    list.forEach((entry) => cacheFolderMetaEntry(entry));
    return folderMetaCache.get(normalizedPath) || null;
  })().finally(() => {
    folderMetaHydrateReq.delete(reqKey);
  });

  folderMetaHydrateReq.set(reqKey, reqPromise);
  return reqPromise;
}

function seekPreviewVideoRandom(video) {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 1.5) return;
  const minT = Math.max(0.3, video.duration * PREVIEW_RANDOM_SEEK_MIN_RATIO);
  const maxT = Math.max(minT + 0.2, video.duration * PREVIEW_RANDOM_SEEK_MAX_RATIO);
  const target = minT + Math.random() * (maxT - minT);
  try {
    video.currentTime = Math.min(Math.max(0.25, target), Math.max(0.4, video.duration - 0.35));
  } catch (_) {}
}

function isNearListBottom(extra = 220) {
  const container = document.querySelector(".content-container");
  if (!container) return false;
  const remaining = container.scrollHeight - (container.scrollTop + container.clientHeight);
  return remaining <= extra;
}

function maybeLoadMore(reason = "observer") {
  const now = Date.now();
  const minGap = 900;
  if (now - (state.lastAppendRequestAt || 0) < minGap) return;

  // Prevent prefetch storms before user actually scrolls.
  if (reason !== "auto-fill") {
    if (!state.scrollLoadArmed) return;
    if (!isNearListBottom(260)) return;
  } else if (state.autoFillTriggered) {
    return;
  }

  if (state.hasMore && !state.isLoadingMore && state.isFirstFreshLoadDone) {
    if (reason === "auto-fill") state.autoFillTriggered = true;
    state.lastAppendRequestAt = now;
    dlog(`[SCROLL:${reason}] Loading more items... offset=${state.offset}`);
    loadLibrary(false, true);
  }
}

function getCurrentFolderName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function isIndexBucketFolder(path) {
  const name = getCurrentFolderName(path).trim();
  if (!name) return false;
  if (name.toUpperCase() === "0Z") return true;
  if (/^[가-힣]$/.test(name)) return true;
  if (/^[A-Z]$/i.test(name)) return true;
  if (/^[0-9]$/.test(name)) return true;
  return false;
}

function getInfiniteScrollRoot() {
  const container = document.querySelector(".content-container");
  return container || null;
}

function ensureInfiniteSentinel(gridEl) {
  if (!gridEl) return;
  let sentinel = gridEl.querySelector(".infinite-sentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.className = "infinite-sentinel";
    sentinel.style.height = "1px";
    sentinel.style.width = "100%";
    sentinel.style.gridColumn = "1 / -1";
    sentinel.style.pointerEvents = "none";
    gridEl.appendChild(sentinel);
  } else {
    // Keep sentinel at the end after new cards are appended.
    gridEl.appendChild(sentinel);
  }

  if (!("IntersectionObserver" in window)) return;

  const root = getInfiniteScrollRoot();
  if (!infiniteObserver) {
    infiniteObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) maybeLoadMore("sentinel");
        });
      },
      {
        root,
        rootMargin: "0px 0px 420px 0px",
        threshold: 0,
      },
    );
  }

  if (observedInfiniteSentinel !== sentinel) {
    if (observedInfiniteSentinel) infiniteObserver.unobserve(observedInfiniteSentinel);
    infiniteObserver.observe(sentinel);
    observedInfiniteSentinel = sentinel;
  }
}

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

async function detectNativeArch() {
  const invoke = getTauriInvoke();
  if (!invoke) return;
  try {
    const arch = await invoke("native_get_arch");
    if (typeof arch === "string" && arch.length > 0) {
      state.nativeArch = arch;
      console.log("[STARTUP] Native arch:", arch);
    }
  } catch (err) {
    console.warn("[STARTUP] native_get_arch failed:", err);
  }
}

function normalizeQualityProfile(profile) {
  if (profile === "quality" || profile === "smooth") return profile;
  return "balanced";
}

function normalizeSourceId(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return String(parsed);
  return String(state.sourceId ?? 0);
}

function cssEscapeValue(value) {
  const str = String(value ?? "");
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(str);
  return str.replace(/["\\]/g, "\\$&");
}

function parseMtimeToEpoch(v) {
  if (!v) return 0;
  const raw = String(v).trim();
  if (!raw) return 0;
  const ts = Date.parse(raw.replace(" ", "T"));
  return Number.isFinite(ts) ? ts : 0;
}

function tvShowPriorityScore(item) {
  const name = String(item?.name || "").toLowerCase();
  const path = String(item?.path || "").toLowerCase();
  const hay = `${name} ${path}`;

  // 0 is highest priority.
  if (hay.includes("방송중") || hay.includes("방영중") || hay.includes("on air") || hay.includes("airing")) return 0;
  if (hay.includes("신작") || hay.includes("최신")) return 1;
  if (hay.includes("완결") || hay.includes("종영") || hay.includes("방영종료") || hay.includes("ended")) return 3;
  return 2;
}

function isBucketOnlyDirectoryList(items = []) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((it) => !!it?.is_dir && isIndexBucketFolder(it.path || it.name));
}

function matchesDomesticVirtualCategory(item, selected) {
  const name = String(item?.name || "").toLowerCase();
  const path = String(item?.path || "").toLowerCase();
  const hay = `${name} ${path}`;
  const has = (kw) => hay.includes(String(kw).toLowerCase());

  if (selected === "방송중") return has("방송중") || has("방영중") || has("on air") || has("airing");
  if (selected === "완결") return !has("방송중") && !has("방영중") && !has("on air") && !has("airing");
  // Path prefix guard is applied in caller; keep these categories permissive.
  if (selected === "드라마") return true;
  if (selected === "예능") return true;
  if (selected === "다큐") return true;
  if (selected === "시사") return true;
  if (selected === "뉴스") return true;
  if (selected === "기타") {
    const majorHints = ["/드라마", " 드라마", "drama", "/예능", " 예능", "variety", "/다큐", " 다큐", "documentary", "/시사", " 시사", "/뉴스", " 뉴스", "news"];
    return !majorHints.some((kw) => has(kw));
  }
  return true;
}

function normalizePathForCompare(pathValue) {
  return String(pathValue || "")
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function getAdaptiveThumbnailWidth(container) {
  try {
    if (!container) return 400;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const style = window.getComputedStyle(container);
    const colsRaw = (style.gridTemplateColumns || "").trim();
    let colCount = 1;
    if (colsRaw && colsRaw !== "none") {
      colCount = Math.max(1, colsRaw.split(/\s+/).length);
    }
    const gap = parseFloat(style.columnGap || style.gap || "0") || 0;
    const available = Math.max(320, container.clientWidth - gap * Math.max(0, colCount - 1));
    const cssCardWidth = Math.max(160, available / colCount);
    const requested = Math.round(cssCardWidth * dpr);
    return Math.max(280, Math.min(560, requested));
  } catch (_) {
    return 400;
  }
}

function applyEpisodeMetaToGrid(metaList = []) {
  const grid = ui.grid;
  if (!grid || !Array.isArray(metaList) || metaList.length === 0) return;

  metaList.forEach((meta) => {
    const rawPath = meta?.path || "";
    if (!rawPath) return;
    const key = rawPath.normalize("NFC");
    const card = grid.querySelector(`[data-path="${cssEscapeValue(key)}"]`);
    if (!card) return;

    const epNo = Number(meta?.episode);
    const epLabel = Number.isFinite(epNo) ? `Episode ${String(epNo).padStart(2, "0")}` : "";
    const titleEl = card.querySelector(".card-title");
    const subtitleEl = card.querySelector(".card-subtitle");
    const eyebrowEl = card.querySelector(".card-eyebrow");

    if (titleEl) {
      if (meta?.title) titleEl.textContent = epLabel ? `${epLabel} · ${meta.title}` : meta.title;
      else if (epLabel) titleEl.textContent = epLabel;
    }
    if (subtitleEl && meta?.summary) subtitleEl.textContent = String(meta.summary);
    if (eyebrowEl && epLabel) eyebrowEl.textContent = epLabel.toUpperCase();
  });

  // Keep in-memory state aligned so subsequent interactions reuse enriched values.
  const byPath = new Map(metaList.map((m) => [String(m.path || "").normalize("NFC"), m]));
  state.library = (state.library || []).map((item) => {
    const key = String(item?.path || "").normalize("NFC");
    const m = byPath.get(key);
    if (!m) return item;
    return {
      ...item,
      meta_episode: m.episode ?? item.meta_episode,
      meta_title: m.title || item.meta_title,
      meta_summary: m.summary || item.meta_summary,
      meta_aired: m.aired || item.meta_aired,
      meta_thumb: m.thumb || item.meta_thumb,
    };
  });
}

async function enrichEpisodeMetaForCurrentFolder(folderPath, sourceId, reqSeq) {
  if (!folderPath) return;
  const source = normalizeSourceId(sourceId);
  const cacheKey = `${source}:${folderPath}`;

  let metaList = state.episodeMetaCache.get(cacheKey);
  if (!metaList) {
    const params = new URLSearchParams({
      path: folderPath,
      source_id: source,
    });
    const data = await gdsFetch(`episode_meta?${params.toString()}`);
    if (!data || data.ret !== "success") return;
    metaList = data.list || [];
    state.episodeMetaCache.set(cacheKey, metaList);
  }

  if (reqSeq !== state.episodeMetaReqSeq) return; // stale response guard
  applyEpisodeMetaToGrid(metaList);
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
    const releaseDelay = String(reason).includes("fullscreen") ? 420 : 300;
    if (ui.premiumOsc) {
      setTimeout(() => {
        if (state.isNativeActive && !state.nativeRecreating && !state.nativeFullscreenTransition) {
          ui.premiumOsc.classList.remove("hidden");
        }
        setNativeTransitionMask(false);
      }, releaseDelay);
    } else {
      setTimeout(() => setNativeTransitionMask(false), releaseDelay);
    }
  }
}

function setNativeTransitionMask(active) {
  document.body.classList.toggle("native-recreate-active", !!active);
  document.documentElement.classList.toggle("native-recreate-active", !!active);
  if (ui.premiumOsc && active) ui.premiumOsc.classList.add("hidden");
}

async function prefitNativeContainerForFullscreen(invoke, targetFs) {
  if (!invoke || !state.isNativeActive) return;
  const settleDelays = targetFs ? [0, 90, 190] : [0, 70, 150];
  for (const delay of settleDelays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    await invoke("resize_native_player", {}).catch(() => {});
  }
}

async function stabilizeNativeFullscreenResize(invoke, targetFs) {
  if (!invoke || !state.isNativeActive) return;
  // macOS fullscreen animation settles late on some Intel setups.
  // Keep Intel very short to avoid visible bounce during transition.
  const isIntel = state.nativeArch === "x86_64";
  const settleDelays = isIntel
    ? (targetFs ? [120, 280] : [80, 180])
    : (targetFs ? [0, 130, 280, 460, 700, 980] : [0, 100, 220, 360, 560]);
  for (const delay of settleDelays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    await invoke("resize_native_player", {}).catch(() => {});
  }
}

async function waitForNativeFullscreenState(invoke, targetFs, timeoutMs = 1400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await invoke("native_get_fullscreen").catch(() => null);
    if (current === targetFs) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

async function maybeRecreateOnFullscreenExitIntel(invoke) {
  if (!invoke || !state.isNativeActive) return;
  if (state.nativeArch !== "x86_64") return;
  await new Promise((r) => setTimeout(r, 260));
  const snap = await invoke("get_mpv_state").catch(() => null);
  const osdW = Number(snap?.osd_width ?? -1);
  const expectedW = Math.round((window.innerWidth || 0) * (window.devicePixelRatio || 1));
  if (osdW > 0 && expectedW > 0 && Math.abs(osdW - expectedW) > 280) {
    console.warn("[PLAYER] Intel fullscreen-exit osd mismatch -> recreate once", { osdW, expectedW });
    await recreateNativePlayerAfterResize("fullscreen-exit-intel-fix");
    await invoke("resize_native_player", {}).catch(() => {});
  }
}

async function maybeRecreateOnFullscreenEnterIntel(invoke) {
  if (!invoke || !state.isNativeActive) return;
  if (state.nativeArch !== "x86_64") return;
  if (state.fullscreenEnterRepairAttempted) return;
  state.fullscreenEnterRepairAttempted = true;

  await new Promise((r) => setTimeout(r, 320));
  const snap = await invoke("get_mpv_state").catch(() => null);
  const osdW = Number(snap?.osd_width ?? -1);
  const expectedW = Math.round((window.innerWidth || 0) * (window.devicePixelRatio || 1));
  if (osdW > 0 && expectedW > 0 && Math.abs(osdW - expectedW) > 420) {
    console.warn("[PLAYER] Intel fullscreen-enter osd mismatch -> recreate once", { osdW, expectedW });
    await recreateNativePlayerAfterResize("fullscreen-enter-intel-fix");
    await invoke("resize_native_player", {}).catch(() => {});
  }
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


async function resolveBestSubtitleForAndroid(item, bpath, fallbackUrl) {
  try {
    const videoInfoUrl = `${state.serverUrl}/gds_dviewer/normal/get_video_info?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
    if (window.tlog) window.tlog(`[SUB-ANDROID] Fetching video info: ${videoInfoUrl}`);
    const res = await fetch(videoInfoUrl).then((r) => r.json());
    const tracks = res?.data?.subtitles || [];

    const toFullUrl = (s) => {
      if (!s?.url) return null;
      if (s.url.startsWith('http')) return s.url;
      const u = `${state.serverUrl}${s.url}`;
      return u.includes('apikey=') ? u : `${u}${u.includes('?') ? '&' : '?'}apikey=${state.apiKey}`;
    };

    const isKo = (s) => {
      const lang = String(s?.lang || s?.language || '').toLowerCase();
      const title = String(s?.title || '').toLowerCase();
      return lang === 'ko' || lang === 'kor' || lang.startsWith('ko-') || lang.startsWith('ko_') ||
        title.includes('korean') || title.includes('한국어') || title.includes('.ko');
    };

    const sidecars = tracks.filter((t) => t?.type === 'sidecar');
    const embedded = tracks.filter((t) => t?.type !== 'sidecar');

    // mpv-like preference: sidecar Korean -> sidecar any -> embedded Korean -> fallback external endpoint
    const best =
      sidecars.find(isKo) ||
      sidecars[0] ||
      embedded.find(isKo) ||
      null;

    const bestUrl = toFullUrl(best);
    if (bestUrl) {
      if (window.tlog) window.tlog(`[SUB-ANDROID] Selected subtitle: ${best?.title || best?.lang || 'unknown'}`);
      return bestUrl;
    }

    if (window.tlog) window.tlog('[SUB-ANDROID] No explicit subtitle URL from tracks, using fallback endpoint');
    return fallbackUrl;
  } catch (e) {
    console.warn('[SUB-ANDROID] resolve failed, using fallback subtitle URL', e);
    return fallbackUrl;
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
      moviePreviewRail: document.getElementById("movie-preview-rail"),
      moviePreviewTrack: document.getElementById("movie-preview-track"),
      animationRail: document.getElementById("animation-rail"),
      animationTrack: document.getElementById("animation-track"),
      animationPreviewMeta: document.getElementById("animation-preview-meta"),
      dramaRail: document.getElementById("drama-rail"),
      dramaTrack: document.getElementById("drama-track"),
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
  detectNativeArch();
  if (window.lucide) lucide.createIcons();

  // Register robust global listeners
  document.addEventListener("keydown", unlockPreviewAutoplay, { once: true });
  document.addEventListener("mousedown", unlockPreviewAutoplay, { once: true });
  document.addEventListener("touchstart", unlockPreviewAutoplay, { once: true });

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
    setupMoviePreviewRail();
    setupAnimationRail();
    setupDramaRail();
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
      hideTrickplayOverlay();
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
    setMoviePreviewRailVisible(false);
    setAnimationRailVisible(false);
    setDramaRailVisible(false);
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
      document.body.classList.toggle("category-movie", cat === "movie");
      document.body.classList.toggle("category-tv", cat === "tv_show");
      document.body.classList.toggle("category-animation", cat === "animation");
      state.currentPath = "";
      state.pathStack = [];
      state.offset = 0;
      state.library = [];
      state.query = ""; // Reset query when switching categories
      if (getVirtualConfig(cat)) setVirtualBucket(cat, getVirtualConfig(cat).defaultBucket);

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

function syncCategoryBodyClasses() {
  const cat = String(state.category || "");
  document.body.classList.toggle("category-movie", cat === "movie");
  document.body.classList.toggle("category-tv", cat === "tv_show");
  document.body.classList.toggle("category-animation", cat === "animation");
}

const VIRTUAL_CATEGORY_CONFIG = {
  tv_show: {
    rootPath: "VIDEO/국내TV",
    stateKey: "domesticVirtualCategory",
    defaultBucket: "방송중",
    endpoint: "series_domestic",
    debugTag: "SERIES_DOMESTIC_URL",
    categories: ["방송중", "완결", "드라마", "예능", "다큐멘터리", "교양", "시사", "뉴스", "데일리", "음악", "기타"],
  },
  movie: {
    rootPath: "VIDEO/영화",
    stateKey: "movieVirtualCategory",
    defaultBucket: "전체",
    endpoint: "movie_virtual",
    debugTag: "MOVIE_VIRTUAL_URL",
    categories: ["전체", "한국영화", "외국영화", "고화질(4K)", "고전영화", "액션", "스릴러", "코미디"],
  },
  animation: {
    rootPath: "VIDEO/애니메이션",
    stateKey: "animationVirtualCategory",
    defaultBucket: "전체",
    endpoint: "animation_virtual",
    debugTag: "ANIMATION_VIRTUAL_URL",
    categories: ["전체", "TV 애니", "극장판", "OVA", "라프텔"],
  },
};

const categorySubMenus = {
  tv_show: ["국내", "해외", ...VIRTUAL_CATEGORY_CONFIG.tv_show.categories],
  movie: [...VIRTUAL_CATEGORY_CONFIG.movie.categories],
  animation: [...VIRTUAL_CATEGORY_CONFIG.animation.categories],
};
function getVirtualConfig(category) {
  return VIRTUAL_CATEGORY_CONFIG[category] || null;
}

function getVirtualBucket(category) {
  const cfg = getVirtualConfig(category);
  if (!cfg) return "";
  return state[cfg.stateKey] || cfg.defaultBucket;
}

function setVirtualBucket(category, value) {
  const cfg = getVirtualConfig(category);
  if (!cfg) return;
  state[cfg.stateKey] = value || cfg.defaultBucket;
}

function resetAllVirtualBuckets() {
  Object.keys(VIRTUAL_CATEGORY_CONFIG).forEach((cat) => {
    const cfg = VIRTUAL_CATEGORY_CONFIG[cat];
    state[cfg.stateKey] = cfg.defaultBucket;
  });
}

function isVirtualRoot(category, currentPath) {
  const cfg = getVirtualConfig(category);
  return !!cfg && currentPath === cfg.rootPath;
}
const tvShowPathMap = {
  "국내": "VIDEO/국내TV",
  "해외": "VIDEO/해외TV",
  "드라마": "VIDEO/국내TV/드라마",
  "예능": "VIDEO/국내TV/예능",
  "다큐": "VIDEO/국내TV/다큐멘터리",
  "다큐멘터리": "VIDEO/국내TV/다큐멘터리",
  "뉴스": "VIDEO/국내TV/뉴스",
  "교양": "VIDEO/국내TV/교양",
  "시사": "VIDEO/국내TV/시사",
  "음악": "VIDEO/국내TV/음악",
  "데일리": "VIDEO/국내TV/데일리"
};
let lastFocusedBeforeCategoryMenu = null;

function closeCategorySubMenu() {
  const overlay = document.getElementById("category-menu-overlay");
  if (!overlay) return false;
  overlay.classList.remove("active");
  setTimeout(() => overlay.remove(), 300);
  if (lastFocusedBeforeCategoryMenu && typeof lastFocusedBeforeCategoryMenu.focus === "function") {
    setTimeout(() => lastFocusedBeforeCategoryMenu.focus(), 80);
  }
  return true;
}

function showCategorySubMenu(category, tabEl) {
  const subItems = categorySubMenus[category];
  if (!subItems) return;

  // Remove existing
  closeCategorySubMenu();

  const overlay = document.createElement("div");
  overlay.id = "category-menu-overlay";
  overlay.className = "category-menu-overlay";
  overlay.setAttribute("aria-modal", "true");
  
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
  lastFocusedBeforeCategoryMenu = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Animate in
  setTimeout(() => {
    overlay.classList.add("active");
    const first = overlay.querySelector(".category-option.active") || overlay.querySelector(".category-option");
    if (first && typeof first.focus === "function") first.focus();
  }, 10);

  overlay.querySelectorAll(".category-option").forEach(opt => {
    opt.tabIndex = 0;
    opt.setAttribute("role", "button");
  });

  // Handlers
  overlay.onclick = (e) => {
    if (e.target === overlay) {
        closeCategorySubMenu();
    }
  };

  overlay.querySelectorAll(".category-option").forEach(opt => {
    opt.onclick = () => {
        const q = opt.dataset.query;
        console.log(`[NAV] Sub-category selected: ${q} in ${category}`);
        
        // [TV SHOW] Prefer server-driven domestic endpoint for consistent behavior.
        if (category === 'tv_show') {
          const tvCfg = getVirtualConfig("tv_show");
          const domesticMenuSet = new Set([
            "국내",
            ...tvCfg.categories
          ]);
          if (!q) {
            state.currentPath = "";
            state.pathStack = [];
            state.query = "";
            setVirtualBucket("tv_show", tvCfg.defaultBucket);
          } else if (domesticMenuSet.has(q)) {
            // Force domestic virtual root so loadLibrary() always calls `series_domestic`.
            state.currentPath = tvCfg.rootPath;
            state.pathStack = [tvCfg.rootPath];
            state.query = "";
            setVirtualBucket("tv_show", q === "국내" ? tvCfg.defaultBucket : q);
          } else if (tvShowPathMap[q]) {
            state.currentPath = tvShowPathMap[q];
            state.pathStack = [tvShowPathMap[q]];
            state.query = "";
            if (q === "국내") setVirtualBucket("tv_show", tvCfg.defaultBucket);
          } else {
            // Fallback for unmapped labels: keep tv_show root path clear and filter by query.
            state.currentPath = "";
            state.pathStack = [];
            state.query = q;
          }
        } else if (category === "movie" || category === "animation") {
          const cfg = getVirtualConfig(category);
          if (!q) {
            state.currentPath = cfg.rootPath;
            state.pathStack = [cfg.rootPath];
            state.query = "";
            setVirtualBucket(category, cfg.defaultBucket);
          } else if (cfg.categories.includes(q)) {
            state.currentPath = cfg.rootPath;
            state.pathStack = [cfg.rootPath];
            state.query = "";
            setVirtualBucket(category, q);
          } else {
            state.query = q;
            state.currentPath = "";
            state.pathStack = [];
          }
        } else {
          state.query = q;
          state.currentPath = '';
          state.pathStack = [];
        }
        
        state.offset = 0;
        state.library = [];
        
        loadLibrary(true);
        
        closeCategorySubMenu();
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

  dlog(`[GDS-API] Calling (${method}): ${url}`);
  console.log(`[GDS-FULL-URL] (${method}) ${finalUrl}`);
  if (endpoint.includes("series_domestic")) {
    console.log(`[SERIES_DOMESTIC_URL] ${finalUrl}`);
  }
  if (endpoint.includes("movie_virtual")) {
    console.log(`[MOVIE_VIRTUAL_URL] ${finalUrl}`);
  }
  if (endpoint.includes("animation_virtual")) {
    console.log(`[ANIMATION_VIRTUAL_URL] ${finalUrl}`);
  }
  if (endpoint.includes("animation_preview")) {
    console.log(`[ANIMATION_PREVIEW_URL] ${finalUrl}`);
  }

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
      signal: options.signal,
    };

    // 만약 tauriPlugin이 있다면 그것을 먼저 시도
    if (tauriPlugin && tauriPlugin.fetch) {
      try {
        dlog(`[GDS-API] Trying Tauri Plugin (${method})...`);
        const resp = await tauriPlugin.fetch(finalUrl, fetchOptions);
        const data = await resp.json();
        dlog(`[GDS-API] Tauri Plugin Success:`, data);
        return data;
      } catch (perr) {
        dwarn(
          "[GDS-API] Tauri Plugin HTTP failed:",
          perr.message || perr,
        );
      }
    }

    dlog(`[GDS-API] Falling back to Browser Fetch (${method})...`);
    const response = await fetch(finalUrl, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    dlog(`[GDS-API] Success (${method}):`, endpoint);
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
  syncCategoryBodyClasses();
  const grid = ui.grid;
  const heroSection = ui.heroSection;
  if (!grid) return;
  const freshRequestId = !isAppend ? ++state.freshRequestSeq : state.freshRequestSeq;
  const isStaleFreshRequest = () => !isAppend && freshRequestId !== state.freshRequestSeq;

  if (!isAppend) showLoader();

  // [Pagination] Reset or Check
  if (!isAppend) {
    if (state.isFreshLoading) {
      console.warn("[LOAD] Concurrent fresh load detected; aborting previous request and continuing.");
      if (state.freshAbortController) {
        try { state.freshAbortController.abort(); } catch (_) {}
      }
    }
    state.isFreshLoading = true;
    state.offset = 0;
    state.hasMore = true;
    state.isLoadingMore = false;
    // Keep previous library visible during fetch to reduce flash/flicker.
    state.seenPaths.clear(); // Reset deduplication set
    state.isFirstFreshLoadDone = false;
    state.appendStallCount = 0;
    state.terminalProbeDone = false;
    state.lastAppendRequestAt = 0;
    state.scrollLoadArmed = false;
    state.autoFillTriggered = false;
    state.episodeMetaReqSeq += 1; // invalidate pending episode-meta updates
    if (state.freshAbortController) {
      try { state.freshAbortController.abort(); } catch (_) {}
    }
    state.freshAbortController = new AbortController();
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
    // Show skeletons only on first paint or explicit force-refresh.
    // For normal category/folder transitions, keep previous cards until fresh payload arrives.
    const shouldShowSkeleton =
      forceRefresh || !state.isFirstFreshLoadDone || state.library.length === 0 || grid.children.length === 0;
    if (shouldShowSkeleton) {
    grid.innerHTML = Array(6)
      .fill('<div class="card skeleton"></div>')
      .join("");
      if (heroSection) heroSection.style.display = "none";
    }
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
      sort_order: state.sortOrder,
      source_id: String(state.sourceId ?? 0),
    };
    const requestSignal = !isAppend ? state.freshAbortController?.signal : undefined;

      dlog(`[LOAD] Fetching: isAppend=${isAppend}, offset=${actualOffset}, category=${state.category}`);

    // FETCH LOGIC
    let currentList = [];
    let serverBatchSize = 0;

    // [OTT HUB] Logic Refinement: Hub Mode vs Folder Mode
    const HUB_ROOT_PATHS = ["VIDEO/국내TV", "VIDEO/국내TV/드라마", "VIDEO/국내TV/예능", "VIDEO/해외TV", "VIDEO/영화"];
    const isTopHubPath = HUB_ROOT_PATHS.includes(state.currentPath);
    const pathDepth = String(state.currentPath || "").split("/").filter(Boolean).length;
    // Keep TV/Series in strict folder mode to preserve expected hierarchy.
    // Use hub(flatten) only for non-tv_show curated paths.
    const isHubRoot =
      !!state.currentPath &&
      state.category !== "tv_show" &&
      isTopHubPath &&
      pathDepth >= 3 &&
      !isIndexBucketFolder(state.currentPath);
    
    const virtualCfg = isVirtualRoot(state.category, state.currentPath)
      ? getVirtualConfig(state.category)
      : null;

    if (virtualCfg) {
      if (!isAppend) renderSubCategoryChips([]);
      const selected = getVirtualBucket(state.category);
      const params = new URLSearchParams({
        bucket: selected,
        limit: String(state.limit),
        offset: String(actualOffset),
        sort_by: state.sortBy,
        sort_order: state.sortOrder,
        source_id: String(state.sourceId ?? 0),
      });
      let __base = (state.serverUrl || "").trim();
      if (!/^https?:\/\//i.test(__base)) __base = `http://${__base}`;
      __base = __base.replace(/\/$/, "");
      console.log(`[${virtualCfg.debugTag}] ${__base}/gds_dviewer/normal/${virtualCfg.endpoint}?${params.toString()}&apikey=${state.apiKey}`);
      const responses = [await gdsFetch(`${virtualCfg.endpoint}?${params.toString()}`, { signal: requestSignal })];
      if (isStaleFreshRequest()) return;

      const allRaw = responses
        .filter((r) => r && r.ret === "success")
        .flatMap((r) => r.data || r.items || r.list || []);
      serverBatchSize = allRaw.length;
      data = {
        ret: "success",
        list: allRaw,
        count: allRaw.length,
        has_more: false,
      };
      currentList = allRaw;
    } else if (state.currentPath && isHubRoot) {
      // [MODE: HUB] Flattened discovery view
      console.log(`[OTT-HUB] Entering Hub Mode for: ${state.currentPath}`);
      if (!isAppend) renderSubCategoryChips([]);
      
      const params = new URLSearchParams({ 
        query: "",
        path: state.currentPath,
        recursive: "true",
        is_dir: "true",
        limit: "100",          // [FIX] No longer need 1000
        ...commonParams 
      });
      
      data = await gdsFetch(`search?${params.toString()}`, { signal: requestSignal });
      if (isStaleFreshRequest()) return;
      if (data.ret === "success") {
        const rawList = data.data || data.list || data.items || [];
        serverBatchSize = rawList.length;
        
        // [SEASON FILTER] Hide subfolders like "Season 1" from the main hub
        const seasonRegex = /Season|시즌|S\d+/i;
        currentList = rawList.filter(item => {
          // Rule 1: Must be a directory
          if (!item.is_dir) return false;
          // Rule 2: Exclude bucket/index folders regardless of metadata.
          if (isIndexBucketFolder(item.path || item.name)) return false;
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
      
      data = await gdsFetch(`list?${params.toString()}`, { signal: requestSignal });
      if (isStaleFreshRequest()) return;
      if (data.ret === "success") {
        currentList = data.data || data.items || data.list || [];
        serverBatchSize = currentList.length;

        // TV series UX: if a folder only exposes 가나다/0Z index buckets, switch to
        // recursive aggregate list so users see title cards instead of explorer buckets.
        if (state.category === "tv_show" && isBucketOnlyDirectoryList(currentList)) {
          console.log(`[TV-COMPOSITE] Bucket-only list detected. Switching to aggregated mode: ${state.currentPath}`);
          const aggParams = new URLSearchParams({
            query: "",
            path: state.currentPath,
            recursive: "true",
            is_dir: "true",
            ...commonParams,
          });
          const aggData = await gdsFetch(`search?${aggParams.toString()}`, { signal: requestSignal });
          if (isStaleFreshRequest()) return;
          if (aggData.ret === "success") {
            const aggRaw = aggData.data || aggData.items || aggData.list || [];
            serverBatchSize = aggRaw.length;
            const seasonRegex = /Season|시즌|S\d+/i;
            currentList = aggRaw.filter((item) => {
              if (!item?.is_dir) return false;
              if (isIndexBucketFolder(item.path || item.name)) return false;
              if (seasonRegex.test(item.name || "")) return false;
              return true;
            });
          }
        }

        console.log(`[OTT-HUB] Folder items: ${currentList.length}`);
      }
    } else if (isFolderCategory && isAtRoot && !state.query) {
      // Category browsing (folders) → search API with is_dir=true
      const params = new URLSearchParams({
        query: "",
        is_dir: "true",
        recursive: "true",
        ...commonParams
      });
      // [FIXED] FlashPlex is VIDEO-only app
      params.append("category", state.category || "tv_show,movie,animation");
      data = await gdsFetch(`search?${params.toString()}`, { signal: requestSignal });
      if (isStaleFreshRequest()) return;

      const rawList = data.list || data.data || [];
      serverBatchSize = rawList.length;
      
      const seasonRegex = /Season|시즌|S\d+/i;
      const excludedRoots = ['READING', 'DATA', 'MUSIC', '책', '만화', 'YES24 북클럽'];
      
      currentList = rawList.filter(i => {
          const nameUpper = (i.name || "").toUpperCase();
          if (excludedRoots.includes(nameUpper)) return false;
          if (seasonRegex.test(i.name)) return false; // Hide seasons in hub
          return i.is_dir;
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
      data = await gdsFetch(`search?${params.toString()}`, { signal: requestSignal });
      if (isStaleFreshRequest()) return;
      if (data.ret === "success") {
        currentList = data.list || data.data || [];
        serverBatchSize = currentList.length;
      }
    }

    if (data && data.ret === "success") {
      // [META-DEBUG] Quick visibility check: does server actually return meta fields?
      if (!isAppend && state.currentPath && DEBUG_LOG) {
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
        dlog("[META-DEBUG] path:", state.currentPath);
        if (parentPath) {
          dlog("[META-DEBUG] parentPath:", parentPath);
          dlog("[META-DEBUG] parentMeta(cache):", {
            title: parentMeta?.title || parentMeta?.meta_title || parentMeta?.name || "",
            has_meta_poster: !!parentMeta?.meta_poster,
            has_poster: !!parentMeta?.poster,
            meta_summary_len: (parentMeta?.meta_summary || "").length,
          });
        } else {
          dlog("[META-DEBUG] parentPath: <none>");
        }
        dlog("[META-DEBUG] probe:", metaProbe);
      }

      state.isLoadingMore = false;
      let finalItems = currentList;

      // Pagination check should use server batch size before client-side filtering/dedup.
      const effectiveBatchSize = Number.isFinite(serverBatchSize) && serverBatchSize >= 0
        ? serverBatchSize
        : currentList.length;
      const totalHint = Number(data?.count ?? data?.total ?? data?.total_count);
      const hasMoreHint = typeof data?.has_more === "boolean" ? data.has_more : null;
      // Many GDS endpoints behave as page-window offsets (0,100,200...),
      // so advance by requested limit rather than returned batch length.
      const nextOffset = actualOffset + state.limit;

      if (hasMoreHint !== null) {
        // Most reliable when server provides explicit paging flag.
        state.hasMore = hasMoreHint;
      } else {
        // API `count` is inconsistent across endpoints (sometimes page-size, sometimes total).
        // Keep paging on fixed windows until an empty page is returned.
        state.hasMore = effectiveBatchSize > 0;
      }
      if (!state.hasMore && effectiveBatchSize > 0 && !state.terminalProbeDone) {
        state.hasMore = true;
        state.terminalProbeDone = true;
        dlog("[PAGING] Terminal probe enabled (one extra page check).");
      }
      state.offset = nextOffset;
      dlog(
        `[PAGING] offset=${actualOffset} batch=${effectiveBatchSize} next=${state.offset} total=${Number.isFinite(totalHint) ? totalHint : "n/a"} hasMore=${state.hasMore}`,
      );

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
            dlog(`[DEDUP] Grouping/Skipping duplicate: ${key} (Name: ${i.name})`);
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

      // Domestic root cleanup: hide utility folders such as "업로드".
      if (state.category === "tv_show" && state.currentPath === "VIDEO/국내TV") {
        displayItems = displayItems.filter((i) => {
          const n = String(i?.name || "").trim().toLowerCase();
          return n !== "업로드" && n !== "upload";
        });
      }

      // TV list ordering: prioritize "currently airing" groups first.
      if (state.category === "tv_show") {
        displayItems = [...displayItems].sort((a, b) => {
          const pa = tvShowPriorityScore(a);
          const pb = tvShowPriorityScore(b);
          if (pa !== pb) return pa - pb;

          // Keep directories first for navigability.
          if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;

          // Then prefer recent updates.
          const ta = parseMtimeToEpoch(a.mtime);
          const tb = parseMtimeToEpoch(b.mtime);
          if (ta !== tb) return tb - ta;

          // Stable fallback by name.
          return String(a.name || "").localeCompare(String(b.name || ""), "ko");
        });
      }

      if (state.category === 'movie' && !state.currentPath) {
        if (!isAppend) {
          const indexFolders = displayItems.filter(i => i.is_dir && i.name.length === 1);
          renderSubCategoryChips(indexFolders);
        }
        displayItems = displayItems.filter(i => !(i.is_dir && i.name.length === 1));
      } else if (state.category === 'tv_show' && !state.currentPath) {
        if (!isAppend) {
           renderSubCategoryChips(['드라마', '예능', '다큐멘터리', '시사', '애니', '뉴스']);
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

      const isRootLibrary = state.currentView === "library" && !state.currentPath;
      const shouldShowMoviePreviewRail = isRootLibrary && state.category === "movie";
      setMoviePreviewRailVisible(shouldShowMoviePreviewRail);
      if (shouldShowMoviePreviewRail && !isAppend) {
        loadMoviePreviewRail(false).catch(() => {});
      }
      const shouldShowAnimationRail = isRootLibrary && state.category === "animation";
      setAnimationRailVisible(shouldShowAnimationRail);
      if (shouldShowAnimationRail && !isAppend) {
        loadAnimationRail(false).catch(() => {});
      }
      const shouldShowDramaRail = isRootLibrary && state.category === "tv_show";
      setDramaRailVisible(shouldShowDramaRail);
      if (shouldShowDramaRail && !isAppend) {
        loadDramaRail(false).catch(() => {});
      }

      if (!isAppend) renderFolderContextPanel(displayItems);
      renderGrid(grid, displayItems, isFolderCategory, isAppend);

      // Folder view: enrich episode cards from show.yaml metadata (progressive, no full rerender).
      if (!isAppend && state.currentPath) {
        const reqSeq = ++state.episodeMetaReqSeq;
        const targetPath = state.currentPath;
        enrichEpisodeMetaForCurrentFolder(targetPath, state.sourceId, reqSeq).catch((e) => {
          dlog("[EP_META] enrich skipped:", e?.message || e);
        });
      }

      // [FIX] Ensure scroll is at top after rendering first page
      if (!isAppend && state.currentView === "library") {
        const container = document.querySelector(".content-container");
        if (container) container.scrollTop = 0;
      }

      // If first batch doesn't fill viewport, trigger one append automatically.
      if (!isAppend && state.hasMore && state.isFirstFreshLoadDone) {
        const container = document.querySelector(".content-container");
        if (container && !state.autoFillTriggered && container.scrollHeight <= container.clientHeight + 120) {
          dlog(`[SCROLL:auto-fill] Loading more items... offset=${state.offset}`);
          setTimeout(() => maybeLoadMore("auto-fill"), 120);
        }
      }

      if (isAppend) {
        const appendedCount = displayItems.length;
        if (appendedCount === 0 && state.hasMore) {
          state.appendStallCount += 1;
          if (state.appendStallCount <= 2) {
            dlog(
              `[PAGING:stall] Empty append batch after filtering/dedup. retry=${state.appendStallCount} offset=${state.offset}`,
            );
            // Avoid immediate retry storms; user scroll/sentinel will trigger next fetch.
            state.lastAppendRequestAt = Date.now();
          } else {
            dwarn("[PAGING:stall] Reached retry cap; stopping auto-append retries.");
            state.hasMore = false;
          }
        } else {
          state.appendStallCount = 0;
        }

      }
    } else {
      throw new Error(data ? data.ret : "Fetch failed");
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      console.log("[LOAD] Request aborted (superseded by newer request).");
      return;
    }
    console.error("[LOAD] Fetch Error:", err);
    ui.statusDot.className = "status-dot error";
    renderFolderContextPanel([]);
  } finally {
    if (isStaleFreshRequest()) return;
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
    resetAllVirtualBuckets();
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
      if (!state.currentPath) resetAllVirtualBuckets();
      loadLibrary();
    };
    chipContainer.appendChild(backChip);
  }
  if (isVirtualRoot(state.category, state.currentPath)) {
    const cfg = getVirtualConfig(state.category);
    cfg.categories.forEach((label) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      if (getVirtualBucket(state.category) === label) chip.classList.add("active");
      chip.innerText = label;
      chip.onclick = () => {
        if (getVirtualBucket(state.category) === label) return;
        setVirtualBucket(state.category, label);
        state.offset = 0;
        state.library = [];
        state.seenPaths = new Set();
        loadLibrary(true);
      };
      chipContainer.appendChild(chip);
    });
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
        chip.tabIndex = 0;
        chip.setAttribute("role", "button");
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
          chip.tabIndex = 0;
          chip.setAttribute("role", "button");
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
      breadcrumb.tabIndex = 0;
      breadcrumb.setAttribute("role", "button");
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

  if (!state.currentPath || isIndexBucketFolder(state.currentPath)) {
    state.folderContextPrimaryItem = null;
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
  state.folderContextPrimaryItem = firstMedia && !firstMedia.is_dir ? firstMedia : null;
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
      ? `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${toUrlSafeBase64(mediaPath)}&source_id=${normalizeSourceId(firstMedia?.source_id)}&w=960&apikey=${state.apiKey}`
      : `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`
  );
  const summary = (
    currentMeta?.meta_summary || currentMeta?.summary || currentMeta?.desc ||
    parentMeta?.meta_summary || parentMeta?.summary || parentMeta?.desc ||
    firstMedia?.meta_summary || firstMedia?.summary || firstMedia?.desc || ""
  ).trim();
  const countLabel = episodeCount > 0 ? `${episodeCount} Episodes` : `${seasonCount} Seasons`;
  const mediaName = String(firstMedia?.name || firstMedia?.title || firstMedia?.path || "").toLowerCase();
  const qualityMatch =
    mediaName.match(/\b(2160p|1080p|720p|480p)\b/i) ||
    mediaName.match(/\b(4k|uhd)\b/i) ||
    mediaName.match(/\b(x265|hevc|x264|h\.?264|h\.?265)\b/i);
  const qualityText = qualityMatch ? qualityMatch[1].toUpperCase().replace("H.264", "H264").replace("H.265", "H265") : "";
  const genreListRaw = []
    .concat(currentMeta?.album_info?.genre || [])
    .concat(parentMeta?.album_info?.genre || [])
    .concat(firstMedia?.album_info?.genre || []);
  const genreList = Array.from(new Set(
    genreListRaw
      .map((g) => String(g || "").trim())
      .filter(Boolean)
  )).slice(0, 4);
  const parseMetaJson = (v) => {
    if (!v) return {};
    if (typeof v === "object") return v;
    try { return JSON.parse(String(v)); } catch (_) { return {}; }
  };
  const currentMetaJson = parseMetaJson(currentMeta?.meta_json);
  const parentMetaJson = parseMetaJson(parentMeta?.meta_json);
  const mediaMetaJson = parseMetaJson(firstMedia?.meta_json);
  const actorRaw = (currentMetaJson?.actor || parentMetaJson?.actor || mediaMetaJson?.actor || []);
  const actorList = Array.isArray(actorRaw)
    ? actorRaw.map((a) => (typeof a === "string" ? a : (a?.name || a?.name_ko || a?.name_en || ""))).filter(Boolean)
    : String(actorRaw || "").split(",").map((a) => a.trim()).filter(Boolean);
  const castPreview = actorList.slice(0, 4).join(" · ");

  panel.innerHTML = `
    <div class="folder-context-art" style="background-image:url('${backdrop}')"></div>
    <div class="folder-context-body">
      <div class="folder-context-top">SERIES CONTEXT</div>
      <h2 class="folder-context-title">${resolvedSeriesTitle}</h2>
      <div class="folder-context-meta">
        <span class="folder-context-chip season">${seasonLabel}</span>
        <span class="folder-context-chip">${countLabel}</span>
        ${(currentMeta?.year || parentMeta?.year) ? `<span class="folder-context-chip">${currentMeta?.year || parentMeta?.year}</span>` : ""}
        ${qualityText ? `<span class="folder-context-chip accent">영상 ${qualityText}</span>` : ""}
        ${genreList.length ? `<span class="folder-context-chip">${genreList.join(" · ")}</span>` : ""}
      </div>
      ${castPreview ? `<div class="folder-context-cast"><span class="folder-context-cast-label">출연</span><span class="folder-context-cast-value">${castPreview}</span></div>` : ""}
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
  const container = document.querySelector(".content-container");
  if (!container || container.dataset.infiniteBound === "1") return;
  let scrollTicking = false;

  const checkAndLoadMore = (scrollTop, scrollHeight, clientHeight, source) => {
    // Arm infinite loading after any real scroll event on the container.
    state.scrollLoadArmed = true;
    if (scrollHeight - scrollTop <= clientHeight + 300) {
      maybeLoadMore(source);
    }
  };

  container.dataset.infiniteBound = "1";
  // Arm on common user interactions even when scrollTop 변화가 작을 때를 대비.
  container.addEventListener("wheel", () => { state.scrollLoadArmed = true; }, { passive: true });
  container.addEventListener("touchmove", () => { state.scrollLoadArmed = true; }, { passive: true });
  container.addEventListener("keydown", () => { state.scrollLoadArmed = true; });
  container.addEventListener(
    "scroll",
    () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        checkAndLoadMore(scrollTop, scrollHeight, clientHeight, "container");
        scrollTicking = false;
      });
    },
    { passive: true }
  );
}

function isAnimationContextPath() {
  return /(^|\/)(애니메이션|animation)(\/|$)/i.test(String(state.currentPath || ""));
}

function ensureEpisodeDrawer() {
  let overlay = document.getElementById("episode-drawer-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "episode-drawer-overlay";
  overlay.className = "episode-drawer-overlay hidden";
  overlay.innerHTML = `
    <div class="episode-drawer-backdrop" data-role="close"></div>
    <aside class="episode-drawer-panel" role="dialog" aria-modal="true" aria-label="회차 정보">
      <div class="episode-drawer-header">
        <div class="episode-drawer-title-wrap">
          <div class="episode-drawer-kicker">EPISODES</div>
          <h3 id="episode-drawer-title" class="episode-drawer-title">회차 보기</h3>
        </div>
        <button type="button" id="episode-drawer-close" class="episode-drawer-close" tabindex="0" aria-label="닫기">✕</button>
      </div>
      <div id="episode-drawer-list" class="episode-drawer-list"></div>
    </aside>
  `;
  document.body.appendChild(overlay);

  const closeTargets = overlay.querySelectorAll('[data-role="close"], #episode-drawer-close');
  closeTargets.forEach((el) => el.addEventListener('click', () => closeEpisodeDrawer()));
  return overlay;
}

function closeEpisodeDrawer() {
  const overlay = document.getElementById("episode-drawer-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return false;
  overlay.classList.add("hidden");
  document.body.classList.remove("episode-drawer-open");
  state.episodeDrawerOpen = false;
  return true;
}

function openEpisodeDrawer(rawItems = [], contextTitle = "회차 보기") {
  const overlay = ensureEpisodeDrawer();
  const listEl = overlay.querySelector('#episode-drawer-list');
  const titleEl = overlay.querySelector('#episode-drawer-title');
  if (titleEl) titleEl.textContent = contextTitle || "회차 보기";

  const items = (Array.isArray(rawItems) ? rawItems : [])
    .filter((i) => i && i.path)
    .slice()
    .sort((a, b) => {
      if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;
      const an = String(a.name || a.title || "").toLowerCase();
      const bn = String(b.name || b.title || "").toLowerCase();
      return an.localeCompare(bn, 'ko');
    });

  if (!listEl) return;
  if (!items.length) {
    listEl.innerHTML = '<div class="episode-drawer-empty">표시할 회차 정보가 없습니다.</div>';
  } else {
    listEl.innerHTML = items.map((item, idx) => {
      const title = cleanMediaTitle(item.meta_title || item.title || item.name || `Item ${idx + 1}`);
      const ep = extractEpisodeLabel(item);
      const sub = item.is_dir
        ? '폴더'
        : (ep || String(item.ext || '').toUpperCase() || 'VIDEO');
      const icon = item.is_dir ? '📁' : '▶';
      return `
        <button type="button" class="episode-drawer-item" data-index="${idx}" tabindex="0">
          <span class="episode-drawer-item-icon">${icon}</span>
          <span class="episode-drawer-item-text">
            <span class="episode-drawer-item-title">${title}</span>
            <span class="episode-drawer-item-sub">${sub}</span>
          </span>
        </button>
      `;
    }).join('');

    const btns = listEl.querySelectorAll('.episode-drawer-item');
    btns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-index'));
        const item = items[idx];
        if (!item) return;
        closeEpisodeDrawer();
        if (item.is_dir) {
          state.currentPath = item.path;
          state.pathStack.push(item.path);
          loadLibrary(item.path);
          updateBreadcrumbChips();
        } else {
          playVideo(item);
        }
      });
    });
  }

  overlay.classList.remove('hidden');
  document.body.classList.add('episode-drawer-open');
  state.episodeDrawerOpen = true;
  const firstBtn = overlay.querySelector('.episode-drawer-item, #episode-drawer-close');
  if (firstBtn) setTimeout(() => firstBtn.focus(), 0);
}

function renderGrid(container, items, isFolderCategory = false, isAppend = false) {
  if (!isAppend) {
    container.innerHTML = "";
  }
  const removeEmptyState = () => {
    const emptyEl = container.querySelector(".grid-empty-state");
    if (emptyEl) emptyEl.remove();
  };
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

  const currentPathText = String(state.currentPath || "");
  const movieLikePath = /(^|\/)(영화|movie)(\/|$)/i.test(currentPathText);
  const animationLikePath = isAnimationContextPath();
  const animationPathHint = /(^|\/)(애니메이션|animation|anime)(\/|$)/i.test(currentPathText);
  const hasEpisodeLikeStructure = Array.isArray(items)
    && items.some((i) => i && !i.is_dir)
    && items.some((i) => i && i.is_dir);
  const useSinglePlayButtonMode =
    !isAppend &&
    (state.category === "movie" || movieLikePath) &&
    !!state.currentPath &&
    !!state.folderContextPrimaryItem;
  const useEpisodeButtonMode =
    !isAppend &&
    (
      state.category === "animation" ||
      animationLikePath ||
      animationPathHint ||
      (hasEpisodeLikeStructure && !movieLikePath)
    ) &&
    !!state.currentPath;

  const useFolderActionPanelMode = useSinglePlayButtonMode || useEpisodeButtonMode;
  const preserveFolderActionMode =
    isAppend &&
    (
      container.classList.contains("folder-play-only") ||
      document.querySelector(".content-container")?.classList.contains("folder-play-only") ||
      document.getElementById("folder-context-panel")?.classList.contains("has-play-cta")
    );
  const effectiveFolderActionMode = useFolderActionPanelMode || preserveFolderActionMode;
  container.classList.toggle("folder-play-only", effectiveFolderActionMode);
  const contentContainer = document.querySelector(".content-container");
  if (contentContainer) contentContainer.classList.toggle("folder-play-only", effectiveFolderActionMode);

  // Keep folder-context CTA in sync for folder action panel mode.
  const folderContextPanel = document.getElementById("folder-context-panel");
  const folderContextBody = folderContextPanel ? folderContextPanel.querySelector(".folder-context-body") : null;
  if (folderContextPanel) folderContextPanel.classList.toggle("has-play-cta", effectiveFolderActionMode);
  if (!isAppend && folderContextBody) {
    const prevActions = folderContextBody.querySelector(".folder-context-actions");
    if (prevActions) prevActions.remove();
  }

  if (useSinglePlayButtonMode || useEpisodeButtonMode) {
    const target = state.folderContextPrimaryItem || (items || []).find((i) => i && !i.is_dir) || null;
    const title = cleanMediaTitle(target?.meta_title || target?.title || target?.name || "영상");
    container.innerHTML = "";
    const canPlay = !!target;
    const isAnimationActions = useEpisodeButtonMode;

    const actionsHtml = `
      <button type="button" class="folder-play-single-btn folder-context-play-btn" id="folder-play-single-btn" ${canPlay ? '' : 'disabled'}>
        <span class="folder-play-single-icon">▶</span>
        <span class="folder-play-single-label">영상보기</span>
        <span class="folder-play-single-title">${title}</span>
      </button>
      ${isAnimationActions ? `
        <button type="button" class="folder-play-single-btn folder-episode-list-btn" id="folder-episode-list-btn">
          <span class="folder-play-single-icon">☰</span>
          <span class="folder-play-single-label">회차보기</span>
          <span class="folder-play-single-title">시즌/에피소드 목록</span>
        </button>` : ''}
    `;

    if (folderContextBody) {
      const actions = document.createElement("div");
      actions.className = "folder-context-actions";
      actions.innerHTML = actionsHtml;
      folderContextBody.appendChild(actions);
    } else {
      container.innerHTML = `
        <div class="folder-play-single-wrap" style="grid-column: 1 / -1;">
          ${actionsHtml}
        </div>
      `;
    }

    const btn = document.getElementById("folder-play-single-btn");
    if (btn && canPlay) {
      btn.addEventListener("click", () => playVideo(target));
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          playVideo(target);
        }
      });
    }

    const listBtn = document.getElementById("folder-episode-list-btn");
    if (listBtn) {
      listBtn.addEventListener("click", () => {
        const panelTitle = cleanMediaTitle(state.currentPath?.split('/').pop() || '회차 보기');
        openEpisodeDrawer(items || [], panelTitle);
      });
      listBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const panelTitle = cleanMediaTitle(state.currentPath?.split('/').pop() || '회차 보기');
          openEpisodeDrawer(items || [], panelTitle);
        }
      });
    }
    return;
  }

  if ((!items || items.length === 0) && !isAppend) {
    removeEmptyState();
    container.innerHTML +=
      '<div class="grid-empty-state" style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-secondary)">No items found.</div>';
    return;
  }

  if (!items) return; // Nothing to append
  removeEmptyState();

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
  const fragment = document.createDocumentFragment();
  const adaptiveThumbWidth = getAdaptiveThumbnailWidth(container);
  items.forEach((item, index) => {
    // [NEW] Robust Deduplication check in the grid itself
    // Key MUST match the logic in loadLibrary deduplication
    const isCatRoot = !state.currentPath;
    const itemKey = getDedupKey(item, isCatRoot);

    if (isAppend && existingKeys.has(itemKey)) {
        dwarn("[GRID] skipping duplicate item:", itemKey);
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
        meta_json: item.meta_json || null,
        genre: item.genre || [],
        source_id: Number(normalizeSourceId(item.source_id)),
      });
    }
    const baseCardClass = `card atv-card ${isFolder ? "is-folder" : "is-file"}`;
    card.className = isAppend ? baseCardClass : `${baseCardClass} card-loading`;

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
          poster = `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&w=${adaptiveThumbWidth}&apikey=${state.apiKey}`;
        } else if (item.category === "audio") {
          const bpath = toUrlSafeBase64(item.path || "");
          poster = `${state.serverUrl}/gds_dviewer/normal/album_art?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
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
    const hay = `${normalizePathForCompare(item.path || "")} ${String(item.name || "").toLowerCase()} ${String(item.status || "").toLowerCase()}`;
    const isOnAir =
      hay.includes("방송중") ||
      hay.includes("방영중") ||
      hay.includes("on air") ||
      hay.includes("airing");
    const onAirBadgeHtml = isOnAir ? `<span class="card-status-badge on-air">방송중</span>` : "";

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
          <div class="card-topline">${onAirBadgeHtml}</div>
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
          <div class="card-topline">${onAirBadgeHtml}</div>
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
    fragment.appendChild(card);
    newCards.push(card);
  });
  if (newCards.length > 0) container.appendChild(fragment);

  if (window.lucide) lucide.createIcons();

  // [BATCH REVEAL + PLACEHOLDER] Keep cards visible first, then reveal viewport images together.
  if (newCards.length > 0) {
    if (!isAppend) {
      requestAnimationFrame(() => {
        const contentContainer = document.querySelector(".content-container");
        const rootRect = contentContainer
          ? contentContainer.getBoundingClientRect()
          : { top: 0, bottom: window.innerHeight || 900 };
        const viewportBuffer = 80;

        const cardsWithImages = newCards
          .map((card) => ({ card, img: card.querySelector("img.card-poster") }))
          .filter(({ img }) => !!img);
        const cardsWithoutImage = newCards.filter((card) => !card.querySelector("img.card-poster"));

        // Non-image cards should not stay in loading state.
        cardsWithoutImage.forEach((card) => card.classList.remove("card-loading"));

        const batchTargets = [];
        const deferredTargets = [];
        cardsWithImages.forEach(({ card, img }) => {
          const r = card.getBoundingClientRect();
          const isInViewportBand =
            r.bottom >= rootRect.top - viewportBuffer &&
            r.top <= rootRect.bottom + viewportBuffer;
          if (isInViewportBand) batchTargets.push({ card, img });
          else deferredTargets.push({ card, img });
        });

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
          newCards.forEach((card) => card.classList.remove("card-loading"));
          return;
        }

        const waitForImgs = batchTargets.map(({ img }) => {
          const waitDecode = () => {
            if (typeof img.decode === "function") {
              return img.decode().catch(() => {});
            }
            return Promise.resolve();
          };

          if (img.complete) return waitDecode();

          return new Promise((resolve) => {
            const onDone = () => waitDecode().finally(resolve);
            img.addEventListener("load", onDone, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
        });

        Promise.race([
          Promise.all(waitForImgs),
          new Promise((resolve) => setTimeout(resolve, 3800)),
        ]).then(() => {
          batchTargets.forEach(({ card }) => card.classList.remove("card-loading"));
        });
      });
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

  // Keep bottom sentinel active even when scroll events are inconsistent.
  ensureInfiniteSentinel(container);
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

function getStreamUrlFromItem(item) {
  if (!item || !item.path) return "";
  let cleanPath = String(item.path).normalize("NFC");
  if (cleanPath && !cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;
  const bpath = toUrlSafeBase64(cleanPath);
  if (!bpath) return "";
  return `${state.serverUrl}/gds_dviewer/normal/stream?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
}

function getPreviewStreamUrlFromItem(item) {
  if (!item || !item.path) return "";
  let cleanPath = String(item.path).normalize("NFC");
  if (cleanPath && !cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;
  const bpath = toUrlSafeBase64(cleanPath);
  if (!bpath) return "";
  const ext = getPathExtension(cleanPath);
  const endpoint = ext === "mkv" ? "stream_preview" : "stream";
  return `${state.serverUrl}/gds_dviewer/normal/${endpoint}?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
}

async function resolvePlayablePreviewItem(item) {
  if (!item) return null;
  const ext = getPathExtension(item.path);
  if (!item.is_dir) {
    if (PREVIEW_PLAYABLE_EXTS.has(ext)) return item;
    // File itself is not web-playable (e.g. mkv). Try sibling files in its parent.
    const parentPath = getParentPath(item.path || "");
    if (!parentPath) return null;
    item = { ...item, is_dir: true, path: parentPath };
  }

  const cacheKey = `${normalizeSourceId(item.source_id)}:${String(item.path || "")}`;
  if (state.dramaPreviewCache.has(cacheKey)) {
    return state.dramaPreviewCache.get(cacheKey);
  }

  try {
    const sourceId = normalizeSourceId(item.source_id);
    const queue = [{ path: String(item.path || ""), depth: 0 }];
    const candidates = [];
    const visited = new Set();

    while (queue.length > 0 && candidates.length === 0) {
      const cur = queue.shift();
      if (!cur || !cur.path) continue;
      const norm = normalizePathForCompare(cur.path);
      if (visited.has(norm)) continue;
      visited.add(norm);

      const bpath = toUrlSafeBase64(cur.path);
      if (!bpath) continue;
      const endpoint = `explorer/list?bpath=${bpath}&source_id=${sourceId}&limit=80&apikey=${state.apiKey}`;
      const data = await gdsFetch(endpoint);
      const list = data?.list || data?.data || data?.items || [];
      list.forEach((child) => {
        if (!child || !child.path) return;
        if (child.is_dir) {
          // Some libraries only contain season/episode subfolders at first level.
          if (cur.depth < 2) queue.push({ path: String(child.path), depth: cur.depth + 1 });
          return;
        }
        const cext = getPathExtension(child.path);
        if (PREVIEW_SOURCE_EXTS.has(cext)) candidates.push(child);
      });
    }

    const candidate = candidates.sort((a, b) => {
      const epA = extractEpisodeNumber(a);
      const epB = extractEpisodeNumber(b);
      if (epA !== epB) return epB - epA; // higher episode first

      const tsA = parseMtimeToEpoch(a?.mtime);
      const tsB = parseMtimeToEpoch(b?.mtime);
      if (tsA !== tsB) return tsB - tsA; // newer first

      return String(b?.name || "").localeCompare(String(a?.name || ""));
    })[0] || null;
    state.dramaPreviewCache.set(cacheKey, candidate);
    return candidate;
  } catch (_) {
    state.dramaPreviewCache.set(cacheKey, null);
    return null;
  }
}

async function handleDramaCardPreview(card, item) {
  if (!card || !item) return;
  const stillActive = () => card.matches(":hover") || card === document.activeElement || card.contains(document.activeElement);
  console.log("[DRAMA-PREVIEW] resolving preview source:", item?.path || item?.name || "");
  const previewItem = await resolvePlayablePreviewItem(item);
  if (!previewItem) {
    console.warn("[DRAMA-PREVIEW] no playable preview item:", item?.path || item?.name || "");
    return;
  }
  console.log("[DRAMA-PREVIEW] resolved preview source:", previewItem?.path || previewItem?.name || "");
  const resolvedExt = getPathExtension(previewItem?.path || "");
  if (!PREVIEW_PLAYABLE_EXTS.has(resolvedExt) && resolvedExt !== "mkv") {
    console.warn("[DRAMA-PREVIEW] resolved source is non-web-playable ext:", resolvedExt || "<none>");
  }
  if (!stillActive()) return;
  scheduleMoviePreviewPlayback(card, previewItem, true);
}

function resolvePosterUrl(rawUrl, item, width = 640) {
  const noPoster = `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`;
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";

  // Already-proxied/ready URLs from gds_dviewer should be used as-is.
  if (raw.includes("/gds_dviewer/normal/proxy_image") || raw.includes("/gds_dviewer/normal/thumbnail")) {
    return raw;
  }

  // Relative path from same server.
  if (raw.startsWith("/")) {
    return `${state.serverUrl}${raw}`;
  }

  // Absolute external URL -> proxy through gds_dviewer image proxy.
  if (/^https?:\/\//i.test(raw)) {
    return `${state.serverUrl}/gds_dviewer/normal/proxy_image?url=${encodeURIComponent(raw)}&apikey=${state.apiKey}`;
  }

  // Fallback to thumbnail from file path when raw is not a URL.
  let thumbPath = String(item?.path || "").normalize("NFC");
  if (thumbPath && !thumbPath.startsWith("/")) thumbPath = `/${thumbPath}`;
  const bpath = toUrlSafeBase64(thumbPath);
  if (!bpath) return noPoster;
  return `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${bpath}&source_id=${normalizeSourceId(item?.source_id)}&w=${width}&apikey=${state.apiKey}`;
}

function getPosterUrlFromItem(item, width = 640) {
  const noPoster = `${state.serverUrl}/gds_dviewer/static/img/no_poster.png`;
  if (!item) return noPoster;
  const rawPoster = item.meta_poster || item.album_info?.posters || item.poster || item.meta_thumb || item.thumb || "";
  const resolved = resolvePosterUrl(rawPoster, item, width);
  if (resolved) return resolved;
  let thumbPath = String(item.path || "").normalize("NFC");
  if (thumbPath && !thumbPath.startsWith("/")) thumbPath = `/${thumbPath}`;
  const bpath = toUrlSafeBase64(thumbPath);
  if (!bpath) return noPoster;
  return `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&w=${width}&apikey=${state.apiKey}`;
}

function buildFolderThumbUrl(pathValue, sourceId, width = 640) {
  const clean = String(pathValue || "").replace(/^\/+/, "").normalize("NFC");
  if (!clean) return "";
  const bpath = toUrlSafeBase64(clean.startsWith("/") ? clean : `/${clean}`);
  if (!bpath) return "";
  return `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${bpath}&source_id=${normalizeSourceId(sourceId)}&w=${width}&apikey=${state.apiKey}`;
}

function ensureLeadingSlash(pathValue) {
  const p = String(pathValue || "").normalize("NFC");
  if (!p) return "";
  return p.startsWith("/") ? p : `/${p}`;
}

function getNativeSourcePathForTrickplay() {
  const path = state?.nativeSource?.path || "";
  return ensureLeadingSlash(path);
}

function getNativeSourceIdForTrickplay() {
  return normalizeSourceId(state?.nativeSource?.source_id);
}

function getSeekBasePositionForRemote() {
  const now = Date.now();
  const recent = (now - Number(state.nativeSeekPreviewTs || 0)) < 1600;
  if (recent && Number.isFinite(state.nativeSeekPreviewPos)) {
    return Number(state.nativeSeekPreviewPos);
  }
  return Number.isFinite(state.nativePos) ? Number(state.nativePos) : 0;
}

function getTrickplayCacheKey(pathValue, sourceId) {
  return `${sourceId}::${pathValue}`;
}

function getOrCreateTrickplayOverlay() {
  let overlay = document.getElementById("trickplay-overlay");
  if (overlay) return overlay;
  const host = ui.playerOverlay || document.body;
  if (!host) return null;
  overlay = document.createElement("div");
  overlay.id = "trickplay-overlay";
  overlay.className = "trickplay-overlay hidden";
  overlay.innerHTML = `
    <div class="trickplay-rail-wrap">
      <div class="trickplay-rail"></div>
      <div class="trickplay-time">00:00</div>
    </div>
  `;
  host.appendChild(overlay);
  return overlay;
}

function hideTrickplayOverlay() {
  const overlay = document.getElementById("trickplay-overlay");
  if (!overlay) return;
  if (trickplayHideTimer) {
    clearTimeout(trickplayHideTimer);
    trickplayHideTimer = null;
  }
  overlay.classList.add("hidden");
}

function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function ensureTrickplayManifestForNative() {
  const pathValue = getNativeSourcePathForTrickplay();
  const sourceId = getNativeSourceIdForTrickplay();
  if (!pathValue) return null;
  const key = getTrickplayCacheKey(pathValue, sourceId);
  const cached = trickplayManifestCache.get(key);
  if (cached && cached.ret === "success") return cached;

  const bpath = toUrlSafeBase64(pathValue);
  if (!bpath) return null;
  const endpoint =
    `trickplay_manifest?bpath=${encodeURIComponent(bpath)}` +
    `&source_id=${sourceId}` +
    `&interval=${TRICKPLAY_DEFAULT_INTERVAL}` +
    `&w=${TRICKPLAY_DEFAULT_W}&h=${TRICKPLAY_DEFAULT_H}`;

  try {
    const data = await gdsFetch(endpoint);
    if (data && data.ret === "success") {
      trickplayManifestCache.set(key, data);
      return data;
    }
  } catch (e) {
    console.warn("[TRICKPLAY] manifest fetch failed:", e?.message || e);
  }
  return null;
}

async function showTrickplayAt(seconds) {
  if (!state.isNativeActive) return;
  if (!(ui.playerOverlay && ui.playerOverlay.classList.contains("active"))) return;

  const manifest = await ensureTrickplayManifestForNative();
  if (!manifest || !Array.isArray(manifest.items) || manifest.items.length === 0) return;

  const interval = Number(manifest.interval || TRICKPLAY_DEFAULT_INTERVAL) || TRICKPLAY_DEFAULT_INTERVAL;
  const idx = Math.max(0, Math.min(manifest.items.length - 1, Math.floor((Number(seconds) || 0) / interval)));
  const item = manifest.items[idx];
  if (!item || !item.url) return;

  const overlay = getOrCreateTrickplayOverlay();
  if (!overlay) return;
  const rail = overlay.querySelector(".trickplay-rail");
  const timeEl = overlay.querySelector(".trickplay-time");
  if (!rail) return;

  const radius = 4; // center + 양옆 4장씩 (좌우 오버플로우 완화)
  const frag = document.createDocumentFragment();
  for (let i = idx - radius; i <= idx + radius; i += 1) {
    const bounded = Math.max(0, Math.min(manifest.items.length - 1, i));
    const it = manifest.items[bounded];
    if (!it) continue;
    let u = String(it.url || "");
    if (u.startsWith("/")) u = `${state.serverUrl}${u}`;
    const cell = document.createElement("div");
    cell.className = "trickplay-item" + (i === idx ? " is-active" : "");
    cell.innerHTML = `
      <img class="trickplay-thumb" alt="thumb-${bounded}" src="${u}">
      <div class="trickplay-item-time">${formatClock(it.t ?? 0)}</div>
    `;
    frag.appendChild(cell);
  }
  rail.innerHTML = "";
  rail.appendChild(frag);
  rail.style.transform = "translateX(0)";
  console.log("[TRICKPLAY] show", { seconds, idx });
  if (timeEl) timeEl.textContent = formatClock(item.t ?? seconds);
  overlay.classList.remove("hidden");

  // While user is in pending seek mode (Left/Right steps), keep trickplay visible.
  if (trickplayHideTimer) {
    clearTimeout(trickplayHideTimer);
    trickplayHideTimer = null;
  }
  if (Number(state.nativeSeekPendingSteps || 0) === 0) {
    trickplayHideTimer = setTimeout(() => hideTrickplayOverlay(), TRICKPLAY_HIDE_MS);
  }
}

function choosePosterUrl({ item, width = 640, metaPoster = "", folderPath = "", parentFolderPath = "" } = {}) {
  if (metaPoster) {
    const resolved = resolvePosterUrl(metaPoster, item, width);
    if (resolved) return resolved;
  }
  const folderThumb = buildFolderThumbUrl(folderPath, item?.source_id, width);
  if (folderThumb) return folderThumb;
  const parentThumb = buildFolderThumbUrl(parentFolderPath, item?.source_id, width);
  if (parentThumb) return parentThumb;
  return getPosterUrlFromItem(item, width);
}

function getPreviewVolume() {
  const raw = Number(state.volume);
  if (!Number.isFinite(raw)) return PREVIEW_DEFAULT_VOLUME;
  const clamped = Math.max(0, Math.min(100, raw));
  return Math.max(0.05, clamped / 100);
}

function stopMoviePreviewPlayback() {
  if (moviePreviewHoverTimer) {
    clearTimeout(moviePreviewHoverTimer);
    moviePreviewHoverTimer = null;
  }
  if (!activeMoviePreviewCard) return;
  const video = activeMoviePreviewCard.querySelector(".movie-preview-video");
  if (video) {
    try {
      video.pause();
      video.currentTime = 0;
      // Abort in-flight network and clear decoder state to avoid chained stalls.
      video.removeAttribute("src");
      video.load();
    } catch (_) {}
  }
  activeMoviePreviewCard.classList.remove("previewing");
  activeMoviePreviewCard = null;
}

function scheduleMoviePreviewPlayback(card, item, immediate = false) {
  if (!card || !item) return;
  if (card.dataset.previewEnabled !== "1") return;
  // Prevent repeated hover/focus from restarting the same already-running preview.
  if (activeMoviePreviewCard === card && card.classList.contains("previewing")) return;
  stopMoviePreviewPlayback();
  const run = () => {
    const video = card.querySelector(".movie-preview-video");
    if (!video) return;
    // Desktop webview: muted preview is usually allowed without explicit unlock.
    if (!state.previewAutoplayUnlocked && isDesktop) {
      state.previewAutoplayUnlocked = true;
    }
    if (!state.previewAutoplayUnlocked) {
      pendingPreviewRequest = { card, item };
      console.log("[PREVIEW] blocked: autoplay not unlocked");
      return;
    }
    const streamUrl = getPreviewStreamUrlFromItem(item);
    if (!streamUrl) {
      console.warn("[PREVIEW] blocked: empty stream url", item?.path || item?.name || "");
      return;
    }
    console.log("[PREVIEW] attempt:", item?.path || item?.name || "", streamUrl);

    card.classList.add("previewing");
    video.muted = false;
    video.defaultMuted = false;
    video.volume = getPreviewVolume();
    // Rebind source each attempt to avoid stuck states in WebView media pipeline.
    try {
      video.pause();
    } catch (_) {}
    video.src = streamUrl;
    video.load();
    if (video.readyState >= 1) {
      seekPreviewVideoRandom(video);
    } else {
      video.addEventListener("loadedmetadata", () => {
        seekPreviewVideoRandom(video);
      }, { once: true });
    }
    let settled = false;
    let retryCount = 0;
    let startWatchdog = null;
    const clearStartWatchdog = () => {
      if (startWatchdog) {
        clearTimeout(startWatchdog);
        startWatchdog = null;
      }
    };
    const isStillRelevant = () => activeMoviePreviewCard === card || !activeMoviePreviewCard;
    const recoverFromStall = (reason) => {
      if (!isStillRelevant()) return;
      if (retryCount >= PREVIEW_STALL_RETRY_LIMIT) return;
      retryCount += 1;
      console.warn(`[PREVIEW] recovery retry #${retryCount} (${reason}):`, item?.path || item?.name || "");
      try {
        const bufferedEnd = video.buffered && video.buffered.length > 0
          ? Number(video.buffered.end(video.buffered.length - 1) || 0)
          : 0;
        const current = Number(video.currentTime || 0);
        const hasBufferedHeadroom = bufferedEnd > (current + 1.2);

        // If buffer still has enough data, avoid hard reload and just nudge playback.
        if (hasBufferedHeadroom) {
          const p0 = video.play();
          if (p0 && typeof p0.catch === "function") p0.catch(() => {});
          return;
        }

        const resumeAt = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime - 0.8) : 0;

        // First retry: soft resume only (no network reconnect).
        if (retryCount === 1) {
          try { video.pause(); } catch (_) {}
          const p1 = video.play();
          if (p1 && typeof p1.catch === "function") p1.catch(() => {});
          return;
        }

        // Second retry: hard reload with resume point.
        video.pause();
        video.load();
        if (resumeAt > 0.2) {
          const onMeta = () => {
            try { video.currentTime = resumeAt; } catch (_) {}
          };
          video.addEventListener("loadedmetadata", onMeta, { once: true });
        }
        const p2 = video.play();
        if (p2 && typeof p2.catch === "function") p2.catch(() => {});
      } catch (_) {}
    };
    video.addEventListener("loadedmetadata", () => {
      console.log("[PREVIEW] event loadedmetadata:", {
        path: item?.path || item?.name || "",
        duration: Number(video.duration || 0),
      });
    }, { once: true });
    video.addEventListener("canplay", () => {
      settled = true;
      clearStartWatchdog();
      console.log("[PREVIEW] event canplay:", item?.path || item?.name || "");
    }, { once: true });
    video.addEventListener("waiting", () => {
      console.log("[PREVIEW] event waiting:", item?.path || item?.name || "");
    }, { once: true });
    video.addEventListener("stalled", () => {
      console.warn("[PREVIEW] event stalled:", item?.path || item?.name || "");
      recoverFromStall("stalled");
    }, { once: true });
    video.addEventListener("playing", () => {
      settled = true;
      clearStartWatchdog();
      console.log("[PREVIEW] event playing:", item?.path || item?.name || "");
    }, { once: true });
    video.addEventListener("error", () => {
      settled = true;
      clearStartWatchdog();
      const mediaErr = video.error;
      console.warn("[PREVIEW] event error:", {
        code: mediaErr?.code || 0,
        message: mediaErr?.message || "",
        path: item?.path || item?.name || "",
      });
    }, { once: true });
    startWatchdog = setTimeout(() => {
      if (settled) return;
      const bufferedEnd = video.buffered && video.buffered.length > 0
        ? Number(video.buffered.end(video.buffered.length - 1) || 0)
        : 0;
      console.warn("[PREVIEW] no-start timeout:", {
        path: item?.path || item?.name || "",
        readyState: video.readyState,
        networkState: video.networkState,
        currentSrc: video.currentSrc || "",
        bufferedEnd,
      });
      recoverFromStall("no-start-timeout");
    }, PREVIEW_START_TIMEOUT_MS);

    let playResult;
    try {
      playResult = video.play();
    } catch (err) {
      card.classList.remove("previewing");
      console.warn("[PREVIEW] video play threw:", err?.message || err);
      return;
    }

    if (playResult && typeof playResult.then === "function") {
      playResult.then(() => {
        clearStartWatchdog();
        console.log("[PREVIEW] play started:", item?.path || item?.name || "");
      }).catch((err) => {
        clearStartWatchdog();
        card.classList.remove("previewing");
        const name = String(err?.name || "").toLowerCase();
        const msg = String(err?.message || err || "").toLowerCase();
        // Frequent/expected failures: avoid noisy warnings.
        if (name.includes("abort") || msg.includes("aborted")) return;
        if (name.includes("notallowed") || msg.includes("not allowed")) {
          // Keep previous stable behavior: wait for next explicit user interaction.
          pendingPreviewRequest = { card, item };
          return;
        }
        if (name.includes("notsupported") || msg.includes("not supported")) {
          card.dataset.previewEnabled = "0";
          return;
        }
        console.warn("[PREVIEW] video play failed:", err?.message || err);
      });
    } else {
      // Some WebViews do not return a Promise from play().
      console.log("[PREVIEW] play() returned non-promise:", item?.path || item?.name || "");
    }
    activeMoviePreviewCard = card;
  };

  if (immediate) {
    run();
  } else {
    moviePreviewHoverTimer = setTimeout(run, MOVIE_PREVIEW_DELAY_MS);
  }
}

function setMoviePreviewRailVisible(active) {
  if (!ui.moviePreviewRail) return;
  ui.moviePreviewRail.classList.toggle("hidden", !active);
  if (!active) {
    stopMoviePreviewAutoSlide();
    stopMoviePreviewPlayback();
    if (moviePreviewScrollTimer) {
      clearTimeout(moviePreviewScrollTimer);
      moviePreviewScrollTimer = null;
    }
    pendingPreviewRequest = null;
    if (ui.moviePreviewTrack) ui.moviePreviewTrack.innerHTML = "";
    state.moviePreviewOffset = 0;
    state.moviePreviewHasMore = true;
    state.moviePreviewSeenKeys.clear();
    state.moviePreviewItemMap.clear();
  } else {
    startMoviePreviewAutoSlide();
  }
}

function setAnimationRailVisible(active) {
  if (!ui.animationRail) return;
  ui.animationRail.classList.toggle("hidden", !active);
  if (!active) {
    stopAnimationRailAutoSlide();
    if (ui.animationTrack) ui.animationTrack.innerHTML = "";
    if (ui.animationPreviewMeta) ui.animationPreviewMeta.classList.add("hidden");
    state.animationRailOffset = 0;
    state.animationRailHasMore = true;
    state.animationRailSeenKeys.clear();
    state.animationPreviewItemMap.clear();
  } else {
    startAnimationRailAutoSlide();
  }
}

function setDramaRailVisible(active) {
  if (!ui.dramaRail) return;
  ui.dramaRail.classList.toggle("hidden", !active);
  if (!active) {
    stopDramaRailAutoSlide();
    if (ui.dramaTrack) ui.dramaTrack.innerHTML = "";
    state.dramaRailOffset = 0;
    state.dramaRailHasMore = true;
    state.dramaRailSeenKeys.clear();
    state.dramaPreviewItemMap.clear();
  } else {
    startDramaRailAutoSlide();
  }
}

function stopMoviePreviewAutoSlide() {
  if (moviePreviewAutoSlideTimer) {
    clearInterval(moviePreviewAutoSlideTimer);
    moviePreviewAutoSlideTimer = null;
  }
}

function startMoviePreviewAutoSlide() {
  if (!PREVIEW_AUTO_SLIDE_ENABLED) return;
  const track = ui.moviePreviewTrack;
  if (!track) return;
  stopMoviePreviewAutoSlide();
  moviePreviewAutoSlideTimer = setInterval(() => {
    if (!ui.moviePreviewRail || ui.moviePreviewRail.classList.contains("hidden")) return;
    if (moviePreviewUserInteracting) return;
    const cards = track.querySelectorAll(".movie-preview-card");
    if (!cards || cards.length < 2) return;

    const firstCard = cards[0];
    const step = Math.max(180, Math.round(firstCard.getBoundingClientRect().width + 12));
    const nearEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - step - 16;
    if (nearEnd) {
      track.scrollTo({ left: 0, behavior: "smooth" });
    } else {
      track.scrollBy({ left: step, behavior: "smooth" });
    }
  }, 4200);
}

function stopAnimationRailAutoSlide() {
  if (animationRailAutoSlideTimer) {
    clearInterval(animationRailAutoSlideTimer);
    animationRailAutoSlideTimer = null;
  }
}

function startAnimationRailAutoSlide() {
  if (!PREVIEW_AUTO_SLIDE_ENABLED) return;
  const track = ui.animationTrack;
  if (!track) return;
  stopAnimationRailAutoSlide();
  animationRailAutoSlideTimer = setInterval(() => {
    if (!ui.animationRail || ui.animationRail.classList.contains("hidden")) return;
    const cards = track.querySelectorAll(".movie-preview-card");
    if (!cards || cards.length < 2) return;
    const firstCard = cards[0];
    const step = Math.max(180, Math.round(firstCard.getBoundingClientRect().width + 12));
    const nearEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - step - 16;
    if (nearEnd) track.scrollTo({ left: 0, behavior: "smooth" });
    else track.scrollBy({ left: step, behavior: "smooth" });
  }, 4600);
}

function stopDramaRailAutoSlide() {
  if (dramaRailAutoSlideTimer) {
    clearInterval(dramaRailAutoSlideTimer);
    dramaRailAutoSlideTimer = null;
  }
}

function startDramaRailAutoSlide() {
  if (!PREVIEW_AUTO_SLIDE_ENABLED) return;
  const track = ui.dramaTrack;
  if (!track) return;
  stopDramaRailAutoSlide();
  dramaRailAutoSlideTimer = setInterval(() => {
    if (!ui.dramaRail || ui.dramaRail.classList.contains("hidden")) return;
    const active = document.activeElement;
    const focusInside = !!(active && track.contains(active));
    if (dramaRailUserInteracting || track.matches(":hover") || focusInside) return;
    const cards = track.querySelectorAll(".movie-preview-card");
    if (!cards || cards.length < 2) return;
    const firstCard = cards[0];
    const step = Math.max(180, Math.round(firstCard.getBoundingClientRect().width + 12));
    const nearEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - step - 16;
    if (nearEnd) track.scrollTo({ left: 0, behavior: "smooth" });
    else track.scrollBy({ left: step, behavior: "smooth" });
  }, 5000);
}

function getLeftmostVisiblePreviewCard() {
  const track = ui.moviePreviewTrack;
  return getLeftmostVisibleCardInTrack(track);
}

function getLeftmostVisibleCardInTrack(track) {
  if (!track) return null;
  const cards = Array.from(track.querySelectorAll(".movie-preview-card"));
  if (cards.length === 0) return null;
  const tr = track.getBoundingClientRect();
  const visible = cards.filter((card) => {
    const r = card.getBoundingClientRect();
    return r.right > tr.left + 6 && r.left < tr.right - 6;
  });
  if (visible.length === 0) return cards[0] || null;
  visible.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return visible[0] || null;
}

function isLeftmostCardInTrack(card, track) {
  if (!card || !track) return false;
  const leftmost = getLeftmostVisibleCardInTrack(track);
  markLeftAnchorCard(track, leftmost);
  return !!leftmost && leftmost === card;
}

function markLeftAnchorCard(trackEl, cardEl, options = {}) {
  const force = !!options.force;
  if (!trackEl) return;
  const fixed = trackEl.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
  if (fixed && !force) {
    const cards = trackEl.querySelectorAll(".movie-preview-card");
    cards.forEach((c) => c.classList.remove("is-left-anchor"));
    fixed.classList.add("is-left-anchor");
    if (trackEl === ui.animationTrack) updateAnimationPreviewMetaFromCard(fixed);
    return;
  }
  const cards = trackEl.querySelectorAll(".movie-preview-card");
  cards.forEach((c) => {
    c.classList.remove("is-left-anchor");
    if (force) delete c.dataset.anchorFixed;
  });
  if (cardEl) {
    cardEl.classList.add("is-left-anchor");
    cardEl.dataset.anchorFixed = "1";
    if (trackEl === ui.animationTrack) updateAnimationPreviewMetaFromCard(cardEl);
  } else if (trackEl === ui.animationTrack) {
    updateAnimationPreviewMetaFromCard(null);
  }
}

function swapPreviewCards(trackEl, a, b) {
  if (!trackEl || !a || !b || a === b) return;
  const children = Array.from(trackEl.children);
  const ai = children.indexOf(a);
  const bi = children.indexOf(b);
  if (ai < 0 || bi < 0) return;

  if (ai < bi) {
    trackEl.insertBefore(b, a);
    trackEl.insertBefore(a, children[bi]);
  } else {
    trackEl.insertBefore(a, b);
    trackEl.insertBefore(b, children[ai]);
  }
}

function canRunMoviePreviewNow() {
  const track = ui.moviePreviewTrack;
  if (!track) return false;
  const active = document.activeElement;
  const focusInside = !!(active && track.contains(active));
  return moviePreviewUserInteracting || focusInside;
}

function canRunPreviewNowInTrack(track) {
  if (!track) return false;
  const active = document.activeElement;
  const focusInside = !!(active && track.contains(active));
  if (track === ui.moviePreviewTrack) return moviePreviewUserInteracting || focusInside;
  if (track === ui.animationTrack) return focusInside;
  if (track === ui.dramaTrack) return dramaRailUserInteracting || focusInside;
  return focusInside;
}

function getPreviewItemByTrackCard(track, card) {
  if (!track || !card) return null;
  const key = card.dataset.previewKey || "";
  if (!key) return null;
  if (track === ui.moviePreviewTrack) return state.moviePreviewItemMap.get(key) || null;
  if (track === ui.animationTrack) return state.animationPreviewItemMap.get(key) || null;
  if (track === ui.dramaTrack) return state.dramaPreviewItemMap.get(key) || null;
  return null;
}

function getPreviewMapForTrack(track) {
  if (track === ui.moviePreviewTrack) return state.moviePreviewItemMap;
  if (track === ui.animationTrack) return state.animationPreviewItemMap;
  if (track === ui.dramaTrack) return state.dramaPreviewItemMap;
  return null;
}

function updateAnimationPreviewMetaFromCard(card) {
  const box = ui.animationPreviewMeta;
  if (!box) return;
  if (!card) {
    box.classList.add("hidden");
    return;
  }

  const item = getPreviewItemByTrackCard(ui.animationTrack, card);
  if (!item) {
    box.classList.add("hidden");
    return;
  }

  const meta = resolveAnimeSeriesMeta(item);
  let seriesPathForMeta = String(meta.seriesPath || "").split("::")[0].replace(/^\/+/, "").normalize("NFC");
  const seriesLeafName = splitPathSegments(seriesPathForMeta).slice(-1)[0] || "";
  if (isSeasonLikeName(seriesLeafName)) {
    seriesPathForMeta = String(getParentPath(seriesPathForMeta) || "").replace(/^\/+/, "").normalize("NFC");
  }
  const seriesMeta = findNearestFolderMeta(seriesPathForMeta);
  const parentPathForMeta = seriesPathForMeta ? getParentPath(seriesPathForMeta) : "";
  const parentMeta = findNearestFolderMeta(parentPathForMeta);

  const title = cleanMediaTitle(
    seriesMeta?.meta_title ||
    seriesMeta?.title ||
    seriesMeta?.album_info?.title ||
    parentMeta?.meta_title ||
    parentMeta?.title ||
    parentMeta?.album_info?.title ||
    meta.seriesTitle ||
    item?.meta_title ||
    item?.title ||
    item?.name ||
    "Untitled",
  );
  const episode = extractEpisodeLabel(item) || "LATEST";
  const year = seriesMeta?.year || parentMeta?.year || item?.year || "";
  const subtitle = year ? `${episode} · ${year}` : episode;
  const summary = String(
    seriesMeta?.meta_summary ||
    seriesMeta?.summary ||
    seriesMeta?.desc ||
    parentMeta?.meta_summary ||
    parentMeta?.summary ||
    parentMeta?.desc ||
    item?.meta_summary ||
    item?.summary ||
    item?.desc ||
    "",
  ).trim();

  const titleEl = box.querySelector(".rail-focus-title");
  const subtitleEl = box.querySelector(".rail-focus-subtitle");
  const summaryEl = box.querySelector(".rail-focus-summary");
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle;
  if (summaryEl) summaryEl.textContent = summary || " ";
  box.classList.remove("hidden");
}

function applyPreviewCardState(card, stateObj) {
  if (!card || !stateObj) return;
  if (Array.isArray(stateObj.nodes)) {
    card.replaceChildren(...stateObj.nodes);
  } else {
    card.innerHTML = stateObj.html || "";
  }
  card.dataset.previewKey = stateObj.key;
  card.dataset.previewEnabled = stateObj.enabled;
  card.classList.remove("previewing");
}

function rotateCardContentsKeepAnchor(track, fixedCard, direction = 1) {
  if (!track || !fixedCard) return false;
  const cards = Array.from(track.querySelectorAll(".movie-preview-card"));
  if (cards.length < 2) return false;
  const fixedIdx = cards.indexOf(fixedCard);
  if (fixedIdx < 0) return false;

  const snapshot = cards.map((c) => ({
    // Keep existing DOM nodes to avoid recreating <img>/<video> on every rotation.
    nodes: Array.from(c.childNodes),
    html: c.innerHTML,
    key: c.dataset.previewKey || "",
    enabled: c.dataset.previewEnabled || "0",
  }));
  stopMoviePreviewPlayback();

  if (direction > 0) {
    const first = snapshot[fixedIdx];
    for (let i = fixedIdx; i < cards.length - 1; i += 1) {
      applyPreviewCardState(cards[i], snapshot[i + 1]);
    }
    applyPreviewCardState(cards[cards.length - 1], first);
  } else {
    const last = snapshot[cards.length - 1];
    for (let i = cards.length - 1; i > fixedIdx; i -= 1) {
      applyPreviewCardState(cards[i], snapshot[i - 1]);
    }
    applyPreviewCardState(cards[fixedIdx], last);
  }

  fixedCard.focus({ preventScroll: true });
  markLeftAnchorCard(track, fixedCard, { force: true });
  return true;
}

function triggerLeftmostPreviewForTrack(track, immediate = false) {
  if (!track) return;
  const card = getLeftmostVisibleCardInTrack(track);
  markLeftAnchorCard(track, card);
  if (!card) return;
  if (card.dataset.previewEnabled !== "1") return;
  if (!canRunPreviewNowInTrack(track)) return;

  const item = getPreviewItemByTrackCard(track, card);
  if (!item) return;

  if (track === ui.dramaTrack && !!item.is_dir) {
    handleDramaCardPreview(card, item);
    return;
  }
  scheduleMoviePreviewPlayback(card, item, immediate);
}

function triggerLeftmostMoviePreview() {
  triggerLeftmostPreviewForTrack(ui.moviePreviewTrack, false);
}

function createPreviewSkeletonCard() {
  const card = document.createElement("div");
  card.className = "movie-preview-card is-skeleton";
  card.setAttribute("aria-hidden", "true");
  card.innerHTML = `
    <div class="movie-preview-media">
      <div class="movie-preview-skeleton-block"></div>
      <div class="movie-preview-gradient"></div>
    </div>
    <div class="movie-preview-title"><span class="movie-preview-skeleton-line"></span></div>
    <div class="movie-preview-subtitle"><span class="movie-preview-skeleton-line short"></span></div>
  `;
  return card;
}

function showPreviewRailSkeleton(track, count = 8) {
  if (!track) return;
  const trackWidth =
    Number(track.clientWidth || 0) ||
    Number(track.getBoundingClientRect?.().width || 0) ||
    Math.floor((window.innerWidth || 1280) * 0.9);
  const approxCardWidth = 190; // poster + gap average in appletv skin
  const dynamicCount = Math.max(count, Math.ceil(trackWidth / approxCardWidth) + 6);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < dynamicCount; i += 1) frag.appendChild(createPreviewSkeletonCard());
  track.innerHTML = "";
  track.appendChild(frag);
}

function clearPreviewRailSkeleton(track) {
  if (!track) return;
  const skeletons = track.querySelectorAll(".movie-preview-card.is-skeleton");
  if (skeletons.length === 0) return;
  skeletons.forEach((el) => el.remove());
}

async function loadMoviePreviewRail(append = false) {
  if (!ui.moviePreviewRail || !ui.moviePreviewTrack) return;
  if (!!state.currentPath) return;
  if (state.moviePreviewLoading) return;
  if (append && !state.moviePreviewHasMore) return;

  state.moviePreviewLoading = true;
  if (!append) {
    showPreviewRailSkeleton(ui.moviePreviewTrack, 8);
    state.moviePreviewSeenKeys.clear();
    state.moviePreviewItemMap.clear();
    state.moviePreviewOffset = 0;
    state.moviePreviewHasMore = true;
  }
  try {
    const selectedBucket = state.movieVirtualCategory || "전체";
    const params = new URLSearchParams({
      bucket: selectedBucket,
      sort_by: "date",
      sort_order: "desc",
      source_id: String(state.sourceId ?? 0),
      limit: String(ANIMATION_PREVIEW_FETCH_LIMIT),
      offset: String(append ? state.moviePreviewOffset : 0),
    });

    const data = await gdsFetch(`movie_preview?${params.toString()}`);
    if (!data || data.ret !== "success") return;
    const list = data.list || data.data || [];
    const videoExtensions = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts"];
    const candidates = list.filter((item) => {
      if (!item || item.is_dir || !item.path) return false;
      const lower = String(item.path).toLowerCase();
      if (!videoExtensions.some((ext) => lower.endsWith(ext))) return false;
      const ext = getPathExtension(item.path);
      return PREVIEW_SOURCE_EXTS.has(ext);
    });

    // Folder-first mode:
    // 1) group by parent folder (one card per work)
    // 2) keep latest playable file in each folder as preview/play source
    const getBaseName = (p) => {
      const parts = String(p || "").split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
    };
    const folderMap = new Map();
    candidates.forEach((item) => {
      const folderPath = String(getParentPath(item.path) || "").replace(/^\/+/, "");
      if (!folderPath) return;
      const identity = buildMoviePreviewIdentity(item, folderPath);
      const groupKey = identity.groupKey;
      const prev = folderMap.get(groupKey);
      if (!prev) {
        folderMap.set(groupKey, { folderPath, item, identity });
        return;
      }
      const nowTs = parseMtimeToEpoch(item.mtime);
      const prevTs = parseMtimeToEpoch(prev.item?.mtime);
      if (nowTs > prevTs) folderMap.set(groupKey, { folderPath, item, identity });
    });

    const groupedMovies = Array.from(folderMap.values())
      .sort((a, b) => parseMtimeToEpoch(b.item?.mtime) - parseMtimeToEpoch(a.item?.mtime));

    const frag = document.createDocumentFragment();
    let added = 0;
    for (const { folderPath, item, identity } of groupedMovies) {
      const folderKey = `folder:${String(folderPath || "").toLowerCase()}`;
      if (state.moviePreviewSeenKeys.has(folderKey)) continue;
      state.moviePreviewSeenKeys.add(folderKey);

      let folderMeta = findNearestFolderMeta(folderPath) || null;
      if (!folderMeta || !(folderMeta.meta_title || folderMeta.title || folderMeta.meta_poster || folderMeta.poster || folderMeta.album_info?.posters)) {
        const hydrated = await hydrateFolderMetaFromParent(folderPath, item?.source_id);
        if (hydrated) folderMeta = hydrated;
      }
      const parentPathForMeta = getParentPath(folderPath);
      let parentMeta = findNearestFolderMeta(parentPathForMeta) || null;
      if (!parentMeta && parentPathForMeta) {
        parentMeta = await hydrateFolderMetaFromParent(parentPathForMeta, item?.source_id);
      }
      const displayTitle = resolveMoviePreviewTitle(identity, item, folderMeta, parentMeta);
      const yearText = String(folderMeta?.year || parentMeta?.year || item?.year || "").trim();
      const subtitle = yearText || "MOVIE";
      const previewItem = {
        ...item,
        folder_path: folderPath,
        folder_name: getBaseName(folderPath),
        meta_title: displayTitle,
        title: displayTitle,
        meta_summary: folderMeta?.meta_summary || folderMeta?.summary || folderMeta?.desc || item?.meta_summary || item?.summary || item?.desc || "",
        summary: folderMeta?.summary || folderMeta?.desc || item?.summary || item?.desc || "",
        desc: folderMeta?.desc || item?.desc || "",
        meta_poster:
          folderMeta?.meta_poster ||
          folderMeta?.poster ||
          folderMeta?.album_info?.posters ||
          parentMeta?.meta_poster ||
          parentMeta?.poster ||
          parentMeta?.album_info?.posters ||
          item?.meta_poster ||
          item?.poster ||
          "",
      };
      const poster = choosePosterUrl({
        item: previewItem,
        width: 540,
        metaPoster: previewItem?.meta_poster || "",
        folderPath: identity.isBucketFolder ? "" : folderPath,
        parentFolderPath: identity.isBucketFolder ? "" : parentPathForMeta,
      });
      const previewEnabled = true;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "movie-preview-card";
      card.setAttribute("tabindex", "0");
      card.dataset.previewEnabled = previewEnabled ? "1" : "0";
      card.dataset.previewIndex = String(ui.moviePreviewTrack.children.length + added);
      const previewKey = `${folderKey}_${state.moviePreviewOffset}_${added}`;
      card.dataset.previewKey = previewKey;
      state.moviePreviewItemMap.set(previewKey, previewItem);
      card.innerHTML = `
        <div class="movie-preview-media">
          <img class="movie-preview-poster" src="${poster}" alt="${displayTitle}" loading="lazy">
          <video class="movie-preview-video" playsinline webkit-playsinline disablepictureinpicture disableremoteplayback controlslist="nodownload noplaybackrate nofullscreen noremoteplayback" loop preload="none"></video>
          <div class="movie-preview-gradient"></div>
        </div>
        <div class="movie-preview-title">${displayTitle}</div>
        <div class="movie-preview-subtitle">${subtitle}</div>
      `;

      card.addEventListener("click", () => {
        const live = getPreviewItemByTrackCard(ui.moviePreviewTrack, card) || previewItem;
        playVideo(live);
      });
      frag.appendChild(card);
      added += 1;
    }

    if (added > 0) ui.moviePreviewTrack.appendChild(frag);
    // Keep skeleton visible until cards are actually ready, then remove skeleton only.
    if (!append) clearPreviewRailSkeleton(ui.moviePreviewTrack);
    if (ui.moviePreviewTrack.children.length > 0) {
      const leftCard = getLeftmostVisiblePreviewCard();
      markLeftAnchorCard(ui.moviePreviewTrack, leftCard);
    }
    state.moviePreviewOffset += Number(list.length || 0);
    state.moviePreviewHasMore = typeof data.has_more === "boolean" ? data.has_more : (list.length >= 20);
    if (!append && ui.moviePreviewTrack.children.length === 0) {
      setMoviePreviewRailVisible(false);
    }
  } catch (err) {
    if (!append) clearPreviewRailSkeleton(ui.moviePreviewTrack);
    console.warn("[PREVIEW] movie rail load failed:", err?.message || err);
  } finally {
    state.moviePreviewLoading = false;
  }
}

async function loadAnimationRail(append = false) {
  if (!ui.animationRail || !ui.animationTrack) return;
  if (!!state.currentPath) return;
  if (state.animationRailLoading) return;
  if (append && !state.animationRailHasMore) return;

  state.animationRailLoading = true;
  if (!append) {
    showPreviewRailSkeleton(ui.animationTrack, 8);
    state.animationRailSeenKeys.clear();
    state.animationPreviewItemMap.clear();
    state.animationRailOffset = 0;
    state.animationRailHasMore = true;
  }
  try {
    const selectedBucket = state.animationVirtualCategory || "전체";
    const params = new URLSearchParams({
      bucket: selectedBucket,
      sort_by: "date",
      sort_order: "desc",
      source_id: String(state.sourceId ?? 0),
      limit: "20",
      offset: String(append ? state.animationRailOffset : 0),
    });
    const data = await gdsFetch(`animation_preview?${params.toString()}`);
    let list = (data && data.ret === "success") ? (data.list || data.data || []) : [];

    const videoExtensions = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts"];
    const candidates = list.filter((item) => {
      if (!item || item.is_dir || !item.path) return false;
      const lower = String(item.path).toLowerCase();
      return videoExtensions.some((ext) => lower.endsWith(ext));
    });

    // Collapse episode files into one card per anime title (latest episode only).
    const seriesMap = new Map();
    candidates.forEach((item) => {
      const meta = resolveAnimeSeriesMeta(item);
      const seriesKey = normalizePathForCompare(meta.seriesPath || getParentPath(item.path || "") || item.path || item.name);
      const prev = seriesMap.get(seriesKey);
      if (!prev) {
        seriesMap.set(seriesKey, { item, meta });
        return;
      }

      const epNow = extractEpisodeNumber(item);
      const epPrev = extractEpisodeNumber(prev.item);
      if (epNow > epPrev) {
        seriesMap.set(seriesKey, { item, meta });
        return;
      }
      if (epNow === epPrev) {
        const nowTs = parseMtimeToEpoch(item.mtime);
        const prevTs = parseMtimeToEpoch(prev.item.mtime);
        if (nowTs > prevTs) seriesMap.set(seriesKey, { item, meta });
      }
    });

    const seriesList = Array.from(seriesMap.values()).sort((a, b) => {
      const ta = parseMtimeToEpoch(a.item?.mtime);
      const tb = parseMtimeToEpoch(b.item?.mtime);
      return tb - ta;
    }).slice(0, ANIMATION_PREVIEW_RENDER_LIMIT);

    const frag = document.createDocumentFragment();
    let added = 0;
    for (const { item, meta } of seriesList) {
      const dedupKey = normalizePathForCompare(meta.seriesPath || item.path || item.name);
      if (state.animationRailSeenKeys.has(dedupKey)) continue;
      state.animationRailSeenKeys.add(dedupKey);

      const rawSeriesPath = String(meta.seriesPath || "").normalize("NFC");
      let seriesPathForMeta = rawSeriesPath.split("::")[0].replace(/^\/+/, "").normalize("NFC");
      const seriesLeafName = splitPathSegments(seriesPathForMeta).slice(-1)[0] || "";
      if (isSeasonLikeName(seriesLeafName)) {
        seriesPathForMeta = String(getParentPath(seriesPathForMeta) || "").replace(/^\/+/, "").normalize("NFC");
      }
      let seriesMeta = findNearestFolderMeta(seriesPathForMeta);
      if (!seriesMeta || !(seriesMeta.meta_poster || seriesMeta.poster || seriesMeta.album_info?.posters)) {
        const hydrated = await hydrateFolderMetaFromParent(seriesPathForMeta, item?.source_id);
        if (hydrated) seriesMeta = hydrated;
      }
      const parentPathForMeta = seriesPathForMeta ? getParentPath(seriesPathForMeta) : "";
      let parentMeta = findNearestFolderMeta(parentPathForMeta);
      if (!parentMeta && parentPathForMeta) {
        parentMeta = await hydrateFolderMetaFromParent(parentPathForMeta, item?.source_id);
      }

      const title = cleanMediaTitle(
        seriesMeta?.meta_title ||
        seriesMeta?.title ||
        seriesMeta?.album_info?.title ||
        parentMeta?.meta_title ||
        parentMeta?.title ||
        parentMeta?.album_info?.title ||
        meta.seriesTitle ||
        item.meta_title ||
        item.title ||
        item.name ||
        "Untitled",
      );
      const episode = extractEpisodeLabel(item);
      const seriesPathClean = String(seriesPathForMeta || "").trim();
      const metaPoster =
        seriesMeta?.meta_poster ||
        seriesMeta?.album_info?.posters ||
        seriesMeta?.poster ||
        parentMeta?.meta_poster ||
        parentMeta?.album_info?.posters ||
        parentMeta?.poster ||
        "";
      const poster = choosePosterUrl({
        item,
        width: 540,
        metaPoster,
        folderPath: seriesPathClean,
        parentFolderPath: parentPathForMeta,
      });
      const ext = getPathExtension(item.path);
      const previewEnabled = PREVIEW_SOURCE_EXTS.has(ext);

      const card = document.createElement("button");
      card.type = "button";
      card.className = "movie-preview-card";
      card.setAttribute("tabindex", "0");
      card.dataset.previewEnabled = previewEnabled ? "1" : "0";
      const previewKey = `${dedupKey}_${state.animationRailOffset}_${added}`;
      card.dataset.previewKey = previewKey;
      state.animationPreviewItemMap.set(previewKey, item);
      card.innerHTML = `
        <div class="movie-preview-media">
          <img class="movie-preview-poster" src="${poster}" alt="${title}" loading="lazy">
          <video class="movie-preview-video" playsinline webkit-playsinline disablepictureinpicture disableremoteplayback controlslist="nodownload noplaybackrate nofullscreen noremoteplayback" loop preload="none"></video>
          <div class="movie-preview-gradient"></div>
        </div>
        <div class="movie-preview-title">${title}</div>
        <div class="movie-preview-subtitle">${episode || "LATEST"}</div>
      `;
      card.addEventListener("click", () => {
        const live = getPreviewItemByTrackCard(ui.animationTrack, card) || item;
        playVideo(live);
      });
      const posterImg = card.querySelector(".movie-preview-poster");
      if (posterImg) {
        posterImg.addEventListener("error", () => {
          const fallbackSrc = getPosterUrlFromItem(item, 540);
          if (fallbackSrc && posterImg.src !== fallbackSrc) posterImg.src = fallbackSrc;
        }, { once: true });
      }
      if (previewEnabled) {
        card.addEventListener("mouseenter", () => scheduleMoviePreviewPlayback(card, item));
        card.addEventListener("mouseleave", () => stopMoviePreviewPlayback());
        card.addEventListener("focus", () => {
          const isLeftmost = isLeftmostCardInTrack(card, ui.animationTrack);
          console.log("[ANIME-PREVIEW] card focus:", {
            title,
            path: item?.path || "",
            isLeftmost,
          });
          if (!isLeftmost) return;
          scheduleMoviePreviewPlayback(card, item);
        });
        card.addEventListener("blur", () => stopMoviePreviewPlayback());
      }
      frag.appendChild(card);
      added += 1;
    }

    if (added > 0) ui.animationTrack.appendChild(frag);
    // Keep skeleton visible until cards are actually ready, then remove skeleton only.
    if (!append) clearPreviewRailSkeleton(ui.animationTrack);
    if (ui.animationTrack.children.length > 0) {
      const cards = Array.from(ui.animationTrack.querySelectorAll(".movie-preview-card"));
      markLeftAnchorCard(ui.animationTrack, cards[0] || null);
    }
    state.animationRailOffset += Number(list.length || 0);
    state.animationRailHasMore = typeof data?.has_more === "boolean"
      ? data.has_more
      : (list.length >= ANIMATION_PREVIEW_FETCH_LIMIT);
    if (!append && ui.animationTrack.children.length === 0) {
      setAnimationRailVisible(false);
    }
  } catch (err) {
    if (!append) clearPreviewRailSkeleton(ui.animationTrack);
    console.warn("[ANIME-RAIL] load failed:", err?.message || err);
  } finally {
    state.animationRailLoading = false;
  }
}

async function loadDramaRail(append = false) {
  if (!ui.dramaRail || !ui.dramaTrack) return;
  if (!!state.currentPath) return;
  if (state.dramaRailLoading) return;
  if (append && !state.dramaRailHasMore) return;

  state.dramaRailLoading = true;
  if (!append) {
    showPreviewRailSkeleton(ui.dramaTrack, 8);
    state.dramaRailSeenKeys.clear();
    state.dramaPreviewItemMap.clear();
    state.dramaRailOffset = 0;
    state.dramaRailHasMore = true;
  }
  try {
    const params = new URLSearchParams({
      bucket: "드라마",
      limit: "20",
      offset: String(append ? state.dramaRailOffset : 0),
      sort_by: state.sortBy || "date",
      sort_order: state.sortOrder || "desc",
      source_id: String(state.sourceId ?? 0),
    });
    const data = await gdsFetch(`series_domestic?${params.toString()}`);
    if (!data || data.ret !== "success") return;
    const list = data.list || data.data || data.items || [];

    const frag = document.createDocumentFragment();
    let added = 0;
    list.forEach((item) => {
      const key = normalizePathForCompare(item.path || item.name || "");
      if (state.dramaRailSeenKeys.has(key)) return;
      state.dramaRailSeenKeys.add(key);

      const title = cleanMediaTitle(item.meta_title || item.title || item.name || "Untitled");
      const subtitle = item.is_dir ? "SERIES" : (extractEpisodeLabel(item) || "EP -");
      const poster = choosePosterUrl({
        item,
        width: 540,
        metaPoster: item.meta_poster || item.poster || item.album_info?.posters || "",
        folderPath: String(item.path || "").replace(/^\/+/, ""),
        parentFolderPath: getParentPath(String(item.path || "").replace(/^\/+/, "")),
      });

      const card = document.createElement("button");
      card.type = "button";
      card.className = "movie-preview-card";
      card.setAttribute("tabindex", "0");
      const ext = getPathExtension(item.path);
      const previewEnabled = !!item.is_dir || PREVIEW_SOURCE_EXTS.has(ext);
      card.dataset.previewEnabled = previewEnabled ? "1" : "0";
      const previewKey = `${key}_${state.dramaRailOffset}_${added}`;
      card.dataset.previewKey = previewKey;
      state.dramaPreviewItemMap.set(previewKey, item);
      card.innerHTML = `
        <div class="movie-preview-media">
          <img class="movie-preview-poster" src="${poster}" alt="${title}" loading="lazy">
          <video class="movie-preview-video" playsinline webkit-playsinline disablepictureinpicture disableremoteplayback controlslist="nodownload noplaybackrate nofullscreen noremoteplayback" loop preload="none"></video>
          <div class="movie-preview-gradient"></div>
        </div>
        <div class="movie-preview-title">${title}</div>
        <div class="movie-preview-subtitle">${subtitle}</div>
      `;
      card.addEventListener("click", () => {
        const live = getPreviewItemByTrackCard(ui.dramaTrack, card) || item;
        if (live.is_dir) {
          state.currentPath = live.path || "";
          state.pathStack = state.currentPath ? [state.currentPath] : [];
          state.query = "";
          loadLibrary(true);
        } else {
          playVideo(live);
        }
      });
      card.addEventListener("mouseenter", () => {
        dramaRailUserInteracting = true;
        stopDramaRailAutoSlide();
        const isLeftmost = isLeftmostCardInTrack(card, ui.dramaTrack);
        if (!previewEnabled || !isLeftmost) return;
        console.log("[DRAMA-PREVIEW] trigger mouseenter:", {
          title,
          path: item?.path || "",
          previewEnabled,
          isLeftmost,
        });
        const live = getPreviewItemByTrackCard(ui.dramaTrack, card) || item;
        handleDramaCardPreview(card, live);
      });
      card.addEventListener("mouseleave", () => stopMoviePreviewPlayback());
      card.addEventListener("focus", () => {
        const isLeftmost = isLeftmostCardInTrack(card, ui.dramaTrack);
        if (!previewEnabled || !isLeftmost) return;
        console.log("[DRAMA-PREVIEW] trigger focus:", {
          title,
          path: item?.path || "",
          previewEnabled,
          isLeftmost,
        });
        const live = getPreviewItemByTrackCard(ui.dramaTrack, card) || item;
        handleDramaCardPreview(card, live);
      });
      card.addEventListener("blur", () => stopMoviePreviewPlayback());
      frag.appendChild(card);
      added += 1;
    });

    if (added > 0) ui.dramaTrack.appendChild(frag);
    // Keep skeleton visible until cards are actually ready, then remove skeleton only.
    if (!append) clearPreviewRailSkeleton(ui.dramaTrack);
    state.dramaRailOffset += Number(list.length || 0);
    state.dramaRailHasMore = list.length >= 20;
    if (!append && ui.dramaTrack.children.length === 0) {
      setDramaRailVisible(false);
    }
  } catch (err) {
    if (!append) clearPreviewRailSkeleton(ui.dramaTrack);
    console.warn("[DRAMA-RAIL] load failed:", err?.message || err);
  } finally {
    state.dramaRailLoading = false;
  }
}

function setupMoviePreviewRail() {
  if (!ui.moviePreviewTrack || ui.moviePreviewTrack.dataset.bound === "1") return;
  ui.moviePreviewTrack.dataset.bound = "1";
  ui.moviePreviewTrack.addEventListener("mouseenter", () => {
    unlockPreviewAutoplay();
    moviePreviewUserInteracting = true;
    stopMoviePreviewAutoSlide();
    triggerLeftmostMoviePreview();
  });
  ui.moviePreviewTrack.addEventListener("mouseleave", () => {
    moviePreviewUserInteracting = false;
    stopMoviePreviewPlayback();
    startMoviePreviewAutoSlide();
  });
  ui.moviePreviewTrack.addEventListener("focusin", () => {
    const fixed = ui.moviePreviewTrack.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
    const active = document.activeElement;
    if (fixed && (!active || !ui.moviePreviewTrack.contains(active))) {
      fixed.focus({ preventScroll: true });
    }
    moviePreviewUserInteracting = true;
    stopMoviePreviewAutoSlide();
    triggerLeftmostMoviePreview();
  });
  ui.moviePreviewTrack.addEventListener("focusout", () => {
    const active = document.activeElement;
    moviePreviewUserInteracting = !!(active && ui.moviePreviewTrack && ui.moviePreviewTrack.contains(active));
    if (!moviePreviewUserInteracting) stopMoviePreviewPlayback();
    startMoviePreviewAutoSlide();
  });
  ui.moviePreviewTrack.addEventListener("scroll", () => {
    if (!ui.moviePreviewTrack) return;
    const remain = ui.moviePreviewTrack.scrollWidth - (ui.moviePreviewTrack.scrollLeft + ui.moviePreviewTrack.clientWidth);
    if (remain < 260) loadMoviePreviewRail(true);
    if (moviePreviewScrollTimer) clearTimeout(moviePreviewScrollTimer);
    moviePreviewScrollTimer = setTimeout(() => {
      triggerLeftmostMoviePreview();
    }, 130);
  }, { passive: true });
}

function setupAnimationRail() {
  if (!ui.animationTrack || ui.animationTrack.dataset.bound === "1") return;
  ui.animationTrack.dataset.bound = "1";
  ui.animationTrack.addEventListener("mouseenter", () => {
    unlockPreviewAutoplay();
    stopAnimationRailAutoSlide();
  });
  ui.animationTrack.addEventListener("mouseleave", () => {
    startAnimationRailAutoSlide();
  });
  ui.animationTrack.addEventListener("focusin", () => {
    const fixed = ui.animationTrack.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
    const active = document.activeElement;
    if (fixed && (!active || !ui.animationTrack.contains(active))) {
      fixed.focus({ preventScroll: true });
    }
    const activeTitle = document.activeElement?.querySelector?.(".movie-preview-title")?.textContent || "";
    console.log("[ANIME-PREVIEW] track focusin:", activeTitle);
    stopAnimationRailAutoSlide();
    triggerLeftmostPreviewForTrack(ui.animationTrack, true);
  });
  ui.animationTrack.addEventListener("focusout", () => {
    startAnimationRailAutoSlide();
  });
  ui.animationTrack.addEventListener("scroll", () => {
    if (!ui.animationTrack) return;
    const cards = Array.from(ui.animationTrack.querySelectorAll(".movie-preview-card"));
    const tr = ui.animationTrack.getBoundingClientRect();
    const leftmost = cards
      .filter((card) => {
        const r = card.getBoundingClientRect();
        return r.right > tr.left + 6 && r.left < tr.right - 6;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || cards[0] || null;
    markLeftAnchorCard(ui.animationTrack, leftmost);
    triggerLeftmostPreviewForTrack(ui.animationTrack, true);
    const remain = ui.animationTrack.scrollWidth - (ui.animationTrack.scrollLeft + ui.animationTrack.clientWidth);
    if (remain < 260) loadAnimationRail(true);
  }, { passive: true });
}

function setupDramaRail() {
  if (!ui.dramaTrack || ui.dramaTrack.dataset.bound === "1") return;
  ui.dramaTrack.dataset.bound = "1";
  ui.dramaTrack.addEventListener("mouseenter", () => {
    dramaRailUserInteracting = true;
    unlockPreviewAutoplay();
    stopDramaRailAutoSlide();
  });
  ui.dramaTrack.addEventListener("mouseleave", () => {
    dramaRailUserInteracting = false;
    startDramaRailAutoSlide();
  });
  ui.dramaTrack.addEventListener("focusin", () => {
    const fixed = ui.dramaTrack.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
    const active = document.activeElement;
    if (fixed && (!active || !ui.dramaTrack.contains(active))) {
      fixed.focus({ preventScroll: true });
    }
    dramaRailUserInteracting = true;
    const activeTitle = document.activeElement?.querySelector?.(".movie-preview-title")?.textContent || "";
    console.log("[DRAMA-PREVIEW] track focusin:", activeTitle);
    unlockPreviewAutoplay();
    stopDramaRailAutoSlide();
    triggerLeftmostPreviewForTrack(ui.dramaTrack, true);
  });
  ui.dramaTrack.addEventListener("focusout", () => {
    const active = document.activeElement;
    dramaRailUserInteracting = !!(active && ui.dramaTrack && ui.dramaTrack.contains(active));
    if (!dramaRailUserInteracting) startDramaRailAutoSlide();
  });
  ui.dramaTrack.addEventListener("scroll", () => {
    triggerLeftmostPreviewForTrack(ui.dramaTrack, true);
    const remain = ui.dramaTrack.scrollWidth - (ui.dramaTrack.scrollLeft + ui.dramaTrack.clientWidth);
    if (remain < 260) loadDramaRail(true);
  }, { passive: true });
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
      hideTrickplayOverlay();
      resetNativeSeekPending();
      state.nativeSource = null;

      if (ui.playerOverlay) ui.playerOverlay.classList.remove("active");
  closeEpisodeDrawer();

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
  // Suppress native webview video chrome/overlay (we render custom OSC).
  player.controls = false;
  player.setAttribute("playsinline", "");
  player.setAttribute("webkit-playsinline", "");
  player.setAttribute("disablepictureinpicture", "");
  player.setAttribute("disableremoteplayback", "");
  player.setAttribute("controlslist", "nodownload noplaybackrate nofullscreen noremoteplayback");
  player.removeAttribute("poster");
  player.setAttribute("poster", "");
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
    hideTrickplayOverlay();
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

function hideWebOscForAndroidExo() {
  // Android ExoPlayer path should never leave web/native-desktop OSC visible.
  if (ui.playerOverlay) ui.playerOverlay.classList.remove("active");
  if (ui.customControls) {
    ui.customControls.classList.add("hidden");
    ui.customControls.style.display = "none";
  }
  if (ui.playerHeader) ui.playerHeader.style.display = "none";
  if (ui.premiumOsc) {
    ui.premiumOsc.classList.add("hidden");
    ui.premiumOsc.style.display = "none";
  }
  document.body.classList.remove("player-active");
  document.body.classList.remove("native-player-active");
  document.documentElement.classList.remove("native-player-active");
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
  stopMoviePreviewPlayback();
  
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
    const endpoint = `explorer/list?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&limit=50&apikey=${state.apiKey}`;
    
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
  document.body.classList.add("player-active");
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

  let streamUrl = `${state.serverUrl}/gds_dviewer/normal/stream?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
  const subtitleUrl = bpath ? `${state.serverUrl}/gds_dviewer/normal/external_subtitle?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}` : null;

  const extension = (cleanPath || "").split(".").pop().toLowerCase();
  console.log("[PLAY] Extension Detected:", extension);
  console.log("[PLAY] Standardized Stream URL (path):", streamUrl);
  console.log("[PLAY] Standardized Subtitle URL (bpath):", subtitleUrl);

  // 4. [HYBRID] Native Playback Routing
  const isAudio =
    item.category === "audio" || ["flac", "mp3", "m4a"].includes(extension);

  // Android: route all non-audio video playback to native ExoPlayer for consistent UI/remote behavior.
  if (isAndroid && !isAudio) {
    console.log("[PLAYBACK] Checking Native ExoPlayer Bridge...", extension);
    if (window.PlayerBridge && window.PlayerBridge.openExoPlayer) {
      console.log("[PLAYBACK] Resolving subtitles for Native ExoPlayer:", cleanTitle);

      // Android-only: ensure web OSC/UI is fully hidden before opening native ExoPlayer.
      hideWebOscForAndroidExo();
      state.isNativeActive = false;

      resolveBestSubtitleForAndroid(item, bpath, subtitleUrl).then((resolvedSubtitleUrl) => {
        console.log("[PLAYBACK] Triggering Native ExoPlayer for:", cleanTitle, "subtitle:", resolvedSubtitleUrl);
        window.PlayerBridge.openExoPlayer(
          cleanTitle,
          streamUrl,
          resolvedSubtitleUrl,
          state.subtitleSize,
          state.subtitlePos,
        );
      }).catch(() => {
        window.PlayerBridge.openExoPlayer(
          cleanTitle,
          streamUrl,
          subtitleUrl,
          state.subtitleSize,
          state.subtitlePos,
        );
      });
      return;
    } else {
      console.warn("[PLAYBACK] PlayerBridge not available, falling back to web/native MPV path.");
    }
  }


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
      state.nativeSource = {
        title: cleanTitle,
        url: streamUrl,
        subtitleUrl,
        path: cleanPath,
        source_id: normalizeSourceId(item.source_id),
      };
      resetNativeSeekPending();

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
            const videoInfoUrl = `${state.serverUrl}/gds_dviewer/normal/get_video_info?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
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
    hideTrickplayOverlay();
    resetNativeSeekPending();
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
      `${state.serverUrl}/gds_dviewer/normal/album_art?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
    ui.audioPoster.src = albumArtUrl;
    ui.playerBg.style.backgroundImage = `url(${albumArtUrl})`;
    ui.playerBg.style.display = "block";
  } else {
    ui.videoContainer.classList.remove("audio-mode");
    ui.audioVisual.style.display = "none";
    ui.playerBg.style.display = "none";

    // Add Subtitles
    const bpath = toUrlSafeBase64(item.path || "");
    const subtitleUrl = `${state.serverUrl}/gds_dviewer/normal/external_subtitle?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&apikey=${state.apiKey}`;
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
      source_id: String(state.sourceId ?? 0),
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
        imgUrl = `${state.serverUrl}/gds_dviewer/normal/thumbnail?bpath=${bpath}&source_id=${normalizeSourceId(item.source_id)}&w=1080&apikey=${state.apiKey}`;
    }
    slide.style.background = `center center / cover no-repeat url("${imgUrl}")`;

    // Clean Title
    let displayTitle = item.meta_title || item.title || item.name;
    displayTitle = displayTitle.replace(/\.(mkv|mp4|avi|srt|ass)$/i, "")
      .replace(/[\. ](1080p|720p|2160p|4k|HEVC|H\.264|WEB-DL|DDP5\.1|Atmos|MA|BluRay|XviD|AC3|KOR|FHD|AMZN|NF|Obbe|H\.265|x265|10bit|HDR)/gi, " ")
      .trim();

    slide.innerHTML = `
      <img src="${imgUrl}" class="hero-img" alt="${displayTitle}"
           onload="this.closest('.hero-slide').style.background='center center / cover no-repeat url(${imgUrl})'"
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
  setMoviePreviewRailVisible(false);
  setAnimationRailVisible(false);
  setDramaRailVisible(false);
  if (window.lucide) window.lucide.createIcons();
}

window.handleAndroidBack = function () {
  if (closeEpisodeDrawer()) return "handled";
  if (closeCategorySubMenu()) return "handled";
  const qualityOverlay = document.getElementById("quality-menu-overlay");
  if (qualityOverlay) {
    qualityOverlay.remove();
    return "handled";
  }
  const subtitleOverlay = document.getElementById("subtitle-menu-overlay");
  if (subtitleOverlay) {
    subtitleOverlay.remove();
    return "handled";
  }
  const sortOverlay = document.getElementById("sort-menu-overlay");
  if (sortOverlay && !sortOverlay.classList.contains("hidden")) {
    sortOverlay.classList.add("hidden");
    return "handled";
  }

  // 1. If native player is active (check UI state)
  if (state.isNativeActive) {
    closePlayer();
    return "handled";
  }

  // 1.5 If web/native player overlay is visible, close player first.
  const overlayActive =
    !!(ui && ui.playerOverlay && ui.playerOverlay.classList.contains("active")) ||
    !!document.querySelector("#player-overlay.active, #premium-osc.active");
  if (overlayActive) {
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
    const categoryMenuOverlay = document.getElementById("category-menu-overlay");
    const itemOverlay = document.querySelector(".item-options-overlay.active");
    const activeOverlay = (categoryMenuOverlay && categoryMenuOverlay.classList.contains("active"))
      ? categoryMenuOverlay
      : itemOverlay;

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
      const playerOverlay = ui.playerOverlay;
      const isPlayerActive =
        playerOverlay && playerOverlay.classList.contains("active");

      // Native trickplay confirm mode:
      // Left/Right only moves pending steps, Enter commits one seek.
      if (isPlayerActive && state.isNativeActive && Number(state.nativeSeekPendingSteps || 0) !== 0) {
        const invoke =
          window.__TAURI__ && window.__TAURI__.core
            ? window.__TAURI__.core.invoke
            : window.__TAURI__
              ? window.__TAURI__.invoke
              : null;
        if (invoke) {
          const base = Number.isFinite(state.nativeSeekBasePos)
            ? Number(state.nativeSeekBasePos)
            : getSeekBasePositionForRemote();
          const durationCap = Number.isFinite(state.nativeDuration) && state.nativeDuration > 0
            ? state.nativeDuration
            : Number.POSITIVE_INFINITY;
          const targetTime = Math.min(
            Math.max(0, base + Number(state.nativeSeekPendingSteps) * 10),
            durationCap,
          );
          invoke("native_seek", { seconds: targetTime })
            .then(() => {
              state.nativePos = targetTime;
              console.log(
                `[REMOTE] MPV seek commit steps=${state.nativeSeekPendingSteps} -> ${targetTime.toFixed(2)}s`,
              );
            })
            .catch((err) => console.error("[REMOTE] MPV seek commit failed:", err))
            .finally(() => {
              resetNativeSeekPending();
              hideTrickplayOverlay();
            });
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // While player is active, first Enter should wake OSC/controls instead of clicking background cards.
      if (isPlayerActive) {
        const nativeOscHidden =
          !!(state.isNativeActive && ui.premiumOsc && ui.premiumOsc.classList.contains("hidden"));
        const webControlsHidden =
          !!(!state.isNativeActive && ui.customControls && ui.customControls.classList.contains("hidden"));

        if (nativeOscHidden || webControlsHidden) {
          document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // If menu overlay is open, trap Enter within overlay before any click-through.
      if (activeOverlay && !activeOverlay.contains(current)) {
        const first = activeOverlay.querySelector('[tabindex="0"], button, .category-option, .sort-option, [data-qprofile]');
        if (first && typeof first.focus === "function") first.focus();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (current && current !== document.body) {
        console.log("[REMOTE] Enter on:", current);
        current.click();
      }
      e.preventDefault();
      e.stopPropagation();
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
      return;
    }

    // Spatial Navigation Logic
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
      // [MPV REMOTE SEEK] While native player is active, reserve Left/Right for quick seek.
      // This must run before preview-rail navigation to avoid key conflicts.
      const playerOverlay = ui.playerOverlay;
      const isPlayerActive =
        playerOverlay && playerOverlay.classList.contains("active");
      if (isPlayerActive && state.isNativeActive && (key === "ArrowRight" || key === "ArrowLeft")) {
        const currentPos = getSeekBasePositionForRemote();
        if (!Number.isFinite(state.nativeSeekBasePos)) {
          state.nativeSeekBasePos = currentPos;
          state.nativeSeekPendingSteps = 0;
        }
        state.nativeSeekPendingSteps += (key === "ArrowRight" ? 1 : -1);
        const durationCap = Number.isFinite(state.nativeDuration) && state.nativeDuration > 0
          ? state.nativeDuration
          : Number.POSITIVE_INFINITY;
        const previewPos = Math.min(
          Math.max(0, Number(state.nativeSeekBasePos) + Number(state.nativeSeekPendingSteps) * 10),
          durationCap,
        );
        state.nativeSeekPreviewPos = previewPos;
        state.nativeSeekPreviewTs = Date.now();
        console.log(
          `[REMOTE] MPV trickplay step=${state.nativeSeekPendingSteps} preview=${previewPos.toFixed(2)}s`,
        );
        showTrickplayAt(previewPos).catch(() => {});
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (activeOverlay) {
        e.preventDefault();
        moveFocus(key, activeOverlay);
        return;
      }

      const previewTracks = [ui.moviePreviewTrack, ui.animationTrack, ui.dramaTrack].filter(Boolean);
      if (key === "ArrowLeft" || key === "ArrowRight") {
        const forcedTrack = previewTracks.find((track) => {
          if (!track) return false;
          if (track.parentElement && track.parentElement.classList.contains("hidden")) return false;
          const anyCard = track.querySelector(".movie-preview-card");
          return !!anyCard;
        }) || null;
        if (forcedTrack) {
          const cards = Array.from(forcedTrack.querySelectorAll(".movie-preview-card"));
          let fixed = forcedTrack.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
          if (!fixed && cards.length > 0) {
            fixed = cards[0];
            markLeftAnchorCard(forcedTrack, fixed, { force: true });
            console.log("[REMOTE] anchor bootstrap:", forcedTrack.id || "<track>", fixed.dataset.previewKey || "");
          }
          // Keep anchor deterministic at the first slot so rotation always has visible effect.
          if (cards.length > 0 && fixed && cards[0] !== fixed) {
            fixed = cards[0];
            markLeftAnchorCard(forcedTrack, fixed, { force: true });
            console.log("[REMOTE] anchor normalized to first slot:", forcedTrack.id || "<track>");
          }
          const fixedIdx = fixed ? cards.indexOf(fixed) : -1;
          if (fixedIdx >= 0) {
            const delta = key === "ArrowRight" ? 1 : -1;
            const changed = rotateCardContentsKeepAnchor(forcedTrack, fixed, delta);
            if (changed) {
              markLeftAnchorCard(forcedTrack, fixed, { force: true });
              fixed.focus({ preventScroll: true });
              if (key === "ArrowRight") {
                if (forcedTrack === ui.moviePreviewTrack) loadMoviePreviewRail(true).catch(() => {});
                else if (forcedTrack === ui.animationTrack) loadAnimationRail(true).catch(() => {});
                else if (forcedTrack === ui.dramaTrack) loadDramaRail(true).catch(() => {});
              }
              setTimeout(() => triggerLeftmostPreviewForTrack(forcedTrack, true), 80);
            } else {
              console.warn("[REMOTE] rotate skipped:", {
                track: forcedTrack.id || "<track>",
                fixedIdx,
                cards: cards.length,
                key,
              });
            }
            e.preventDefault();
            return;
          }
        }
      }

      const currentPreviewCard = current && current.closest
        ? current.closest(".movie-preview-card")
        : null;
      const currentPreviewTrack = currentPreviewCard
        ? (currentPreviewCard.closest("#movie-preview-track, #animation-track, #drama-track") || null)
        : null;
      let activePreviewTrack = currentPreviewTrack || previewTracks.find((track) => {
        if (!track) return false;
        if (track.parentElement && track.parentElement.classList.contains("hidden")) return false;
        const fixed = track.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
        return !!fixed && (track.contains(current) || document.activeElement === fixed);
      }) || null;

      // Remote UX: if no focused preview card but a preview rail is visible, still drive the first visible rail.
      if (!activePreviewTrack && (key === "ArrowLeft" || key === "ArrowRight")) {
        activePreviewTrack = previewTracks.find((track) => {
          if (!track) return false;
          if (track.parentElement && track.parentElement.classList.contains("hidden")) return false;
          const fixed = track.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
          return !!fixed;
        }) || null;
      }

      if (activePreviewTrack) {
        const cards = Array.from(activePreviewTrack.querySelectorAll(".movie-preview-card"));
        const fixed = activePreviewTrack.querySelector('.movie-preview-card[data-anchor-fixed="1"]');
        const fixedIdx = fixed ? cards.indexOf(fixed) : -1;
        if (fixedIdx >= 0) {
          if (key === "ArrowLeft" || key === "ArrowRight") {
            const delta = key === "ArrowRight" ? 1 : -1;
            const changed = rotateCardContentsKeepAnchor(activePreviewTrack, fixed, delta);
            if (changed) {
              markLeftAnchorCard(activePreviewTrack, fixed, { force: true });
              fixed.focus({ preventScroll: true });

              if (key === "ArrowRight") {
                if (activePreviewTrack === ui.moviePreviewTrack) loadMoviePreviewRail(true).catch(() => {});
                else if (activePreviewTrack === ui.animationTrack) loadAnimationRail(true).catch(() => {});
                else if (activePreviewTrack === ui.dramaTrack) loadDramaRail(true).catch(() => {});
              }

              setTimeout(() => triggerLeftmostPreviewForTrack(activePreviewTrack, true), 80);
            }
            e.preventDefault();
            return;
          }
          if (key === "ArrowDown") {
            const firstGridCard = document.querySelector("#library-grid .card");
            if (firstGridCard) firstGridCard.focus();
            e.preventDefault();
            return;
          }
          if (key === "ArrowUp") {
            const heroPlayBtn = document.querySelector(".hero-slide.active .btn-play-hero");
            const fallback = document.querySelector(".tab.active, .tab");
            (heroPlayBtn || fallback)?.focus();
            e.preventDefault();
            return;
          }
        }
      }

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
      const moved = moveFocus(key);
      if (!moved && (key === "ArrowDown" || key === "ArrowUp")) {
        const container = document.querySelector(".content-container");
        if (container && container.classList.contains("folder-play-only")) {
          // Single-play movie mode should stay fixed; do not scroll away the CTA.
          return;
        }
        if (container) {
          const delta = key === "ArrowDown" ? 220 : -220;
          container.scrollBy({ top: delta, behavior: e.repeat ? "auto" : "smooth" });
          state.scrollLoadArmed = true;
          console.log(`[REMOTE] No focus target. Scrolling container: ${delta}`);
        }
      }
    }

    // If a modal menu is open, force Enter to act within the menu first.
    if (key === "Enter" && activeOverlay) {
      if (!activeOverlay.contains(current)) {
        const first = activeOverlay.querySelector('[tabindex="0"], button, .category-option, .sort-option, [data-qprofile]');
        if (first && typeof first.focus === "function") first.focus();
      }
      e.preventDefault();
      return;
    }
  });

  // Initial Focus
  setTimeout(() => {
    const firstTab =
      document.querySelector(".tab.active") || document.querySelector(".tab");
    if (firstTab) firstTab.focus();
  }, 1000);
}

function moveFocus(direction, scopeRoot = document) {
  const current = document.activeElement;
  const focusables = Array.from(
    scopeRoot.querySelectorAll(
      'button, input, [tabindex="0"], .card, .tab, .chip, .nav-item:not(.active-placeholder), .category-option, .sort-option, [data-qprofile]',
    ),
  ).filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0);

  if (!current || current === document.body || (scopeRoot !== document && !scopeRoot.contains(current))) {
    if (focusables.length > 0) {
      focusables[0].focus();
      return true;
    }
    return false;
  }

  const currentRect = current.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2,
  };

  const isCurrentInBottomNav = !!current.closest('.bottom-nav');
  const isCurrentInGrid = !!current.closest('#library-grid, #search-results');
  const gridFocusables = focusables.filter((el) => !!el.closest('#library-grid, #search-results'));

  const findBestCandidate = (list, penalty, allowBottomNav = true) => {
    let bestCandidate = null;
    let minDistance = Infinity;

    list.forEach((candidate) => {
      if (candidate === current) return;

      const isCandidateBottomNav = !!candidate.closest('.bottom-nav');
      if (!allowBottomNav && isCandidateBottomNav) return;

      const candidateRect = candidate.getBoundingClientRect();
      const candidateCenter = {
        x: candidateRect.left + candidateRect.width / 2,
        y: candidateRect.top + candidateRect.height / 2,
      };

      const dx = candidateCenter.x - currentCenter.x;
      const dy = candidateCenter.y - currentCenter.y;

      let isCorrectDirection = false;
      if (direction === 'ArrowUp') isCorrectDirection = dy < -1;
      if (direction === 'ArrowDown') isCorrectDirection = dy > 1;
      if (direction === 'ArrowLeft') isCorrectDirection = dx < -1;
      if (direction === 'ArrowRight') isCorrectDirection = dx > 1;
      if (!isCorrectDirection) return;

      const dist =
        direction.includes('ArrowUp') || direction.includes('ArrowDown')
          ? Math.abs(dy) + Math.abs(dx) * penalty
          : Math.abs(dx) + Math.abs(dy) * penalty;

      if (dist < minDistance) {
        minDistance = dist;
        bestCandidate = candidate;
      }
    });

    return bestCandidate;
  };

  const ensureVisibleInContainer = (el) => {
    const container = document.querySelector('.content-container');
    if (!container || !el) return;

    const crect = container.getBoundingClientRect();
    const erect = el.getBoundingClientRect();
    const header = document.querySelector('.glass-header');
    const sticky = document.querySelector('.view-header');
    const bottomNav = document.querySelector('.bottom-nav');

    const topInset = (header?.offsetHeight || 0) + (sticky?.offsetHeight || 0) + 16;
    const bottomInset = (bottomNav?.offsetHeight || 0) + 16;

    const visibleTop = crect.top + topInset;
    const visibleBottom = crect.bottom - bottomInset;

    if (erect.top < visibleTop) {
      container.scrollBy({ top: erect.top - visibleTop, behavior: 'smooth' });
    } else if (erect.bottom > visibleBottom) {
      container.scrollBy({ top: erect.bottom - visibleBottom, behavior: 'smooth' });
    }
  };

  let target = null;

  // When navigating inside grid with UP/DOWN, keep focus inside grid first.
  if (isCurrentInGrid && (direction === 'ArrowUp' || direction === 'ArrowDown')) {
    target = findBestCandidate(gridFocusables, 8, true) || findBestCandidate(gridFocusables, 1, true);

    // At top of grid + ArrowUp: prefer smooth scroll up instead of jumping to top tabs.
    if (!target && direction === 'ArrowUp') {
      const container = document.querySelector('.content-container');
      if (container) {
        container.scrollBy({ top: -220, behavior: 'smooth' });
        state.scrollLoadArmed = true;
      }
      console.log('[REMOTE] Grid ArrowUp with no grid target: keep in list/scroll only');
      return false;
    }

    // At end of grid + ArrowDown: allow falling to bottom nav.
    if (!target && direction === 'ArrowDown') {
      target = findBestCandidate(focusables, 1, true);
    }
  } else {
    // Default behavior outside grid.
    const preferNonBottomDown = direction === 'ArrowDown' && !isCurrentInBottomNav;

    target = findBestCandidate(focusables, 8, !preferNonBottomDown)
      || findBestCandidate(focusables, 1, !preferNonBottomDown);

    if (!target && preferNonBottomDown) {
      target = document.querySelector('#library-grid .card, #search-results .card');
    }

    if (!target && preferNonBottomDown) {
      target = findBestCandidate(focusables, 1, true);
    }
  }

  if (!target && direction === 'ArrowUp' && current.closest('.bottom-nav')) {
    console.log('[REMOTE] Panic escape from bottom nav: Jumping to first content item');
    target = document.querySelector('.card, .chip, #search-input, .tab.active, .tab');
  }

  if (!target && direction === 'ArrowDown' && current.closest('.player-header')) {
    target =
      document.getElementById('btn-center-play') ||
      document.getElementById('progress-slider');
  }

  if (target) {
    console.log('[REMOTE] Success: Moving focus to', target);
    target.focus();
    ensureVisibleInContainer(target);
    return true;
  }

  console.warn('[REMOTE] No focusable candidate found for:', direction);
  return false;
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
        resetNativeSeekPending();
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
      if (el.__flashplexOscBound) return;
      el.__flashplexOscBound = true;
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
    if (state.nativeFullscreenTransition) return;
    const now = Date.now();
    if (now - (state.lastFullscreenToggleAt || 0) < 1800) {
      console.warn("[PLAYER] Fullscreen click ignored (cooldown)");
      return;
    }
    state.lastFullscreenToggleAt = now;
    const invoke = getTauriInvoke();
    const applyWindowFullscreenClass = (isFs) => {
      document.body.classList.toggle("window-fullscreen", !!isFs);
      document.documentElement.classList.toggle("window-fullscreen", !!isFs);
    };
    try {
      state.nativeFullscreenTransition = true;
      // [FIX] Use explicit fullscreen state set (more reliable than toggle on macOS).
      if (invoke) {
        setNativeTransitionMask(true);
        const currentFs = await invoke("native_get_fullscreen").catch(() => false);
        const targetFs = !currentFs;

        // Pre-size once before parent fullscreen transition to reduce first jump.
        if (state.isNativeActive) {
          await invoke("resize_native_player", {}).catch(() => {});
          await new Promise((r) => setTimeout(r, 70));
        }

        await invoke("native_set_fullscreen", { fullscreen: targetFs }).catch(() => {});
        const reached = await waitForNativeFullscreenState(invoke, targetFs, 1500);
        if (!reached) console.warn("[PLAYER] set_fullscreen timed out.");
        const finalFs = await invoke("native_get_fullscreen").catch(() => currentFs);
        applyWindowFullscreenClass(finalFs);
        if (!reached || finalFs !== targetFs) {
          console.warn("[PLAYER] Fullscreen state mismatch after request", { targetFs, finalFs });
        }
        // Embedded Intel path: keep mpv windowed and only resize container.
        if (state.nativeArch === "x86_64") {
          await invoke("native_set_mpv_fullscreen", { fullscreen: false }).catch(() => {});
        } else {
          await invoke("native_set_mpv_fullscreen", { fullscreen: !!finalFs }).catch(() => {});
        }
        await stabilizeNativeFullscreenResize(invoke, finalFs);

        console.log("[PLAYER] Native Fullscreen Set:", finalFs);
        // 1) Pre-fit embedded container on the new parent bounds.
        if (state.nativeArch !== "x86_64") {
          await prefitNativeContainerForFullscreen(invoke, targetFs);
        }
        // 2) Recreate once after bounds are stabilized.
        // Intel Macs are more stable with resize-only during fullscreen transitions.
        if (state.isNativeActive) {
          await new Promise((r) => setTimeout(r, targetFs ? 140 : 120));
          if (state.nativeArch === "x86_64") {
            if (targetFs) {
              console.log("[PLAYER] Intel fullscreen-enter: resize-only");
              await invoke("resize_native_player", {}).catch(() => {});
            } else {
              console.log("[PLAYER] Intel fullscreen-exit: resize + conditional recreate");
              state.fullscreenEnterRepairAttempted = false;
              await invoke("resize_native_player", {}).catch(() => {});
              await maybeRecreateOnFullscreenExitIntel(invoke).catch(() => {});
            }
          } else {
            await recreateNativePlayerAfterResize(targetFs ? "fullscreen-enter" : "fullscreen-exit");
          }
        } else {
          setTimeout(() => setNativeTransitionMask(false), 160);
        }
      } else {
        throw new Error("Tauri Invoke not available");
      }
    } catch (err) {
      console.error("[PLAYER] Native Fullscreen Error:", err);
      setNativeTransitionMask(false);
      // Do not fallback to DOM fullscreen in desktop app.
      // Mixing DOM + native fullscreen causes immediate bounce on macOS.
    } finally {
      setNativeTransitionMask(false);
      // Keep guard window long enough to cover macOS fullscreen animation settle.
      setTimeout(() => {
        state.nativeFullscreenTransition = false;
      }, 900);
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
      if (state.nativeRecreating || state.nativeFullscreenTransition) return;
      if (nativeResizeDebounceTimer) clearTimeout(nativeResizeDebounceTimer);
      nativeResizeDebounceTimer = setTimeout(() => {
        inv("resize_native_player", {}).catch((err) => {
          console.error("[PLAYER] Resize sync failed:", err);
        });
      }, 280);
    };
    const onNativeFullscreenChange = () => {
      if (state.nativeFullscreenTransition) return;
      syncNativeResize();
      const inv = getTauriInvoke();
      if (inv) {
        inv("native_get_fullscreen")
          .then((isFs) => {
            applyWindowFullscreenClass(isFs);
            const mpvFs = state.nativeArch === "x86_64" ? false : !!isFs;
            return inv("native_set_mpv_fullscreen", { fullscreen: mpvFs })
              .catch(() => {})
              .then(() => stabilizeNativeFullscreenResize(inv, !!isFs));
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
