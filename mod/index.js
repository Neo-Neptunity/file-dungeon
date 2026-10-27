// ファイル・ダンジョン — フォルダ = 部屋、サブフォルダ = 扉、ファイル = モンスター
// 討伐できるのは「長く使われていないファイル」だけ。最近使ったものは守られて、画面には出ない。
// アクションで倒した分は「回収待ち」にたまり、まとめて1回、本体の確認を通してからごみ箱へ送る。
import { createNet, localLore } from "./net.js";

const ep = window.explorerPlus;

// ---- 定数 ----------------------------------------------------------------
const DAY = 86400000;
const SANCTUARY = /^[a-z]:\\(windows|program files( \(x86\))?|programdata)(\\|$)/i;   // 聖域：攻撃できない場所
const PROTECTED_EXT = new Set(["dll", "sys", "lib", "so", "dylib"]);                  // 封印：システムの部品
const W = 1280, H = 720, WALL = 28;           // 部屋の仮想サイズ（画面に合わせて拡大縮小する）
const DOOR_W = 112, DOOR_H = 60, DOORS_PER_ROW = 10, MAX_DOORS = 30;
const BOSS_MIN_BYTES = 10 * 1024 * 1024;
const HERO_SPEED = 300, SLASH_CD = 0.26;
const DASH_TIME = 0.16, DASH_SPEED = 950, DASH_CD = 0.7, DASH_INV = 0.28;
const SPIN_CD = 6, SPIN_R = 150;
const COMBO_WINDOW = 2;                       // コンボが途切れるまでの秒数
const FLUSH_DELAY = 2;                        // 最後に倒してから、ごみ箱の確認を出すまでの秒数
const FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const TIER_COLORS = ["#8b949e", "#57ab5a", "#4c9be8", "#a371f7", "#f0883e", "#f85149"];

const SPECIES = {
  image: { emoji: "🧚", name: "妖精" },
  video: { emoji: "🐉", name: "ドラゴン" },
  audio: { emoji: "🧜", name: "セイレーン" },
  archive: { emoji: "📦", name: "ミミック" },
  doc: { emoji: "🦉", name: "賢者" },
  code: { emoji: "👺", name: "ゴブリン" },
  exe: { emoji: "🤖", name: "ガーディアン" },
  system: { emoji: "🗿", name: "ゴーレム" },
  other: { emoji: "👾", name: "影" },
};
const EXT = {};
const reg = (cat, list) => list.split(" ").forEach((x) => (EXT[x] = cat));
reg("image", "jpg jpeg png gif webp bmp svg heic heif ico tif tiff avif raw psd");
reg("video", "mp4 mkv mov avi webm wmv flv m4v mpg mpeg");
reg("audio", "mp3 wav flac m4a ogg aac wma opus mid");
reg("archive", "zip rar 7z tar gz bz2 xz iso cab");
reg("doc", "doc docx pdf txt md rtf ppt pptx xls xlsx csv odt epub log");
reg("code", "js mjs ts tsx jsx py java c cpp h cs go rs rb php html css json xml yml yaml sh bat ps1 sql lua");
reg("exe", "exe msi apk app");
reg("system", "dll sys lib so dylib dat bin tmp");

// ---- 状態 ----------------------------------------------------------------
await ep.ready();
let s = await ep.settings.get();
const net = createNet(ep, () => s);
ep.onSettings((next) => {
  s = next;
  loadWeather();
  if (folder) applyFolder(folder);
});

let save = Object.assign({ xp: 0, kills: 0, freed: 0 }, await ep.storage.get("hero"));
const loreStore = (await ep.storage.get("lore")) || {};   // AI が作った二つ名・セリフ（新しい 200 件まで）
const heroLevel = (xp) => 1 + Math.floor(Math.sqrt(xp / 30));
const xpFor = (lv) => (lv - 1) * (lv - 1) * 30;
const maxHpOf = (lv) => 50 + lv * 10;

const hero = {
  x: W / 2, y: H - 110, hp: maxHpOf(heroLevel(save.xp)), cd: 0, inv: 0, hurt: 99, goal: null, target: null,
  face: -Math.PI / 2, moving: false, chain: 0, chainT: 0, swing: null,
  dashT: 0, dashCd: 0, dashDx: 0, dashDy: 0, dashHit: new Set(), spinCd: 0, kbx: 0, kby: 0,
};
let folder = null, roomKey = null;
let monsters = new Map();      // key -> monster
let doors = [];                // { entry, x, y, w, h, label }
let parentDoor = null;
let bandBottom = WALL + 16;
let fx = [];
let fade = 1;
let navigating = false;
let sanctuary = false;         // 聖域（Windows・Program Files など）では誰も攻撃できない
let scanned = false;           // 「最近使ったか」の調査が済むまで攻撃しない
const accessCache = new Map(); // key -> { mod, acc }  アクセス日時（更新日時が変わったら無効）
let recentKeys = new Set();    // このアプリで最近開いたファイル
let weather = null;            // { kind, night, temp }
let llmDownUntil = 0, llmFails = 0;
let hover = null;              // { monster | door }
let lastStatus = "";
const keys = new Set();
let bullets = [];              // 敵の弾 { x, y, vx, vy, dmg, age }
let shake = 0, hitstop = 0, slowmo = 0;
let combo = 0, comboT = 0, streak = { n: 0, t: 0 };
let mouse = { x: W / 2, y: H / 2, at: -99 }, mouseDown = false;
let pending = [];              // 倒したが、まだごみ箱へ送っていない { entry, key, gain, size }
const pendingKeys = new Map(); // key -> 回収待ち（討伐対象に出さない）
let flushing = false, lastKillAt = 0, killedHere = 0, cleared = false, refill = false, lastRefill = 0;

const toast = (m) => ep.ui.toast(m).catch(() => {});
const status = (m) => { if (m !== lastStatus) { lastStatus = m; ep.ui.status(m).catch(() => {}); } };

// ---- 画面（HUD と canvas）--------------------------------------------------
const style = document.createElement("style");
style.textContent = `
  html,body{margin:0;height:100%;background:#0b0a10;color:#d7d3e8;font:13px "Segoe UI","Yu Gothic UI",sans-serif;overflow:hidden}
  body{display:flex;flex-direction:column}
  #hud{display:flex;align-items:center;gap:14px;padding:6px 12px;background:#17141f;border-bottom:1px solid #2b2740;flex:none;white-space:nowrap;overflow:hidden}
  #hud .bar{position:relative;width:150px;height:16px;background:#0b0a10;border:1px solid #3a3456;border-radius:3px;overflow:hidden}
  #hud .bar i{position:absolute;inset:0 auto 0 0;width:0}
  #hud .bar b{position:absolute;inset:0;text-align:center;font-weight:400;font-size:11px;line-height:16px}
  #hp i{background:#c0392b}#xp i{background:#8e6bd8}
  #lv{font-weight:700;color:#f0c75e}
  #hint{margin-left:auto;color:#7d7898;overflow:hidden;text-overflow:ellipsis}
  #stage{flex:1;min-height:0;position:relative}
  canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  #paper{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,86%);max-height:80%;overflow:auto;
    background:#efe3c6;color:#3a2e1a;padding:20px 24px;border-radius:6px;box-shadow:0 8px 40px #000c;line-height:1.9;font-size:15px}
  #paper h3{margin:0 0 8px;font-size:15px;color:#7a5a24}
  #paper p{margin:0 0 14px;white-space:pre-wrap}
  #paper button{float:right;background:#7a5a24;color:#fff;border:0;border-radius:4px;padding:5px 14px;cursor:pointer}
`;
document.head.append(style);
document.body.innerHTML = `
  <div id="hud">
    <span id="lv"></span>
    <div class="bar" id="hp"><i></i><b></b></div>
    <div class="bar" id="xp"><i></i><b></b></div>
    <span id="stats"></span>
    <span id="weather"></span>
    <span id="hint">WASD：移動 ／ 左クリック・J：斬る（3連で大技） ／ Shift・Space：ダッシュ ／ Q：回転斬り ／ F：近くの扉に入る ／ E：回収の確認 ／ 右クリック：メニュー ／ 対象は長く使われていないファイルだけ</span>
  </div>
  <div id="stage"><canvas></canvas><div id="paper" hidden></div></div>`;
const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");
let scale = 1, ox = 0, oy = 0, dpr = 1;

function resize() {
  const st = $("stage").getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(st.width * dpr));
  canvas.height = Math.max(1, Math.round(st.height * dpr));
  scale = Math.min(st.width / W, st.height / H);
  ox = (st.width - W * scale) / 2;
  oy = (st.height - H * scale) / 2;
}
new ResizeObserver(resize).observe($("stage"));
resize();

const toWorld = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - ox) / scale, y: (e.clientY - r.top - oy) / scale };
};
const screenRect = (x, y, r) => {
  const c = canvas.getBoundingClientRect();
  const left = c.left + ox + (x - r) * scale, top = c.top + oy + (y - r) * scale, size = r * 2 * scale;
  return { x: left, y: top, left, top, width: size, height: size, right: left + size, bottom: top + size };
};

