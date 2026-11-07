// Persistent settings and per-file reading positions. Uses chrome.storage
// inside the extension and falls back to localStorage when the viewer is
// served as a plain page (dev/test).
const hasChromeStorage = typeof chrome !== "undefined" && !!chrome.storage?.local;
const MAX_POSITIONS = 1000;

async function get(key) {
  if (hasChromeStorage) return (await chrome.storage.local.get(key))[key];
  try {
    const v = localStorage.getItem(key);
    return v == null ? undefined : JSON.parse(v);
  } catch {
    return undefined;
  }
}

async function set(key, value) {
  if (hasChromeStorage) return chrome.storage.local.set({ [key]: value });
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export const DEFAULT_PREFS = {
  invert: false, // bake inverted colors into page bitmaps
  theme: "system", // "system" | "light" | "dark" (UI chrome only)
  sidebar: false,
  fps: false,
};

export async function loadPrefs() {
  return { ...DEFAULT_PREFS, ...((await get("prefs")) || {}) };
}

export function savePrefs(prefs) {
  return set("prefs", prefs);
}

export async function loadPosition(fileKey) {
  const all = (await get("positions")) || {};
  return all[fileKey] || null;
}

let pending = null;
export async function savePosition(fileKey, pos) {
  // Serialize read-modify-write so rapid saves don't clobber each other.
  const run = async () => {
    const all = (await get("positions")) || {};
    all[fileKey] = { ...pos, t: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_POSITIONS) {
      keys.sort((a, b) => all[a].t - all[b].t);
      for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) delete all[k];
    }
    await set("positions", all);
  };
  pending = (pending || Promise.resolve()).then(run, run);
  return pending;
}