// ---- モンスター --------------------------------------------------------------
const keyOf = (e) => e.id || e.path.toLowerCase();
const lvOf = (e) => Math.min(20, Math.floor(Math.log2((e.size || 0) / 1024 + 1) / 1.5) + 1);
const tierColor = (lv) => TIER_COLORS[Math.min(TIER_COLORS.length - 1, Math.floor(lv / 3))];
const fmtSize = (n) => {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};

// ---- 「使われていないか」の判定（ここが討伐の安全の要）----------------------------------
const recentHas = (e) => recentKeys.has(e.id) || recentKeys.has(e.path.toLowerCase());
const accessKnown = (e) => { const c = accessCache.get(keyOf(e)); return !!c && c.mod === e.modified; };
const lastUsed = (e) => {
  const c = accessCache.get(keyOf(e));
  return Math.max(e.modified || 0, c && c.mod === e.modified ? c.acc : 0);
};
// 住民である理由。null なら討伐対象。迷ったら守る側に倒す
function protectedWhy(e) {
  if (sanctuary) return "聖域（システムのフォルダ）";
  if (PROTECTED_EXT.has(e.ext)) return "封印（システムの部品）";
  if (!e.modified) return "更新日時が不明";
  if (recentHas(e)) return "最近このアプリで開いた";
  // アクセス日時をまだ調べていない古いファイルは、調べ終わるまで守る（調べる前に敵として出すと、あとで全員が消える）
  if (s.useAccessTime && e.kind === "file" && Date.now() - e.modified > s.staleDays * DAY && !accessKnown(e)) return "アクセス日時を調査中";
  if (Date.now() - lastUsed(e) <= s.staleDays * DAY) return "最近使われている";
  return null;
}

function stats(m) {
  const lv = lvOf(m.entry);
  m.lv = lv;
  m.why = protectedWhy(m.entry);
  m.stale = !m.why;
  m.boss = m.boss && m.stale;
  m.r = m.boss ? 58 : Math.min(40, 18 + lv * 1.3) * (m.stale ? 1 : 0.8);
  const maxHp = (20 + lv * 16) * (m.boss ? 4 : 1);
  m.hp = m.maxHp ? Math.max(1, Math.round((m.hp / m.maxHp) * maxHp)) : maxHp;
  m.maxHp = maxHp;
  m.idle = Date.now() - lastUsed(m.entry);
  m.ghost = m.stale && m.idle > s.staleDays * DAY * 2;     // 倍の期間なら亡霊（経験値ボーナス）
  m.cat = m.entry.kind === "file" ? EXT[m.entry.ext] || "other" : "other";
  m.seed = hash(m.entry.name);
}

const fmtIdle = (ms) => {
  const d = Math.floor(ms / DAY);
  return d >= 365 ? `${Math.floor(d / 365)}年${Math.floor((d % 365) / 30)}か月` : d >= 30 ? `${Math.floor(d / 30)}か月` : `${d}日`;
};
function hash(str) {                           // FNV-1a。見た目のタネにする（名前そのものは送らない）
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

// アクセス日時：更新日時が古いものだけ、Windows に聞く（使われていた形跡があれば守る）
function parseTime(v) {
  const t = typeof v === "number" ? v : Date.parse(v);
  return t > 6e11 && t < 4.1e12 ? t : 0;      // 1990〜2100 年のミリ秒だけ受け付ける
}
// 「使った」と数えるアクセス日時。作られた（OneDrive の同期・コピー）直後のアクセス日時は、使った印ではない
function usedTime(r) {
  const acc = parseTime(r && r["System.DateAccessed"]), made = parseTime(r && r["System.DateCreated"]);
  return acc > made + 3600e3 ? acc : 0;
}
const ACCESS_BATCH = 200, ACCESS_MAX = 3000;
let accessRun = Promise.resolve();
const refreshAccess = (f) => (accessRun = accessRun.then(() => scanAccess(f)));   // 同時に走らせず、順番に
let accessFailedAt = 0;
async function scanAccess(f) {
  if (!s.useAccessTime || Date.now() - accessFailedAt < 30e3) return;   // 失敗した直後は、やり直し続けない
  const limit = Date.now() - s.staleDays * DAY;
  const todo = f.entries
    .filter((e) => e.kind === "file" && e.modified && e.modified < limit && !accessKnown(e))
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, ACCESS_MAX);
  if (!todo.length) return;
  try {
    for (let i = 0; i < todo.length; i += ACCESS_BATCH) {      // 全部調べる。調べきれなかったものは守られたまま
      const cand = todo.slice(i, i + ACCESS_BATCH);
      const res = await ep.files.properties(cand, ["System.DateAccessed", "System.DateCreated"]);
      cand.forEach((e, j) => accessCache.set(keyOf(e), { mod: e.modified, acc: usedTime(res[j]) }));
    }
  } catch (err) {
    accessFailedAt = Date.now();
    console.warn("アクセス日時を取れませんでした（調べられなかったファイルは守られます）：", err.message);
    return;
  }
  if (folder && folder.path === f.path) applyFolder(folder);
}
async function refreshRecent() {
  try {
    const list = await ep.recent.list();
    const next = new Set();
    for (const r of list) { if (r.id) next.add(r.id); if (r.path) next.add(r.path.toLowerCase()); }
    recentKeys = next;
  } catch (err) {
    console.warn("最近のファイルを取れませんでした：", err.message);
  }
}

// ---- 通信：見た目・二つ名・天気 ----------------------------------------------------------
const llmReady = () => s.llm && s.apiKey && Date.now() > llmDownUntil;
function llmFailed(err) {
  console.warn("AI の呼び出しに失敗：", err.message);
  if (err.status === 401 || err.status === 403) { llmDownUntil = Date.now() + 3600e3; toast("AI の API キーが使えません。設定で確かめてください"); }
  else if (++llmFails >= 3) { llmDownUntil = Date.now() + 5 * 60e3; llmFails = 0; }
}

const avatarImgs = new Map();
function avatarOf(m) {
  if (s.avatars === "off") return null;
  const k = `${s.avatars}:${m.seed}`;
  let im = avatarImgs.get(k);
  if (!im) {
    im = new Image();
    avatarImgs.set(k, im);
    net.avatarUrl(s.avatars, m.seed).then((u) => (im.src = u)).catch(() => {});
  }
  return im.complete && im.naturalWidth ? im : null;
}

const CITY_NAMES = { "43.06,141.35": "札幌", "38.27,140.87": "仙台", "35.68,139.76": "東京", "35.18,136.91": "名古屋", "34.69,135.50": "大阪", "33.59,130.40": "福岡", "26.21,127.68": "那覇" };
const WEATHER_ICON = { clear: "☀️", cloud: "☁️", fog: "🌫️", rain: "🌧️", snow: "❄️", storm: "⛈️" };
async function loadWeather() {
  if (!s.weather) { weather = null; $("weather").textContent = ""; return; }
  try {
    const [lat, lon] = s.city.split(",");
    weather = await net.weather(lat, lon);
    $("weather").textContent = `${weather.night && weather.kind === "clear" ? "🌙" : WEATHER_ICON[weather.kind]} ${CITY_NAMES[s.city] || ""} ${weather.temp}°C`;
  } catch (err) {
    console.warn("天気を取れませんでした：", err.message);
  }
}
setInterval(loadWeather, 30 * 60e3);

// 最初のひと言は手元のセリフ、AI が使えれば後から差し替える
function ensureLore(m) {
  if (m.lore) return;
  const k = `${keyOf(m.entry)}|${m.entry.name}`;
  m.lore = loreStore[k] || localLore(m.cat);
  if (loreStore[k] || !llmReady()) return;
  const info = {
    name: m.entry.name, species: SPECIES[m.cat].name, level: m.lv, boss: m.boss,
    size: fmtSize(m.entry.size), unusedFor: fmtIdle(m.idle), ghost: m.ghost,
  };
  net.lore(info).then((l) => {
    llmFails = 0;
    m.lore = l;
    loreStore[k] = l;
    const ks = Object.keys(loreStore);
    if (ks.length > 200) for (const old of ks.slice(0, ks.length - 200)) delete loreStore[old];
    ep.storage.set("lore", loreStore).catch(() => {});
    if (monsters.get(keyOf(m.entry)) === m && m.state === "alive") m.say = { text: l.taunt, ttl: 2.5 };
  }).catch(llmFailed);
}

function spawnPos(r) {
  const minY = bandBottom + r + 24;
  for (let i = 0; i < 30; i++) {
    const x = WALL + r + Math.random() * (W - 2 * WALL - 2 * r);
    const y = minY + Math.random() * (H - WALL - r - minY);
    if (Math.hypot(x - hero.x, y - hero.y) < 200) continue;
    let ok = true;
    for (const o of monsters.values()) if (Math.hypot(o.x - x, o.y - y) < o.r + r) { ok = false; break; }
    if (ok) return { x, y };
  }
  return { x: W / 2 + (Math.random() - 0.5) * 400, y: minY + 40 };
}

function newMonster(entry, boss) {
  const m = { entry, boss, state: "alive", age: 0, ph: Math.random() * 6.28, vx: 0, vy: 0, think: 0, atk: 0, flash: 0, hp: 0, maxHp: 0,
    kx: 0, ky: 0, stun: 0, wind: 0, windMax: 1, windKind: "melee", shot: 1 + Math.random() * 3, charge: 0, cdx: 0, cdy: 0 };
  stats(m);
  Object.assign(m, spawnPos(m.r));
  if (s.thumbs && (EXT[entry.ext] === "image" || EXT[entry.ext] === "video")) {   // 縮小画像を作るために本体がファイルを読む
    if (entry.thumbnailUrl) {
      m.img = new Image();
      m.img.src = entry.thumbnailUrl;
    }
  }
  return m;
}

function burst(x, y, color, n = 16, spread = 160) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28, v = spread * (0.3 + Math.random() * 0.7);
    fx.push({ k: "p", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0.7 + Math.random() * 0.4, age: 0, color, size: 3 + Math.random() * 5 });
  }
}

function crumble(m) {
  burst(m.x, m.y, tierColor(m.lv), m.boss ? 60 : 18, m.boss ? 320 : 170);
  monsters.delete(keyOf(m.entry));
  if (hero.target === m) hero.target = null;
}

// ---- フォルダの反映 ------------------------------------------------------------
function buildDoors(folders, f) {
  const list = folders.slice(0, MAX_DOORS);
  doors = [];
  const rows = Math.ceil(list.length / DOORS_PER_ROW);
  list.forEach((entry, i) => {
    const row = Math.floor(i / DOORS_PER_ROW), inRow = Math.min(DOORS_PER_ROW, list.length - row * DOORS_PER_ROW);
    const total = inRow * DOOR_W + (inRow - 1) * 8, x0 = (W - total) / 2;
    doors.push({ entry, x: x0 + (i % DOORS_PER_ROW) * (DOOR_W + 8), y: WALL + 8 + row * (DOOR_H + 8), w: DOOR_W, h: DOOR_H });
  });
  bandBottom = WALL + (rows ? 8 + rows * (DOOR_H + 8) : 16);
  parentDoor = f.parentPath ? { parent: true, x: W / 2 - 70, y: H - 46, w: 140, h: 40 } : null;
}

function applyFolder(f) {
  const key = f.id || f.path.toLowerCase();
  const visible = f.entries.filter((e) => s.showHidden || !e.hidden);
  sanctuary = SANCTUARY.test(f.path);
  buildDoors(visible.filter((e) => e.kind === "folder"), f);
  const entered = key !== roomKey;
  if (entered) {
    flushPending();                  // 前の部屋で倒した分は、移る前に確認を出す
    console.log(`[部屋に入った] ${f.path}（前：${roomKey}）`);
    roomKey = key;
    monsters.clear();
    bullets = [];
    killedHere = 0;
    cleared = false;
    fx.length = 0;
    Object.assign(hero, { x: W / 2, y: H - 110, goal: null, target: null, inv: 1 });
    fade = 1;
    navigating = false;
    scanned = false;                 // 調べ終わるまでは誰も攻撃できない
  }
  folder = f;
  const accessJob = refreshAccess(f);   // 調べ済みのものは何もしない
  if (entered) {
    Promise.allSettled([refreshRecent(), accessJob]).then(() => {
      if (roomKey === key) { scanned = true; if (folder) applyFolder(folder); }
    });
  }

  const files = visible.filter((e) => e.kind === "file");
  // 調べ終わるまでは討伐対象を出さない（更新日時だけで出すと、アクセス日時が届いた瞬間に全員が崩れて消える）
  // 守られているファイル（最近使った・回収待ち）は出さない
  const hunt = scanned ? files.filter((e) => !protectedWhy(e) && !pendingKeys.has(keyOf(e))) : [];
  const stale = hunt.sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, s.maxMonsters);
  const shown = stale;
  const bossKey = stale.length && (stale[0].size || 0) >= BOSS_MIN_BYTES ? keyOf(stale[0]) : null;
  const seen = new Set();
  for (const e of shown) {
    const k = keyOf(e);
    seen.add(k);
    const old = monsters.get(k);
    if (old) {
      const renamed = old.entry.name !== e.name;
      old.entry = e;
      old.boss = k === bossKey;
      stats(old);
      if (renamed) fx.push({ k: "ring", x: old.x, y: old.y, color: "#f0c75e", life: 0.6, age: 0, r: old.r });
    } else {
      const m = newMonster(e, k === bossKey);
      monsters.set(k, m);
      fx.push({ k: "ring", x: m.x, y: m.y, color: tierColor(m.lv), life: 0.5, age: 0, r: m.r });
    }
  }
  for (const [k, m] of [...monsters]) {
    if (seen.has(k)) continue;
    const cur = files.find((e) => keyOf(e) === k);        // 倒していないのに消えるときは、理由をログに残す
    const why = !cur ? "フォルダから無くなった" : pendingKeys.has(k) ? "回収待ち" : protectedWhy(cur) || "上位の件数から外れた";
    console.warn(`[消えた] ${m.entry.name}：${why}`);
    crumble(m);
  }

  const staleAll = hunt.length, hidden = staleAll - stale.length;
  // 更新日時は古いのに、アクセス日時（ウイルス対策・検索インデックスでも更新される）が新しくて守られているファイル
  const byAccess = scanned ? files.filter((e) => e.modified && Date.now() - e.modified > s.staleDays * DAY && protectedWhy(e) === "最近使われている").length : 0;
  const unchecked = scanned ? files.filter((e) => protectedWhy(e) === "アクセス日時を調査中").length : 0;
  status(sanctuary
    ? `${f.name}　聖域：ここでは誰も攻撃できません　扉 ${doors.length}`
    : `${f.name}　討伐対象 ${stale.length}${hidden > 0 ? `（ほか ${hidden} 体は奥に潜んでいる）` : ""}　扉 ${doors.length}${scanned ? "" : "　調査中…"}${byAccess ? `　アクセス日時で保護 ${byAccess}` : ""}${unchecked ? `　調べきれず保護 ${unchecked}` : ""}`);
}

// ---- 戦闘 ------------------------------------------------------------------------
const canAttack = (m) => scanned && m.stale && m.state === "alive";
const nowS = () => performance.now() / 1000;
const heroDmg = () => 9 + heroLevel(save.xp) * 2.5;
const comboMul = () => Math.min(3, 1 + Math.floor(combo / 10) * 0.25);

// 効果音：外部ファイルは使わず、その場で鳴らす
let actx = null, lastCoin = 0;
function sfx(kind) {
  if (!s.sound) return;
  try {
    actx ||= new AudioContext();
    if (actx.state === "suspended") actx.resume();
    const t0 = actx.currentTime;
    const tone = (type, f0, f1, dur, vol = 0.06, delay = 0) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0 + delay);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + delay + dur);
      g.gain.setValueAtTime(vol, t0 + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0 + delay);
      o.stop(t0 + delay + dur + 0.02);
    };
    if (kind === "slash") tone("sawtooth", 520, 120, 0.09, 0.035);
    else if (kind === "hit") tone("square", 260, 70, 0.08, 0.06);
    else if (kind === "crit") { tone("square", 320, 60, 0.1, 0.07); tone("triangle", 900, 1500, 0.14, 0.05); }
    else if (kind === "kill") { tone("sawtooth", 340, 40, 0.28, 0.08); tone("square", 170, 30, 0.34, 0.05); }
    else if (kind === "dash") tone("sine", 250, 1000, 0.12, 0.06);
    else if (kind === "spin") tone("sawtooth", 180, 760, 0.36, 0.05);
    else if (kind === "hurt") tone("square", 150, 45, 0.22, 0.08);
    else if (kind === "coin") tone("triangle", 1000 + Math.random() * 300, 1500, 0.06, 0.025);
    else if (kind === "level" || kind === "clear") [523, 659, 784, 1047].forEach((f, i) => tone("triangle", f, f * 1.01, 0.16, 0.06, i * 0.09));
  } catch { /* 音が鳴らなくても遊べる */ }
}

function floater(x, y, text, color, size = 20, life = 0.9) {
  fx.push({ k: "t", x, y, text, color, size, life, age: 0 });
}

function hurtMonster(m, dmg, ang, kb, crit) {
  if (!canAttack(m)) return;
  if (m.hp === m.maxHp) { ensureLore(m); m.say = { text: m.lore.taunt, ttl: 2.5 }; }
  m.hp -= dmg;
  m.flash = 0.12;
  const kbv = kb * Math.min(1.6, 30 / m.r) * (m.boss ? 0.3 : 1);
  m.kx = Math.cos(ang) * kbv;
  m.ky = Math.sin(ang) * kbv;
  if (!m.boss) { m.wind = 0; m.stun = 0.25; }
  combo++;
  comboT = COMBO_WINDOW;
  floater(m.x + (Math.random() - 0.5) * 24, m.y - m.r, crit ? `${dmg}!` : `${dmg}`, crit ? "#ffd866" : "#ffffff", crit ? 26 : 20);
  burst(m.x, m.y, crit ? "#ffd866" : "#ffffff", crit ? 12 : 6, 150);
  hitstop = Math.max(hitstop, crit ? 0.07 : 0.035);
  shake = Math.max(shake, crit ? 7 : 3);
  sfx(crit ? "crit" : "hit");
  if (m.hp <= 0) kill(m);
}

// 斬る：向いた方向の扇に当たる敵をまとめて斬る。3連続で最後は大技
function slash(ang) {
  if (hero.cd > 0 || hero.dashT > 0) return;
  hero.chain = hero.chainT > 0 ? (hero.chain + 1) % 3 : 0;
  hero.chainT = 0.7;
  const fin = hero.chain === 2, lvl = heroLevel(save.xp);
  const reach = (fin ? 135 : 100) + Math.min(30, lvl), arc = fin ? 2.6 : 2.0;
  hero.cd = fin ? 0.4 : SLASH_CD;
  hero.face = ang;
  hero.x += Math.cos(ang) * (fin ? 30 : 14);          // 踏み込み
  hero.y += Math.sin(ang) * (fin ? 30 : 14);
  hero.swing = { a: ang, arc, r: reach, age: 0, life: fin ? 0.26 : 0.17, fin };
  sfx("slash");
  for (const m of [...monsters.values()]) {
    if (!canAttack(m)) continue;
    const dx = m.x - hero.x, dy = m.y - hero.y, d = Math.hypot(dx, dy);
    if (d > reach + m.r) continue;
    const da = Math.atan2(Math.sin(Math.atan2(dy, dx) - ang), Math.cos(Math.atan2(dy, dx) - ang));
    if (Math.abs(da) > arc / 2 && d > m.r + 22) continue;
    const crit = Math.random() < (fin ? 0.3 : 0.12);
    const dmg = Math.round(heroDmg() * (0.85 + Math.random() * 0.3) * (fin ? 1.7 : 1) * (crit ? 2 : 1));
    hurtMonster(m, dmg, Math.atan2(dy, dx), fin ? 560 : 320, crit);
  }
  for (const b of bullets) {                            // 飛んでくる弾は斬って落とせる
    if (Math.hypot(b.x - hero.x, b.y - hero.y) < reach) { b.age = 99; burst(b.x, b.y, "#ffb38a", 6, 120); }
  }
  if (fin) shake = Math.max(shake, 6);
}

// 回転斬り：周りをまとめて吹き飛ばす。出ている間は無敵
function spin() {
  if (hero.spinCd > 0) return;
  hero.spinCd = SPIN_CD;
  hero.inv = Math.max(hero.inv, 0.4);
  fx.push({ k: "spin", x: hero.x, y: hero.y, life: 0.42, age: 0, r: SPIN_R });
  sfx("spin");
  shake = Math.max(shake, 9);
  hitstop = Math.max(hitstop, 0.06);
  for (const m of [...monsters.values()]) {
    const dx = m.x - hero.x, dy = m.y - hero.y;
    if (!canAttack(m) || Math.hypot(dx, dy) > SPIN_R + m.r) continue;
    hurtMonster(m, Math.round(heroDmg() * 1.5 * (0.9 + Math.random() * 0.2)), Math.atan2(dy, dx), 760, false);
  }
  for (const b of bullets) if (Math.hypot(b.x - hero.x, b.y - hero.y) < SPIN_R + 40) { b.age = 99; burst(b.x, b.y, "#ffb38a", 6, 120); }
}

function dash() {
  if (hero.dashCd > 0 || hero.dashT > 0) return;
  let dx = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
  let dy = (keys.has("s") || keys.has("arrowdown") ? 1 : 0) - (keys.has("w") || keys.has("arrowup") ? 1 : 0);
  if (!dx && !dy) { dx = Math.cos(hero.face); dy = Math.sin(hero.face); }
  const n = Math.hypot(dx, dy);
  Object.assign(hero, { dashDx: dx / n, dashDy: dy / n, dashT: DASH_TIME, dashCd: DASH_CD, goal: null, dashHit: new Set() });
  hero.inv = Math.max(hero.inv, DASH_INV);
  sfx("dash");
}

function hurtHero(dmg, ang) {
  if (hero.inv > 0) return;
  hero.hp -= dmg;
  hero.hurt = 0;
  hero.inv = 0.6;
  hero.kbx = Math.cos(ang) * 420;
  hero.kby = Math.sin(ang) * 420;
  combo = 0;
  comboT = 0;
  shake = Math.max(shake, 10);
  hitstop = Math.max(hitstop, 0.06);
  sfx("hurt");
  floater(hero.x, hero.y - 40, `-${dmg}`, "#ff6b6b", 24);
  if (hero.hp <= 0) faint();
}

const shoot = (x, y, ang, speed, dmg) => bullets.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, dmg, age: 0 });

// 敵の攻撃。予告（赤い範囲）が出てから、この関数で実際に当たる
function strike(m) {
  const toHero = Math.atan2(hero.y - m.y, hero.x - m.x);
  if (m.windKind === "melee") {
    m.atk = m.boss ? 1.4 : 1.2;
    fx.push({ k: "ring", x: m.x, y: m.y, color: "#ff6b6b", life: 0.25, age: 0, r: m.r + 50 });
    if (Math.hypot(hero.x - m.x, hero.y - m.y) < m.r + 62) hurtHero(Math.round((2 + m.lv * 1.2) * (m.boss ? 2 : 1)), toHero);
  } else if (m.windKind === "shot") {
    m.atk = 0.8;
    shoot(m.x, m.y, toHero, 280, Math.round(3 + m.lv * 0.6));
  } else if (m.windKind === "charge") {
    m.charge = 0.55;
    m.cdx = Math.cos(toHero);
    m.cdy = Math.sin(toHero);
  } else if (m.windKind === "nova") {
    m.atk = 2.2;
    const n = 14, off = Math.random() * 6.28;
    for (let i = 0; i < n; i++) shoot(m.x, m.y, off + (i / n) * 6.28, 210, Math.round(4 + m.lv * 0.5));
    fx.push({ k: "ring", x: m.x, y: m.y, color: "#ff9d5c", life: 0.5, age: 0, r: m.r + 30 });
  }
}

// 倒した：派手に散らして、ファイルは「回収待ち」にためる（ごみ箱へ送るのは、あとでまとめて確認してから）
function kill(m) {
  const key = keyOf(m.entry), t = nowS();
  m.state = "down";
  monsters.delete(key);
  pendingKeys.set(key, Infinity);
  streak = t - streak.t < 1.2 ? { n: streak.n + 1, t } : { n: 1, t };
  lastKillAt = t;
  killedHere++;
  refill = true;

  const before = heroLevel(save.xp);
  const gain = Math.round((8 + m.lv * 6) * (m.ghost ? 1.5 : 1) * (m.boss ? 3 : 1) * comboMul());
  save.xp += gain;
  save.kills += 1;
  ep.storage.set("hero", save).catch(() => {});
  pending.push({ entry: m.entry, key, gain, size: m.entry.size || 0 });

  const col = tierColor(m.lv);
  burst(m.x, m.y, col, m.boss ? 80 : 26, m.boss ? 420 : 240);
  burst(m.x, m.y, "#ffffff", m.boss ? 24 : 8, 200);
  fx.push({ k: "ring", x: m.x, y: m.y, color: "#ffffff", life: 0.35, age: 0, r: m.r + 10 });
  fx.push({ k: "ring", x: m.x, y: m.y, color: col, life: 0.55, age: 0, r: m.r + 40 });
  for (const o of monsters.values()) {                  // 衝撃波で周りの敵がよろける
    const dx = o.x - m.x, dy = o.y - m.y, d = Math.hypot(dx, dy) || 1;
    if (d < 160) { o.kx += (dx / d) * 260; o.ky += (dy / d) * 260; }
  }
  const orbs = Math.min(10, 3 + Math.floor(m.lv / 2) + (m.boss ? 8 : 0));
  for (let i = 0; i < orbs; i++) {
    const a = Math.random() * 6.28, v = 120 + Math.random() * 220;
    fx.push({ k: "orb", x: m.x, y: m.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.8, age: 0 });
  }
  floater(m.x, m.y - m.r - 8, `+${gain} XP`, "#c9a7ff", 22, 1.1);
  ensureLore(m);
  if (m.lore && m.lore.last) floater(m.x, m.y - m.r - 34, m.lore.last, "#ffd866", 14, 1.5);
  const words = ["", "", "DOUBLE KILL", "TRIPLE KILL", "MULTI KILL", "MEGA KILL", "RAMPAGE"];
  if (streak.n >= 2) floater(hero.x, hero.y - 80, words[Math.min(streak.n, words.length - 1)], "#ffd866", 28, 1.2);
  hero.hp = Math.min(maxHpOf(before), hero.hp + maxHpOf(before) * 0.015);
  hitstop = Math.max(hitstop, m.boss ? 0.16 : 0.06);
  shake = Math.max(shake, m.boss ? 18 : 6);
  if (m.boss) { slowmo = 0.6; toast(`👑 ボス撃破！ ${m.entry.name}`); }
  sfx("kill");
  const after = heroLevel(save.xp);
  if (after > before) {
    hero.hp = maxHpOf(after);
    fx.push({ k: "ring", x: hero.x, y: hero.y, color: "#f0c75e", life: 1, age: 0, r: 120 });
    toast(`レベルアップ！ Lv.${after}`);
    sfx("level");
  }
}

// 回収待ちをまとめてごみ箱へ。本体が1回だけ確認を出す。やめた・失敗したら、全員が戻ってくる
async function flushPending() {
  if (flushing || !pending.length) return;
  flushing = true;
  const batch = pending.splice(0);
  const n = batch.length, size = batch.reduce((t, p) => t + p.size, 0);
  let ok = 0;
  try {
    const r = await ep.trash(batch.map((p) => p.entry), { from: screenRect(hero.x, hero.y, 30) });
    ok = Array.isArray(r.trashed) ? r.trashed.length : typeof r.trashed === "number" ? r.trashed : r.trashed ? n : 0;
  } catch (err) {
    if (err.code !== "denied") toast(`ごみ箱へ送れませんでした：${err.message}`);
  }
  if (ok > 0) {
    save.freed += Math.round((size * Math.min(ok, n)) / n);
    // 本体からフォルダの更新が届くまで、もう出さない（消えたファイルが一瞬よみがえらないように）
    setTimeout(() => { for (const p of batch) pendingKeys.delete(p.key); }, 4000);
    toast(`${ok} 体を討伐。${fmtSize(size)} を解放`);
  } else {
    save.xp = Math.max(0, save.xp - batch.reduce((t, p) => t + p.gain, 0));
    save.kills = Math.max(0, save.kills - n);
    for (const p of batch) pendingKeys.delete(p.key);
    refill = true;
    toast("ごみ箱へ送らなかったので、モンスターが戻ってきた");
  }
  ep.storage.set("hero", save).catch(() => {});
  flushing = false;
}

function faint() {
  Object.assign(hero, { x: W / 2, y: H - 110, hp: maxHpOf(heroLevel(save.xp)), goal: null, target: null, inv: 2 });
  bullets = [];
  combo = comboT = 0;
  toast("気絶した… 入り口に運ばれた");
}

// ---- 更新 -------------------------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function moveToward(o, tx, ty, speed, dt) {
  const dx = tx - o.x, dy = ty - o.y, d = Math.hypot(dx, dy);
  if (d < 1) return d;
  const step = Math.min(d, speed * dt);
  o.x += (dx / d) * step;
  o.y += (dy / d) * step;
  return d - step;
}

function enterDoor(d) {
  if (navigating) return;
  navigating = true;
  hero.goal = hero.target = null;
  const p = d.parent ? ep.navigateUp() : ep.open(d.entry, { from: screenRect(d.x + d.w / 2, d.y + d.h / 2, 30) });
  p.catch(() => {});
  setTimeout(() => (navigating = false), 1500);
}

function update(dt) {
  const now = nowS();
  const lv = heroLevel(save.xp), maxHp = maxHpOf(lv);
  hero.cd = Math.max(0, hero.cd - dt);
  hero.inv = Math.max(0, hero.inv - dt);
  hero.hurt += dt;
  hero.chainT = Math.max(0, hero.chainT - dt);
  hero.dashCd = Math.max(0, hero.dashCd - dt);
  hero.spinCd = Math.max(0, hero.spinCd - dt);
  if (hero.swing && (hero.swing.age += dt) >= hero.swing.life) hero.swing = null;
  if (hero.hurt > 3) hero.hp = Math.min(maxHp, hero.hp + maxHp * 0.02 * dt);
  fade = Math.max(0, fade - dt * 2);
  shake = Math.max(0, shake - dt * 30);
  comboT = Math.max(0, comboT - dt);
  if (comboT <= 0) combo = 0;

  // 向き：マウスを動かしているときはマウス、そうでなければ一番近い敵、いなければ進む向き
  const kx = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
  const ky = (keys.has("s") || keys.has("arrowdown") ? 1 : 0) - (keys.has("w") || keys.has("arrowup") ? 1 : 0);
  let aim = hero.face;
  if (now - mouse.at < 3) aim = Math.atan2(mouse.y - hero.y, mouse.x - hero.x);
  else {
    let near = null, nd = 280;
    for (const m of monsters.values()) {
      const d = Math.hypot(m.x - hero.x, m.y - hero.y);
      if (canAttack(m) && d < nd) { near = m; nd = d; }
    }
    if (near) aim = Math.atan2(near.y - hero.y, near.x - hero.x);
    else if (kx || ky) aim = Math.atan2(ky, kx);
  }
  if (hero.dashT <= 0) hero.face = aim;

  // 移動
  hero.moving = false;
  if (hero.dashT > 0) {
    hero.dashT -= dt;
    hero.x += hero.dashDx * DASH_SPEED * dt;
    hero.y += hero.dashDy * DASH_SPEED * dt;
    fx.push({ k: "ghost", x: hero.x, y: hero.y, life: 0.28, age: 0 });
    for (const m of [...monsters.values()]) {            // ダッシュで突き抜けた敵にも軽く当たる
      if (!canAttack(m) || hero.dashHit.has(m) || Math.hypot(m.x - hero.x, m.y - hero.y) > m.r + 30) continue;
      hero.dashHit.add(m);
      hurtMonster(m, Math.round(heroDmg() * 0.6), Math.atan2(hero.dashDy, hero.dashDx), 300, false);
    }
  } else if (kx || ky) {
    hero.goal = hero.goalDoor = null;
    const n = Math.hypot(kx, ky);
    hero.x += (kx / n) * HERO_SPEED * dt;
    hero.y += (ky / n) * HERO_SPEED * dt;
    hero.moving = true;
  } else if (hero.goal) {
    if (moveToward(hero, hero.goal.x, hero.goal.y, HERO_SPEED, dt) < 4) hero.goal = null;
    hero.moving = true;
  }
  hero.x += hero.kbx * dt;
  hero.y += hero.kby * dt;
  const hd = Math.max(0, 1 - 10 * dt);
  hero.kbx *= hd;
  hero.kby *= hd;
  hero.x = clamp(hero.x, WALL + 20, W - WALL - 20);
  hero.y = clamp(hero.y, WALL + 20, H - WALL - 24);

  if ((mouseDown || keys.has("j")) && hero.cd <= 0) slash(aim);

  // 扉：触れただけでは入らない。クリックした扉に着いたとき、または近くで F を押したときだけ入る
  hero.doorNear = null;
  let nearDist = 40;
  for (const d of parentDoor ? [...doors, parentDoor] : doors) {
    const dist = Math.hypot(Math.max(d.x - hero.x, 0, hero.x - (d.x + d.w)), Math.max(d.y - hero.y, 0, hero.y - (d.y + d.h)));
    if (dist < nearDist) { nearDist = dist; hero.doorNear = d; }
  }
  if (hero.goalDoor) {
    if (hero.doorNear === hero.goalDoor && nearDist < 6) { const d = hero.goalDoor; hero.goalDoor = null; enterDoor(d); }
    else if (!hero.goal) hero.goalDoor = null;
  }

  // モンスター
  const list = [...monsters.values()];
  let threat = false;
  for (const m of list) {
    m.age += dt;
    m.flash = Math.max(0, m.flash - dt);
    m.atk = Math.max(0, m.atk - dt);
    m.shot = Math.max(0, m.shot - dt);
    m.stun = Math.max(0, m.stun - dt);
    if (m.say && m.say.ttl < 900 && (m.say.ttl -= dt) <= 0) m.say = null;
    m.x += m.kx * dt;
    m.y += m.ky * dt;
    const decay = Math.max(0, 1 - 9 * dt);
    m.kx *= decay;
    m.ky *= decay;
    if (m.state !== "alive" || m.stun > 0) continue;
    const dh = Math.hypot(hero.x - m.x, hero.y - m.y), toHero = Math.atan2(hero.y - m.y, hero.x - m.x);
    if (m.charge > 0) {                                  // ボスの突進
      threat = true;
      m.charge -= dt;
      m.x += m.cdx * 640 * dt;
      m.y += m.cdy * 640 * dt;
      if (dh < m.r + 26) hurtHero(Math.round((3 + m.lv * 1.5) * 2), toHero);
      if (m.charge <= 0) { m.stun = 0.9; m.atk = 1.5; }  // 突進のあとは息切れ。ここが狙い目
      continue;
    }
    if (m.wind > 0) {                                    // 攻撃の予告中
      threat = true;
      m.wind -= dt;
      if (m.wind <= 0) strike(m);
      continue;
    }
    const hostile = s.counter && scanned && (m.lv >= lv - 4 || m.boss) && !m.ghost;
    if (hostile && dh < (m.boss ? 560 : 320)) {
      threat = true;
      const ranged = !m.boss && (m.cat === "code" || m.cat === "audio");
      const speed = 55 + Math.min(m.lv, 14) * 3;
      if (m.boss && m.atk <= 0) {
        m.windKind = dh < m.r + 70 ? "melee" : dh > 240 && Math.random() < 0.55 ? "charge" : "nova";
        m.wind = m.windMax = m.windKind === "charge" ? 0.9 : m.windKind === "nova" ? 0.7 : 0.55;
      } else if (!m.boss && !ranged && dh < m.r + 52 && m.atk <= 0) {
        m.windKind = "melee";
        m.wind = m.windMax = 0.55;
      } else if (ranged && m.shot <= 0 && dh > 140 && dh < 420) {
        m.windKind = "shot";
        m.wind = m.windMax = 0.45;
        m.shot = 2.5 + Math.random() * 1.5;
      } else if (ranged && dh < 200) {
        moveToward(m, m.x - Math.cos(toHero) * 100, m.y - Math.sin(toHero) * 100, speed, dt);   // 距離をとる
      } else if (dh > m.r + 30 && (!ranged || dh > 260)) {
        moveToward(m, hero.x, hero.y, speed, dt);
      }
    } else {
      m.think -= dt;
      if (m.think <= 0) {
        m.think = 1 + Math.random() * 2;
        const a = Math.random() * 6.28, v = m.boss ? 14 : 18 + Math.random() * 22;
        m.vx = Math.cos(a) * v;
        m.vy = Math.sin(a) * v;
        if (Math.random() < 0.3) m.vx = m.vy = 0;
      }
      m.x += m.vx * dt;
      m.y += m.vy * dt;
    }
  }
  // 重なりを離す
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, min = (a.r + b.r) * 0.8;
      if (d < min) {
        const push = (min - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
      }
    }
  }
  for (const m of list) {
    m.x = clamp(m.x, WALL + m.r, W - WALL - m.r);
    m.y = clamp(m.y, bandBottom + m.r + 10, H - WALL - m.r);
  }

  // 敵の弾
  for (const b of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.age += dt;
    if (Math.hypot(b.x - hero.x, b.y - hero.y) < 20 && hero.inv <= 0) { hurtHero(b.dmg, Math.atan2(b.vy, b.vx)); b.age = 99; }
    if (b.x < WALL || b.x > W - WALL || b.y < WALL || b.y > H - WALL) b.age = 99;
  }
  bullets = bullets.filter((b) => b.age < 6);

  // 倒した分の補充（奥に潜んでいた敵が出てくる）・部屋のクリア・回収の確認
  if (refill && now - lastRefill > 0.5 && folder) { refill = false; lastRefill = now; applyFolder(folder); }
  if (scanned && !sanctuary && killedHere > 0 && !cleared && monsters.size === 0 && !refill) {
    cleared = true;
    fx.push({ k: "banner", text: "ROOM CLEAR", life: 2.2, age: 0 });
    sfx("clear");
  }
  if (pending.length && !flushing) {
    const idle = now - lastKillAt;
    if ((cleared && idle > 0.8) || (!threat && idle > FLUSH_DELAY) || idle > 10) flushPending();
  }

  updateWeather(dt);

  // エフェクト
  for (const f of fx) {
    f.age += dt;
    if (f.k === "p") { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 420 * dt; }
    if (f.k === "t") f.y -= 40 * dt;
    if (f.k === "orb") {                                 // 経験値の玉：散らばってから、ヒーローに吸い寄せられる
      if (f.age < 0.3) {
        f.x += f.vx * dt; f.y += f.vy * dt;
        f.vx *= 0.92; f.vy *= 0.92;
      } else {
        const dx = hero.x - f.x, dy = hero.y - f.y, d = Math.hypot(dx, dy) || 1, sp = 500 + (f.age - 0.3) * 1600;
        f.x += (dx / d) * sp * dt;
        f.y += (dy / d) * sp * dt;
        if (d < 22) { f.age = f.life; if (now - lastCoin > 0.05) { lastCoin = now; sfx("coin"); } }
      }
    }
  }
  fx = fx.filter((f) => f.age < f.life);
}

// ---- 天気 ---------------------------------------------------------------------------
const drops = Array.from({ length: 160 }, () => ({ x: Math.random() * W, y: Math.random() * H, v: 0.7 + Math.random() * 0.6 }));
let flash = 0;
function updateWeather(dt) {
  if (!weather) return;
  const k = weather.kind;
  if (k === "rain" || k === "storm") {
    for (const d of drops) { d.y += 900 * d.v * dt; d.x -= 140 * d.v * dt; if (d.y > H) { d.y = -10; d.x = Math.random() * (W + 200); } }
  } else if (k === "snow") {
    for (const d of drops) { d.y += 55 * d.v * dt; d.x += Math.sin(d.y / 40 + d.v * 9) * 18 * dt; if (d.y > H) { d.y = -10; d.x = Math.random() * W; } }
  }
  flash = Math.max(0, flash - dt * 2.5);
  if (k === "storm" && Math.random() < 0.12 * dt) flash = 1;
}
function drawWeather() {
  if (!weather) return;
  const k = weather.kind;
  if (k === "rain" || k === "storm") {
    ctx.strokeStyle = "rgba(170,200,255,0.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const d of drops) { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - 4, d.y + 16); }
    ctx.stroke();
  } else if (k === "snow") {
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    for (const d of drops.slice(0, 100)) ctx.fillRect(d.x, d.y, 3 * d.v, 3 * d.v);
  } else if (k === "fog") {
    ctx.fillStyle = "rgba(200,210,225,0.13)";
    ctx.fillRect(0, 0, W, H);
  }
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flash * 0.35})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ---- 描画 ---------------------------------------------------------------------------
function fitText(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
  return text + "…";
}

function drawRoom(t) {
  ctx.fillStyle = sanctuary ? "#4a4527" : "#2b2740";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#15131d";
  ctx.fillRect(WALL, WALL, W - 2 * WALL, H - 2 * WALL);
  ctx.strokeStyle = "#1c1a27";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = WALL + 80; x < W - WALL; x += 80) { ctx.moveTo(x, bandBottom); ctx.lineTo(x, H - WALL); }
  for (let y = bandBottom + 80; y < H - WALL; y += 80) { ctx.moveTo(WALL, y); ctx.lineTo(W - WALL, y); }
  ctx.stroke();
  ctx.fillStyle = "#1e1a2c";
  ctx.fillRect(WALL, WALL, W - 2 * WALL, bandBottom - WALL);
  ctx.fillStyle = "#3a3456";
  ctx.fillRect(WALL, bandBottom, W - 2 * WALL, 2);

  ctx.font = `20px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let x = 160; x < W; x += 320) {
    ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 9 + x);
    ctx.fillText("🔥", x, WALL / 2);
    ctx.fillText("🔥", x, H - WALL / 2);
  }
  ctx.globalAlpha = 1;
}

function drawDoor(d, label, icon, hot) {
  ctx.fillStyle = hot ? "#6a4a2c" : "#4a3320";
  ctx.strokeStyle = hot ? "#e0a84e" : "#8a5a2b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(d.x, d.y, d.w, d.h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.font = `22px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.fillText(icon, d.x + d.w / 2, d.y + 20);
  ctx.font = `12px ${FONT}`;
  ctx.fillStyle = "#f3e3c8";
  ctx.fillText(fitText(label, d.w - 10), d.x + d.w / 2, d.y + d.h - 14);
}

function drawMonster(m, t) {
  const sp = SPECIES[m.cat];
  const pop = Math.min(1, m.age / 0.35), sc = 1 + 0.25 * Math.sin(pop * Math.PI) * (1 - pop) * 3 * pop;
  const bob = Math.sin(t * 3 + m.ph) * (m.ghost ? 6 : 3), lift = m.ghost ? -10 : 0;
  const cx = m.x, cy = m.y + bob + lift;
  const face = m.img && m.img.complete && m.img.naturalWidth ? m.img : avatarOf(m);
  ctx.save();
  ctx.globalAlpha = (m.ghost ? 0.6 : 1) * (m.state === "judging" ? 0.6 : 1) * (m.stale ? 1 : 0.88);
  ctx.translate(cx, cy);
  ctx.scale(pop < 1 ? sc * pop : 1, pop < 1 ? sc * pop : 1);

  // 影
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(0, m.r - lift * 0.5, m.r * 0.8, m.r * 0.25, 0, 0, 6.28);
  ctx.fill();

  // 本体の円
  const col = m.flash > 0 ? "#ffffff" : m.stale ? tierColor(m.lv) : "#4a8c5c";
  ctx.beginPath();
  ctx.arc(0, 0, m.r, 0, 6.28);
  ctx.fillStyle = m.ghost ? "rgba(160,200,255,0.25)" : "rgba(30,26,44,0.9)";
  ctx.fill();
  if (face) {
    ctx.save();
    ctx.clip();
    const k = Math.max((m.r * 2) / face.naturalWidth, (m.r * 2) / face.naturalHeight);
    ctx.drawImage(face, (-face.naturalWidth * k) / 2, (-face.naturalHeight * k) / 2, face.naturalWidth * k, face.naturalHeight * k);
    ctx.restore();
    ctx.font = `${Math.max(14, m.r * 0.6)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.fillText(sp.emoji, m.r * 0.6, -m.r * 0.6);
  } else {
    ctx.font = `${m.r * 1.25}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(sp.emoji, 0, 2);
  }
  ctx.beginPath();
  ctx.arc(0, 0, m.r, 0, 6.28);
  ctx.lineWidth = m.boss ? 5 : 3;
  ctx.strokeStyle = hover && hover.monster === m ? "#ffffff" : col;
  ctx.stroke();
  if (m.boss) {
    ctx.font = `28px ${FONT}`;
    ctx.fillText("👑", 0, -m.r - 8);
  }
  if (m.stun > 0 || m.wind > 0) {
    ctx.font = `${m.boss ? 30 : 22}px ${FONT}`;
    ctx.fillText(m.wind > 0 ? "❗" : "💫", 0, -m.r - (m.boss ? 40 : 14));
  }
  ctx.restore();

  // HP バー・名前
  ctx.save();
  ctx.globalAlpha = m.ghost ? 0.8 : 1;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (m.hp < m.maxHp) {
    const w = Math.max(40, m.r * 2);
    ctx.fillStyle = "#0b0a10";
    ctx.fillRect(cx - w / 2 - 1, cy - m.r - 14, w + 2, 8);
    ctx.fillStyle = "#e5484d";
    ctx.fillRect(cx - w / 2, cy - m.r - 13, w * Math.max(0, m.hp / m.maxHp), 6);
  }
  ctx.font = `12px ${FONT}`;
  const label = fitText(m.stale ? `Lv${m.lv} ${m.entry.name}` : m.entry.name, 150);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(label, cx, cy + m.r + 14);
  ctx.fillStyle = !m.stale ? "#9fd8ae" : m.ghost ? "#a9c7ff" : "#e6e1f5";
  ctx.fillText(label, cx, cy + m.r + 14);
  if (m.lore && m.stale && (hover && hover.monster === m || hero.target === m)) {
    ctx.fillStyle = "#f0c75e";
    ctx.strokeText(m.lore.title, cx, cy + m.r + 29);
    ctx.fillText(m.lore.title, cx, cy + m.r + 29);
  }
  if (m.state === "judging" && !m.say) {
    ctx.fillStyle = "#ffd866";
    ctx.fillText("判決待ち…", cx, cy - m.r - 18);
  }
  if (m.say) {
    ctx.font = `13px ${FONT}`;
    const text = fitText(m.say.text, 240), w = ctx.measureText(text).width + 20, by = cy - m.r - (m.hp < m.maxHp ? 46 : 34);
    ctx.fillStyle = "rgba(250,246,232,0.95)";
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, by - 14, w, 26, 8);
    ctx.moveTo(cx - 6, by + 12);
    ctx.lineTo(cx, by + 20);
    ctx.lineTo(cx + 6, by + 12);
    ctx.fill();
    ctx.fillStyle = "#2a2233";
    ctx.fillText(text, cx, by);
  }
  ctx.restore();
}

function drawHero(t) {
  const blink = hero.inv > 0 && hero.dashT <= 0 && Math.floor(t * 12) % 2 === 0;
  ctx.save();
  ctx.globalAlpha = blink ? 0.4 : hero.dashT > 0 ? 0.6 : 1;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(hero.x, hero.y + 22, 20, 7, 0, 0, 6.28);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";            // 狙いの向き
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(hero.x, hero.y, 48, hero.face - 0.4, hero.face + 0.4);
  ctx.stroke();
  ctx.font = `42px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🧙", hero.x, hero.y + Math.sin(t * 14) * (hero.moving ? 3 : 0.5));
  ctx.restore();
}

function drawSwing() {
  const w = hero.swing;
  if (!w) return;
  const k = w.age / w.life, a0 = w.a - w.arc / 2, a1 = a0 + w.arc * Math.min(1, k * 1.8);
  ctx.save();
  ctx.translate(hero.x, hero.y);
  ctx.lineCap = "round";
  ctx.globalAlpha = (1 - k) * 0.45;
  ctx.strokeStyle = w.fin ? "#ffb347" : "#9ad1ff";
  ctx.lineWidth = w.fin ? 30 : 20;
  ctx.beginPath();
  ctx.arc(0, 0, w.r * 0.8, a0, a1);
  ctx.stroke();
  ctx.globalAlpha = 1 - k;
  ctx.strokeStyle = w.fin ? "#fff2c4" : "#ffffff";
  ctx.lineWidth = w.fin ? 10 : 6;
  ctx.beginPath();
  ctx.arc(0, 0, w.r * 0.8, Math.max(a0, a1 - 1.2), a1);
  ctx.stroke();
  ctx.restore();
}

// 敵の攻撃の予告（赤い範囲）。ここから逃げれば当たらない
function drawTelegraph(m) {
  if (!(m.wind > 0)) return;
  const p = 1 - m.wind / m.windMax, toHero = Math.atan2(hero.y - m.y, hero.x - m.x);
  ctx.save();
  ctx.lineCap = "butt";
  if (m.windKind === "melee") {
    const R = m.r + 62;
    ctx.fillStyle = `rgba(255,70,70,${0.08 + p * 0.1})`;
    ctx.strokeStyle = `rgba(255,100,100,${0.5 + p * 0.4})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(m.x, m.y, R, 0, 6.28);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `rgba(255,70,70,${0.25 + p * 0.25})`;
    ctx.beginPath();
    ctx.arc(m.x, m.y, R * p, 0, 6.28);
    ctx.fill();
  } else if (m.windKind === "nova") {
    ctx.strokeStyle = `rgba(255,157,92,${0.4 + p * 0.5})`;
    ctx.lineWidth = 3 + p * 6;
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r + 10 + p * 50, 0, 6.28);
    ctx.stroke();
  } else {
    const len = m.windKind === "charge" ? 520 : 420, width = m.windKind === "charge" ? m.r * 1.6 : 3;
    ctx.strokeStyle = `rgba(255,70,70,${0.12 + p * 0.3})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(m.x + Math.cos(toHero) * len, m.y + Math.sin(toHero) * len);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBullets(t) {
  for (const b of bullets) {
    ctx.fillStyle = "rgba(255,120,80,0.35)";
    ctx.beginPath();
    ctx.arc(b.x, b.y, 12 + Math.sin(t * 20) * 1.5, 0, 6.28);
    ctx.fill();
    ctx.fillStyle = "#ffd2a8";
    ctx.beginPath();
    ctx.arc(b.x, b.y, 6, 0, 6.28);
    ctx.fill();
  }
}

function drawFx() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const f of fx) {
    const k = f.age / f.life;
    if (f.k === "p") {
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = f.color;
      ctx.fillRect(f.x - f.size / 2, f.y - f.size / 2, f.size, f.size);
    } else if (f.k === "t") {
      ctx.globalAlpha = 1 - k * k;
      ctx.font = `bold ${f.size}px ${FONT}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    } else if (f.k === "ring") {
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * (0.6 + k), 0, 6.28);
      ctx.stroke();
    } else if (f.k === "ghost") {
      ctx.globalAlpha = 0.45 * (1 - k);
      ctx.font = `42px ${FONT}`;
      ctx.fillText("🧙", f.x, f.y);
    } else if (f.k === "spin") {
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = "#9ad1ff";
      ctx.lineWidth = 16 * (1 - k) + 2;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * (0.3 + 0.7 * Math.sqrt(k)), 0, 6.28);
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = k * 14 + (i * 6.28) / 3;
        ctx.moveTo(f.x + Math.cos(a) * f.r * 0.25, f.y + Math.sin(a) * f.r * 0.25);
        ctx.arc(f.x, f.y, f.r * (0.3 + 0.7 * Math.sqrt(k)) * 0.92, a, a + 1.1);
      }
      ctx.stroke();
    } else if (f.k === "orb") {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#c9a7ff";
      ctx.beginPath();
      ctx.arc(f.x, f.y, 5, 0, 6.28);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(f.x, f.y, 2, 0, 6.28);
      ctx.fill();
    } else if (f.k === "banner") {
      const a = k < 0.15 ? k / 0.15 : k > 0.75 ? (1 - k) / 0.25 : 1;
      ctx.globalAlpha = a;
      ctx.font = `italic bold ${64 + (1 - a) * 20}px ${FONT}`;
      ctx.lineWidth = 8;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(f.text, W / 2, H / 2 - 60);
      ctx.fillStyle = "#ffd866";
      ctx.fillText(f.text, W / 2, H / 2 - 60);
    }
  }
  ctx.globalAlpha = 1;
}

// 画面に重ねる表示：コンボ・技のクールダウン・回収待ち
function drawOverlay() {
  ctx.textBaseline = "middle";
  if (combo >= 2) {
    const size = 30 + Math.min(combo, 50) * 0.5, x = W - 48, y = bandBottom + 56;
    ctx.textAlign = "right";
    ctx.font = `italic bold ${size}px ${FONT}`;
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.fillStyle = `hsl(${Math.max(0, 52 - combo * 1.2)} 100% 62%)`;
    ctx.strokeText(`${combo} HIT`, x, y);
    ctx.fillText(`${combo} HIT`, x, y);
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`XP ×${comboMul().toFixed(2)}`, x, y + size * 0.72);
    ctx.fillStyle = "#ffd866";
    ctx.fillRect(x - 160 * (comboT / COMBO_WINDOW), y + size * 0.72 + 14, 160 * (comboT / COMBO_WINDOW), 4);
  }
  [{ icon: "⚡", key: "Shift", cd: hero.dashCd, max: DASH_CD }, { icon: "🌀", key: "Q", cd: hero.spinCd, max: SPIN_CD }].forEach((o, i) => {
    const x = 70 + i * 64, y = H - 70, r = 22;
    ctx.fillStyle = "rgba(11,10,16,0.75)";
    ctx.strokeStyle = o.cd > 0 ? "#3a3456" : "#9ad1ff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.28);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = "#fff";
    ctx.fillText(o.icon, x, y + 1);
    if (o.cd > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, r, -1.5708, -1.5708 + 6.28318 * (o.cd / o.max));
      ctx.fill();
    }
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillStyle = "#9a95b5";
    ctx.fillText(o.key, x, y + r + 12);
  });
  if (pending.length || flushing) {
    const sum = pending.reduce((t, p) => t + p.size, 0);
    ctx.textAlign = "right";
    ctx.font = `bold 16px ${FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = "#e6e1f5";
    const line = flushing ? "🗑 ごみ箱の確認中…" : `🗑 回収待ち ${pending.length} 体 ・ ${fmtSize(sum)}`;
    ctx.strokeText(line, W - 40, H - 62);
    ctx.fillText(line, W - 40, H - 62);
    if (!flushing) {
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = "#9a95b5";
      ctx.fillText("戦いが落ち着くか、E で、まとめて確認が出ます", W - 40, H - 42);
    }
  }
}

function draw(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0b0a10";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2);

  drawRoom(t);
  const hot = (d) => (hover && hover.door === d) || hero.doorNear === d;
  for (const d of doors) drawDoor(d, d.entry.name, "📁", hot(d));
  if (parentDoor) drawDoor(parentDoor, "上の階層へ", "⬆️", hot(parentDoor));
  if (hero.doorNear) {                                   // 「F で入れる」の目印
    const d = hero.doorNear;
    ctx.fillStyle = "#ffd866";
    ctx.beginPath();
    ctx.arc(d.x + d.w - 12, d.y + 12, 11, 0, 6.28);
    ctx.fill();
    ctx.fillStyle = "#2a2233";
    ctx.font = `bold 13px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("F", d.x + d.w - 12, d.y + 13);
  }

  for (const m of monsters.values()) drawTelegraph(m);
  const sorted = [...monsters.values()].sort((a, b) => a.y - b.y);
  let heroDrawn = false;
  for (const m of sorted) {
    if (!heroDrawn && m.y > hero.y) { drawHero(t); heroDrawn = true; }
    drawMonster(m, t);
  }
  if (!heroDrawn) drawHero(t);
  drawSwing();
  drawBullets(t);
  drawFx();
  drawWeather();

  // 暗がり（夜と曇り・雨・雪は少し暗い）
  const night = weather && weather.night, dim = weather && ["rain", "storm", "snow"].includes(weather.kind);
  const g = ctx.createRadialGradient(hero.x, hero.y, night ? 100 : 140, hero.x, hero.y, 760);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${0.55 + (night ? 0.2 : 0) + (dim ? 0.08 : 0)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (hero.hp < maxHpOf(heroLevel(save.xp)) * 0.3) {           // ピンチのときは画面の縁が赤くなる
    const r = ctx.createRadialGradient(W / 2, H / 2, 300, W / 2, H / 2, 760);
    r.addColorStop(0, "rgba(200,0,0,0)");
    r.addColorStop(1, `rgba(200,0,0,${0.25 + 0.1 * Math.sin(t * 8)})`);
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, W, H);
  }
  drawOverlay();
  if (fade > 0) {
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

let hudText = "";
function drawHud() {
  const lv = heroLevel(save.xp), maxHp = maxHpOf(lv);
  const lo = xpFor(lv), hi = xpFor(lv + 1);
  const key = [lv, Math.round(hero.hp), save.xp, save.kills, save.freed].join("|");
  if (key === hudText) return;
  hudText = key;
  $("lv").textContent = `🧙 Lv.${lv}`;
  $("hp").querySelector("i").style.width = `${(Math.max(0, hero.hp) / maxHp) * 100}%`;
  $("hp").querySelector("b").textContent = `HP ${Math.max(0, Math.round(hero.hp))}/${maxHp}`;
  $("xp").querySelector("i").style.width = `${((save.xp - lo) / (hi - lo)) * 100}%`;
  $("xp").querySelector("b").textContent = `XP ${save.xp - lo}/${hi - lo}`;
  $("stats").textContent = `討伐 ${save.kills} 体 ／ 解放 ${fmtSize(save.freed) || "0 B"}`;
}

let last = performance.now();
function frame(now) {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (hitstop > 0) { hitstop -= dt; dt *= 0.08; }          // 当たった瞬間の一瞬の止まり
  else if (slowmo > 0) { slowmo -= dt; dt *= 0.35; }       // ボスを倒したときのスロー
  update(dt);
  draw(now / 1000);
  drawHud();
  requestAnimationFrame(frame);
}

// ---- 入力 -----------------------------------------------------------------------------
function pick(p) {
  for (const m of [...monsters.values()].sort((a, b) => b.y - a.y)) {
    if (Math.hypot(p.x - m.x, p.y - m.y) <= m.r + 6) return { monster: m };
  }
  for (const d of [...doors, parentDoor]) {
    if (d && p.x > d.x && p.x < d.x + d.w && p.y > d.y && p.y < d.y + d.h) return { door: d };
  }
  return null;
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", async (e) => {
  const p = toWorld(e), hit = pick(p);
  mouse = { x: p.x, y: p.y, at: nowS() };
  if (e.button === 2) {
    const entry = hit && (hit.monster ? hit.monster.entry : hit.door.entry);
    if (entry) await ep.showMenu({ x: e.clientX, y: e.clientY, items: [entry] }).catch(() => {});
    return;
  }
  if (e.button !== 0) return;
  if (hit && hit.door) {                                 // 扉はクリックで歩いていく
    hero.goal = { x: hit.door.x + hit.door.w / 2, y: hit.door.y + hit.door.h / 2 };
    hero.goalDoor = hit.door;
    return;
  }
  hero.goal = hero.goalDoor = null;
  mouseDown = true;                                      // 押している間、斬り続ける
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
});
const releaseMouse = () => (mouseDown = false);
window.addEventListener("pointerup", releaseMouse);
window.addEventListener("pointercancel", releaseMouse);
canvas.addEventListener("lostpointercapture", releaseMouse);
canvas.addEventListener("pointermove", (e) => {
  const p = toWorld(e);
  mouse = { x: p.x, y: p.y, at: nowS() };
  if (!(e.buttons & 1)) mouseDown = false;               // 離したのを取りこぼしても、斬りっぱなしにならない
  hover = pick(p);
  canvas.style.cursor = hover && hover.door ? "pointer" : "crosshair";
  if (hover && hover.monster) {
    const m = hover.monster, sp = SPECIES[m.cat];
    status(`${sp.emoji} ${sp.name}${m.ghost ? "（亡霊）" : ""}${m.boss ? "（ボス）" : ""} Lv.${m.lv}　${m.entry.name}　${fmtSize(m.entry.size)}　${fmtIdle(m.idle)}未使用`);
  } else if (hover && hover.door && hover.door.entry) {
    status(`📁 ${hover.door.entry.name}　（クリックで歩いて入る／近くで F）`);
  }
});
canvas.addEventListener("pointerleave", () => { hover = null; mouseDown = false; });

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "j"].includes(k)) {
    keys.add(k);
    e.preventDefault();
  } else if (k === " " || k === "shift") {
    e.preventDefault();
    if (!e.repeat) dash();
  } else if (k === "q") {
    if (!e.repeat) spin();
  } else if (k === "e") {
    if (!e.repeat) flushPending();
  } else if (k === "f") {
    if (!e.repeat && hero.doorNear) enterDoor(hero.doorNear);
  } else if (k === "backspace") {
    e.preventDefault();
    if (!e.repeat && parentDoor) enterDoor(parentDoor);
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => { keys.clear(); mouseDown = false; });

// ---- コマンド ----------------------------------------------------------------------------
// 冒険日誌：このフォルダの様子を AI に書いてもらう
const paper = $("paper");
const closePaper = () => (paper.hidden = true);
function showPaper(title, text) {
  paper.innerHTML = "<button>閉じる</button><h3></h3><p></p>";
  paper.querySelector("h3").textContent = title;
  paper.querySelector("p").textContent = text;
  paper.querySelector("button").onclick = closePaper;
  paper.hidden = false;
}
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closePaper(); });

async function writeJournal() {
  if (!s.llm || !s.apiKey) return toast("設定で Anthropic の API キーを入れると、冒険日誌が書けます");
  if (!folder) return;
  const stale = [...monsters.values()].filter((m) => m.stale).sort((a, b) => b.entry.size - a.entry.size);
  const info = {
    folder: folder.name,
    heroLevel: heroLevel(save.xp),
    defeatedTotal: save.kills,
    freedTotal: fmtSize(save.freed) || "0 B",
    targets: stale.length,
    doors: doors.length,
    biggest: stale.slice(0, 12).map((m) => ({ name: m.entry.name, species: SPECIES[m.cat].name, size: fmtSize(m.entry.size), unusedFor: fmtIdle(m.idle) })),
  };
  showPaper(`${folder.name} の冒険日誌`, "書いています…");
  try {
    showPaper(`${folder.name} の冒険日誌`, await net.journal(info));
    llmFails = 0;
  } catch (err) {
    closePaper();
    llmFailed(err);
    toast("日誌を書けませんでした");
  }
}

await ep.commands.set([
  { id: "journal", label: "冒険日誌を書く", hint: "AI" },
  { id: "shuffle", label: "モンスターを並べ直す" },
  { id: "reset", label: "ヒーローをリセット", hint: "レベル・討伐数を消す" },
]);
ep.onCommand(async (id) => {
  if (id === "journal") return writeJournal();
  if (id === "shuffle") {
    for (const m of monsters.values()) Object.assign(m, spawnPos(m.r));
  } else if (id === "reset") {
    if (!(await ep.ui.confirm("ヒーローのレベルと討伐の記録を消しますか？（ファイルには影響しません）", { okLabel: "消す" }))) return;
    save = { xp: 0, kills: 0, freed: 0 };
    hero.hp = maxHpOf(1);
    await ep.storage.set("hero", save);
  }
});

loadWeather();
ep.onFolder(applyFolder);
requestAnimationFrame(frame);
