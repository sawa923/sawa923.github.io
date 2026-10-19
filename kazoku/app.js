import { firebaseConfig } from "./config.js";

const $ = (id) => document.getElementById(id);
const views = ["view-setup", "view-login", "view-denied", "view-app"];
function show(view) {
  for (const v of views) $(v).hidden = v !== view;
}

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("ここに")) {
  show("view-setup");
  throw new Error("Firebase の設定がまだ貼り付けられていません");
}

const SDK = "https://www.gstatic.com/firebasejs/10.14.1";
const { initializeApp } = await import(`${SDK}/firebase-app.js`);
const {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
  setPersistence, browserLocalPersistence,
} = await import(`${SDK}/firebase-auth.js`);
const {
  getFirestore, collection, doc, addDoc, setDoc, deleteDoc, getDocs,
  onSnapshot, query, where, orderBy, limit, serverTimestamp,
} = await import(`${SDK}/firebase-firestore.js`);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// ブラウザを閉じてもログインしたままにする
await setPersistence(auth, browserLocalPersistence).catch(() => {});
const db = getFirestore(app);

let members = [];      // [{ email, name }]
let myName = "";
let unsubscribers = [];

// 前回ログインしたアドレスを覚えておき、Google の画面であらかじめ入れておく
const LAST_EMAIL_KEY = "wagaya-last-email";
function lastEmail() {
  try { return localStorage.getItem(LAST_EMAIL_KEY) || ""; } catch { return ""; }
}

$("login").onclick = async () => {
  $("login-error").hidden = true;
  const provider = new GoogleAuthProvider();
  const hint = lastEmail();
  if (hint) provider.setCustomParameters({ login_hint: hint });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    $("login-error").textContent = "ログインできませんでした（" + e.code + "）";
    $("login-error").hidden = false;
  }
};
$("logout").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  if (unwatchMonth) { unwatchMonth(); unwatchMonth = null; }

  if (!user) {
    $("user-box").hidden = true;
    show("view-login");
    return;
  }
  $("user-box").hidden = false;
  $("user-name").textContent = user.displayName || user.email;
  try { localStorage.setItem(LAST_EMAIL_KEY, user.email); } catch {}

  // 家族の名簿が読めるかどうかで、登録済みかを判定する
  try {
    const snap = await getDocs(collection(db, "members"));
    members = snap.docs.map((d) => ({ email: d.id, name: d.data().name || d.id }));
  } catch (e) {
    $("denied-email").textContent = user.email;
    show("view-denied");
    return;
  }
  myName = members.find((m) => m.email === user.email)?.name || user.displayName || user.email;
  $("user-name").textContent = myName;
  $("log-date").value = today();
  show("view-app");
  selectTab(currentTab);
  watchSettings();
  watchMonth();
  scrollToToday();
  watchLogs(user);
});

// ---- カテゴリ（家事など）の月ごとの表 ----
// カテゴリと項目の設定は chores/_settings に保存する（Firestore のルールを変えずに済むように
// chores コレクションの決まりである title と done も持たせる）。
// チェック1つ = chores の文書1つ。家事は「日付_項目」、ほかは「日付_カテゴリ_項目」が ID。
const DEFAULT_CATEGORIES = [{
  id: "kaji",
  name: "家事",
  items: [
    { key: "toilet", name: "トイレ掃除" },
    { key: "bath", name: "お風呂掃除" },
    { key: "entrance", name: "玄関掃除" },
    { key: "mop", name: "モップ掛け" },
    { key: "vacuum", name: "床掃除機" },
    { key: "trash", name: "ゴミ出し" },
  ],
}, {
  // type: "text" はマスに文字を書き込む表（予定表など）
  id: "yotei",
  name: "予定",
  type: "text",
  items: [
    { key: "taku", name: "たく" },
    { key: "ayu", name: "あゆ" },
    { key: "note", name: "備考" },
  ],
}, {
  // type: "weight" は体重の表とグラフ（書き込めるのは WEIGHT_OWNER だけ）
  id: "weight",
  name: "体重",
  type: "weight",
  items: [],
}];
const SETTINGS_VERSION = 3;   // 2 で「予定」、3 で「体重」を追加
const WEIGHT_OWNER = "たく";
// 列ごとの文字色（列の名前で決める）
const COLUMN_COLORS = { "たく": "blue", "あゆ": "pink" };
// チェックした人ごとの✓の色（チェックした人の名前で決める）
const CHECK_COLORS = { "たく": "green" };
const colorClass = (item) => COLUMN_COLORS[item.name] ? ` color-${COLUMN_COLORS[item.name]}` : "";
const WEEKDAYS = "日月火水木金土";
const settingsRef = () => doc(db, "chores", "_settings");

let categories = DEFAULT_CATEGORIES;
let currentTab = "kaji";   // カテゴリの id か "logs"
let month = new Date();    // 表示中の月（日付は使わない）
month.setDate(1);
let checks = new Map();    // 文書 ID → { by }
let unwatchMonth = null;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const currentCategory = () => categories.find((c) => c.id === currentTab);
const checkId = (cat, date, item) => cat.id === "kaji" ? `${date}_${item.key}` : `${date}_${cat.id}_${item.key}`;

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function watchSettings() {
  unsubscribers.push(onSnapshot(settingsRef(), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    let saved = data.categories;
    // 古い設定には、あとから増えたタブを足す（一度保存したあとは消しても戻らない）
    for (const [id, version] of [["yotei", 2], ["weight", 3]]) {
      if (saved && (data.version || 1) < version && !saved.some((c) => c.id === id)) {
        saved = [...saved, DEFAULT_CATEGORIES.find((c) => c.id === id)];
      }
    }
    categories = saved && saved.length ? saved : DEFAULT_CATEGORIES;
    if (currentTab !== "logs" && !currentCategory()) currentTab = categories[0].id;
    renderTabs();
    renderGrid();
    renderEditor();
  }));
}

function saveCategories(next) {
  return setDoc(settingsRef(), { title: "設定", done: false, version: SETTINGS_VERSION, categories: next });
}

// ---- タブ ----
function renderTabs() {
  const nav = $("tabs");
  nav.replaceChildren();
  const add = (label, id, extra = "") => {
    const b = document.createElement("button");
    b.className = "tab" + extra + (id === currentTab ? " active" : "");
    b.textContent = label;
    b.onclick = () => selectTab(id);
    nav.append(b);
    return b;
  };
  for (const c of categories) add(c.name, c.id);
  add("記録", "logs");
  const plus = document.createElement("button");
  plus.className = "tab add-tab";
  plus.textContent = "＋";
  plus.setAttribute("aria-label", "カテゴリを追加");
  plus.onclick = addCategory;
  nav.append(plus);
}

function selectTab(id) {
  currentTab = id;
  $("tab-grid").hidden = id === "logs";
  $("tab-logs").hidden = id !== "logs";
  setEditor(false);
  renderTabs();
  if (id !== "logs") { renderGrid(); renderEditor(); scrollToToday(); }
}

async function addCategory() {
  const name = prompt("追加するカテゴリの名前（例：買い物、ペット）")?.trim();
  if (!name) return;
  const cat = { id: newId(), name: name.slice(0, 30), items: [] };
  await saveCategories([...categories, cat]);
  selectTab(cat.id);
  setEditor(true);
  $("item-name").focus();
}

// ---- 表 ----
function watchMonth() {
  if (unwatchMonth) unwatchMonth();
  const y = month.getFullYear(), m = month.getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  $("month-label").textContent = `${y}年${m}月`;
  // 体重の前日比のため、前の月の分も読み込む
  const prev = new Date(y, m - 2, 1);
  const q = query(collection(db, "chores"),
    where("date", ">=", ymd(prev.getFullYear(), prev.getMonth() + 1, 1)), where("date", "<=", ymd(y, m, days)));
  checks = new Map();
  renderGrid();
  unwatchMonth = onSnapshot(q, (snap) => {
    checks = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderGrid();
  });
}

let renderPending = false;

function renderGrid() {
  const cat = currentCategory();
  if (!cat) return;
  // 書き込み中のマスを消さないよう、入力が終わるまで描き直しを待つ
  if (document.activeElement?.matches(".weight-input")) { renderPending = true; return; }
  renderPending = false;
  const isText = cat.type === "text";
  const isWeight = cat.type === "weight";
  const canWeigh = myName === WEIGHT_OWNER;
  $("grid").classList.toggle("text-grid", isText);
  $("grid").classList.toggle("weight-grid", isWeight);
  $("hint-text").textContent = isWeight
    ? (canWeigh ? "体重を入れるとグラフと前日比が出ます。ほかの場所を押すと保存されます。" : `${WEIGHT_OWNER}の体重です（見るだけ）。`)
    : isText
    ? "「＋」で予定を足せます（時刻は入れなくてもOK）。予定を押すと直したり消したりできます。"
    : planMode
      ? "予定を入れるモードです。マスを押すと○が付きます。もう一度押すと外れます。"
      : "終わったらマスを押すとチェックが付きます。もう一度押すと外れます。";
  $("plan-toggle").hidden = isText || isWeight;
  $("edit-toggle").hidden = isWeight;
  $("weight-chart").hidden = !isWeight;
  const y = month.getFullYear(), m = month.getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  const todayStr = today();
  $("no-items").hidden = isWeight || cat.items.length > 0;
  const weights = isWeight ? weightSeries() : null;

  const head = $("grid-head");
  head.replaceChildren();
  const tr = document.createElement("tr");
  for (const [label, cls] of [["日付", "col-date"], ["曜日", "col-wd"]]) {
    const th = document.createElement("th");
    th.className = cls;
    th.textContent = label;
    tr.append(th);
  }
  for (const label of isWeight ? ["体重", "前日比"] : []) {
    const th = document.createElement("th");
    th.className = "text-head";
    th.textContent = label;
    tr.append(th);
  }
  for (const item of cat.items) {
    const th = document.createElement("th");
    if (isText) {
      th.className = "text-head" + colorClass(item);
      th.textContent = item.name;
    } else {
      th.className = "chore-head";
      const span = document.createElement("span");
      span.textContent = item.name;
      th.append(span);
    }
    tr.append(th);
  }
  head.append(tr);

  const body = $("grid-body");
  body.replaceChildren();
  for (let d = 1; d <= days; d++) {
    const date = ymd(y, m, d);
    const wd = new Date(y, m - 1, d).getDay();
    const row = document.createElement("tr");
    if (wd === 0) row.classList.add("sun");
    if (wd === 6) row.classList.add("sat");
    if (date === todayStr) row.classList.add("today");

    const dateCell = document.createElement("th");
    dateCell.textContent = `${m}月${d}日`;
    const wdCell = document.createElement("td");
    wdCell.className = "wd";
    wdCell.textContent = `(${WEEKDAYS[wd]})`;
    row.append(dateCell, wdCell);
    if (isWeight) {
      row.append(...weightCells(date, weights, canWeigh, `${m}月${d}日`));
      body.append(row);
      continue;
    }

    for (const item of cat.items) {
      const id = checkId(cat, date, item);
      const done = checks.get(id);
      const cell = document.createElement("td");
      if (isText) {
        cell.append(entryCell(id, date, cat, item, done, `${m}月${d}日 ${item.name}`));
        row.append(cell);
        continue;
      }
      const btn = document.createElement("button");
      // done が false の文書は「予定」の○（チェックとしては数えない）。
      // 繰り返し設定のある項目は、本日以降の空いたマスに自動で○を出す（skip の文書は手で消した印）
      const auto = date >= todayStr && repeatMatches(item.repeat, date);
      const checked = done?.done === true;
      const planned = !checked && (done ? !done.skip : auto);
      btn.className = "cell"
        + (checked ? " done" + (CHECK_COLORS[done.by] ? ` by-${CHECK_COLORS[done.by]}` : "") : "")
        + (planned ? " planned" : "");
      btn.setAttribute("aria-label", `${m}月${d}日 ${item.name}`
        + (checked ? `（${done.by}）` : planned ? "（予定）" : ""));
      if (checked || planned) {
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = planned ? "○" : "✓";
        btn.append(mark);
        // ○（予定）には名前を出さない
        if (checked) {
          const by = document.createElement("span");
          by.className = "by";
          by.textContent = done.by;
          btn.append(by);
        }
      }
      btn.onclick = () => toggleCheck(id, date, cat, item, { checked, planned, auto });
      cell.append(btn);
      row.append(cell);
    }
    body.append(row);
  }
  if (isWeight) renderWeightChart(weights, y, m, days);
}

// ---- 体重 ----
// 1日1件、chores の「日付_weight」に kg を数値で保存する
const weightId = (date) => `${date}_weight`;

// 読み込んだ範囲（前の月から表示中の月まで）の体重を日付順に並べる
function weightSeries() {
  return [...checks.values()]
    .filter((x) => x.cat === "weight" && typeof x.kg === "number")
    .map((x) => ({ date: x.date, kg: x.kg }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const fmtKg = (kg) => kg.toFixed(1);

function weightCells(date, weights, canWeigh, label) {
  const idx = weights.findIndex((w) => w.date === date);
  const here = weights[idx];
  // 前日比は、その前に記録した日との差
  const before = idx > 0 ? weights[idx - 1] : null;
  const kgCell = document.createElement("td");
  if (canWeigh) {
    const input = document.createElement("input");
    input.className = "weight-input";
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "0.1";
    input.min = "20";
    input.max = "300";
    input.value = here ? fmtKg(here.kg) : "";
    input.setAttribute("aria-label", `${label}の体重（kg）`);
    input.addEventListener("blur", () => setTimeout(() => {
      const v = input.value.trim();
      const kg = Math.round(Number(v) * 10) / 10;
      if (!v) {
        if (here) deleteDoc(doc(db, "chores", weightId(date)));
      } else if (kg >= 20 && kg <= 300 && kg !== here?.kg) {
        setDoc(doc(db, "chores", weightId(date)), {
          title: "体重", cat: "weight", key: "kg", date, done: true, kg, by: myName, createdAt: serverTimestamp(),
        });
      }
      if (renderPending) renderGrid();
    }, 0));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = "kg";
    kgCell.append(input, unit);
  } else if (here) {
    kgCell.textContent = `${fmtKg(here.kg)} kg`;
  }
  const diffCell = document.createElement("td");
  diffCell.className = "weight-diff";
  if (here && before) {
    const diff = Math.round((here.kg - before.kg) * 10) / 10;
    diffCell.textContent = `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${fmtKg(Math.abs(diff))} kg`;
    diffCell.classList.add(diff > 0 ? "up" : diff < 0 ? "down" : "same");
  }
  return [kgCell, diffCell];
}

// 表示中の月の折れ線グラフ（SVG）
function renderWeightChart(weights, y, m, days) {
  const box = $("weight-chart");
  const first = ymd(y, m, 1), last = ymd(y, m, days);
  const pts = weights.filter((w) => w.date >= first && w.date <= last);
  if (!pts.length) {
    box.innerHTML = `<p class="muted chart-empty">${m}月の記録はまだありません。</p>`;
    return;
  }
  const W = 340, H = 170, L = 40, R = 12, T = 14, B = 26;
  let lo = Math.min(...pts.map((p) => p.kg)), hi = Math.max(...pts.map((p) => p.kg));
  // 上下に少し余白をとり、目盛りは 0.5kg 単位に丸める
  lo = Math.floor((lo - 0.3) * 2) / 2;
  hi = Math.ceil((hi + 0.3) * 2) / 2;
  const x = (day) => L + (W - L - R) * (days === 1 ? 0.5 : (day - 1) / (days - 1));
  const yv = (kg) => T + (H - T - B) * (1 - (kg - lo) / (hi - lo));
  const day = (date) => Number(date.slice(8));
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${m}月の体重のグラフ` });
  const mid = (lo + hi) / 2;
  for (const kg of [lo, mid, hi]) {
    svg.append(el("line", { x1: L, x2: W - R, y1: yv(kg), y2: yv(kg), class: "grid-line" }));
    svg.append(el("text", { x: L - 6, y: yv(kg) + 4, "text-anchor": "end", class: "axis" }, kg.toFixed(1)));
  }
  for (const d of [1, 10, 20, days]) {
    svg.append(el("text", { x: x(d), y: H - 8, "text-anchor": "middle", class: "axis" }, `${d}日`));
  }
  svg.append(el("polyline", { points: pts.map((p) => `${x(day(p.date))},${yv(p.kg)}`).join(" "), class: "line" }));
  for (const p of pts) {
    const g = el("g", {});
    g.append(el("circle", { cx: x(day(p.date)), cy: yv(p.kg), r: 4, class: "dot" }));
    g.append(el("title", {}, `${m}月${day(p.date)}日 ${fmtKg(p.kg)} kg`));
    svg.append(g);
  }
  // 最新の値だけ数字を添える
  const lastPt = pts[pts.length - 1];
  svg.append(el("text", { x: x(day(lastPt.date)), y: yv(lastPt.kg) - 9, "text-anchor": "middle", class: "value" }, fmtKg(lastPt.kg)));
  box.replaceChildren(svg);
}

// ---- 予定表のマス（箇条書き） ----
// 1マス = chores の文書1つ。entries: [{ time: "13:30" か "", text }] を時刻順に持つ。
// 箇条書きになる前に書いた text は、改行ごとに1項目として読む（時刻だけの行は前の項目の時刻にする）
const TIME_ONLY = /^(\d{1,2})[:：](\d{2})$/;

function cellEntries(data) {
  if (!data) return [];
  if (Array.isArray(data.entries)) return data.entries;
  const entries = [];
  for (const line of (data.text || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const t = line.match(TIME_ONLY);
    const last = entries[entries.length - 1];
    if (t && last && !last.time) last.time = `${t[1].padStart(2, "0")}:${t[2]}`;
    else entries.push({ time: "", text: line });
  }
  return entries;
}

// 時刻なしの項目を先に（書いた順）、そのあと時刻順
const sortEntries = (entries) => [...entries].sort((a, b) =>
  (a.time ? 1 : 0) - (b.time ? 1 : 0) || (a.time || "").localeCompare(b.time || ""));

function entryCell(id, date, cat, item, data, label) {
  const entries = cellEntries(data);
  const box = document.createElement("div");
  box.className = "entry-cell" + colorClass(item);
  const list = document.createElement("ul");
  list.className = "entries";
  entries.forEach((entry, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "entry";
    if (entry.time) {
      const t = document.createElement("span");
      t.className = "entry-time";
      t.textContent = entry.time;
      b.append(t, " ");
    }
    b.append(entry.text);
    b.setAttribute("aria-label", `${label}：${entry.time ? entry.time + " " : ""}${entry.text}を直す`);
    b.onclick = () => openEntryDialog({ id, date, cat, item, entries, index: i, label });
    li.append(b);
    list.append(li);
  });
  const add = document.createElement("button");
  add.className = "entry-add";
  add.textContent = "＋";
  add.setAttribute("aria-label", `${label}に予定を足す`);
  add.onclick = () => openEntryDialog({ id, date, cat, item, entries, index: -1, label });
  box.append(list, add);
  return box;
}

let entryTarget = null;   // ダイアログで編集中のマス

function openEntryDialog(target) {
  entryTarget = target;
  const entry = target.index >= 0 ? target.entries[target.index] : { time: "", text: "" };
  $("entry-title").textContent = target.label;
  $("entry-time").value = entry.time;
  $("entry-text").value = entry.text;
  $("entry-delete").hidden = target.index < 0;
  $("entry-dialog").showModal();
  $("entry-text").focus();
}

function saveEntries(next) {
  const { id, date, cat, item } = entryTarget;
  const ref = doc(db, "chores", id);
  if (!next.length) return deleteDoc(ref);
  return setDoc(ref, {
    title: item.name, cat: cat.id, key: item.key, date, done: true,
    entries: sortEntries(next), by: myName, createdAt: serverTimestamp(),
  });
}

$("entry-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("entry-text").value.trim();
  if (!text) return;
  const entry = { time: $("entry-time").value, text: text.slice(0, 100) };
  const next = [...entryTarget.entries];
  if (entryTarget.index >= 0) next[entryTarget.index] = entry; else next.push(entry);
  saveEntries(next);
  $("entry-dialog").close();
};
$("entry-delete").onclick = () => {
  saveEntries(entryTarget.entries.filter((_, i) => i !== entryTarget.index));
  $("entry-dialog").close();
};
$("entry-cancel").onclick = () => $("entry-dialog").close();

// 「予定」ボタンがオンの間は、マスを押すと✓の代わりに○（予定）を付け外しする
let planMode = false;

function toggleCheck(id, date, cat, item, { checked, planned, auto }) {
  const ref = doc(db, "chores", id);
  const save = (fields) => setDoc(ref, {
    title: item.name, cat: cat.id, key: item.key, date, by: myName, createdAt: serverTimestamp(), ...fields,
  });
  if (!planMode) {
    // 通常：✓を付ける（○は上書き）。✓を外すと、繰り返しの○があればそれに戻る
    return checked ? deleteDoc(ref) : save({ done: true });
  }
  // 予定モード：○を付け外しする。自動の○を消すときは「消した」印を残す
  if (planned) return auto ? save({ done: false, skip: true }) : deleteDoc(ref);
  return auto ? deleteDoc(ref) : save({ done: false });
}

// ---- 繰り返し（自動で○を入れる） ----
// repeat: { type: "interval", n: 1|2|3, start: "YYYY-MM-DD" }（毎日・1日おき・2日おき）
//      or { type: "weekly", days: [0..6] }（曜日指定、0 = 日曜）
const REPEAT_OPTIONS = [["", "繰り返しなし"], ["1", "毎日"], ["2", "1日おき"], ["3", "2日おき"], ["weekly", "曜日指定"]];

function repeatMatches(repeat, date) {
  if (!repeat) return false;
  const [y, m, d] = date.split("-").map(Number);
  if (repeat.type === "weekly") return (repeat.days || []).includes(new Date(y, m - 1, d).getDay());
  if (repeat.type === "interval") {
    const [sy, sm, sd] = repeat.start.split("-").map(Number);
    const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(sy, sm - 1, sd)) / 86400000);
    return diff >= 0 && diff % repeat.n === 0;
  }
  return false;
}

function repeatValue(repeat) {
  if (!repeat) return "";
  return repeat.type === "weekly" ? "weekly" : String(repeat.n);
}

async function setRepeat(key, repeat) {
  const catId = currentTab;
  await updateCurrent((c) => ({
    ...c, items: c.items.map((x) => x.key === key ? { ...x, repeat } : x),
  }));
  // 繰り返しを変えたら、本日以降に手で付けた○や消した印をいったん片付けて、新しい設定どおりにする
  const snap = await getDocs(query(collection(db, "chores"), where("date", ">=", today())));
  await Promise.all(snap.docs
    .filter((d) => { const x = d.data(); return x.cat === catId && x.key === key && x.done === false; })
    .map((d) => deleteDoc(d.ref)));
}

function repeatControls(item) {
  const box = document.createElement("div");
  box.className = "repeat";
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", `${item.name}の繰り返し`);
  for (const [value, label] of REPEAT_OPTIONS) sel.add(new Option(label, value));
  sel.value = repeatValue(item.repeat);
  sel.onchange = () => {
    const v = sel.value;
    if (!v) return setRepeat(item.key, null);
    // 曜日指定に切り替えたときは、とりあえず今日の曜日を選んでおく
    if (v === "weekly") return setRepeat(item.key, { type: "weekly", days: [new Date().getDay()] });
    setRepeat(item.key, { type: "interval", n: Number(v), start: today() });
  };
  box.append(sel);
  if (item.repeat?.type === "weekly") {
    const days = item.repeat.days || [];
    [...WEEKDAYS].forEach((label, wd) => {
      const b = document.createElement("button");
      b.className = "small day" + (days.includes(wd) ? " on" : "");
      b.textContent = label;
      b.setAttribute("aria-pressed", String(days.includes(wd)));
      b.onclick = () => {
        const next = days.includes(wd) ? days.filter((x) => x !== wd) : [...days, wd].sort();
        setRepeat(item.key, { type: "weekly", days: next });
      };
      box.append(b);
    });
  }
  return box;
}

function setPlanMode(on) {
  planMode = on;
  $("plan-toggle").setAttribute("aria-pressed", String(on));
  $("plan-toggle").classList.toggle("on", on);
  renderGrid();
}
$("plan-toggle").onclick = () => setPlanMode(!planMode);

$("prev-month").onclick = () => { month.setMonth(month.getMonth() - 1); watchMonth(); };
$("next-month").onclick = () => { month.setMonth(month.getMonth() + 1); watchMonth(); };
$("this-month").onclick = () => { month = new Date(); month.setDate(1); watchMonth(); scrollToToday(); };

function scrollToToday() {
  requestAnimationFrame(() => document.querySelector("#grid-body tr.today")?.scrollIntoView({ block: "center" }));
}

// ---- 項目の編集 ----
function setEditor(open) {
  $("editor").hidden = !open;
  $("edit-toggle").textContent = open ? "編集を閉じる" : "項目を編集";
  $("edit-toggle").setAttribute("aria-expanded", String(open));
}
$("edit-toggle").onclick = () => setEditor($("editor").hidden);
$("editor-close").onclick = () => setEditor(false);

function updateCurrent(change) {
  return saveCategories(categories.map((c) => c.id === currentTab ? change(c) : c));
}

function renderEditor() {
  const cat = currentCategory();
  if (!cat) return;
  $("cat-name").value = cat.name;
  const list = $("item-list");
  list.replaceChildren();
  cat.items.forEach((item, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = item.name;
    const up = document.createElement("button");
    up.className = "small";
    up.textContent = "↑";
    up.setAttribute("aria-label", `${item.name}を左へ`);
    up.disabled = i === 0;
    up.onclick = () => updateCurrent((c) => {
      const items = [...c.items];
      [items[i - 1], items[i]] = [items[i], items[i - 1]];
      return { ...c, items };
    });
    const del = document.createElement("button");
    del.className = "small";
    del.textContent = "削除";
    del.onclick = () => updateCurrent((c) => ({ ...c, items: c.items.filter((x) => x.key !== item.key) }));
    li.append(name, up, del);
    if (cat.type !== "text") li.append(repeatControls(item));
    list.append(li);
  });
  $("cat-delete").disabled = categories.length <= 1;
}

$("item-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("item-name").value.trim();
  if (!name) return;
  await updateCurrent((c) => ({ ...c, items: [...c.items, { key: newId(), name: name.slice(0, 20) }] }));
  $("item-name").value = "";
};

$("cat-form").onsubmit = (e) => {
  e.preventDefault();
  const name = $("cat-name").value.trim();
  if (name) updateCurrent((c) => ({ ...c, name: name.slice(0, 30) }));
};

$("cat-delete").onclick = () => {
  const cat = currentCategory();
  if (!cat || categories.length <= 1) return;
  if (!confirm(`カテゴリ「${cat.name}」を表から消しますか？`)) return;
  currentTab = categories.find((c) => c.id !== cat.id).id;
  saveCategories(categories.filter((c) => c.id !== cat.id));
  selectTab(currentTab);
};

// ---- 記録 ----
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function watchLogs(user) {
  const q = query(collection(db, "logs"), orderBy("date", "desc"), limit(200));
  unsubscribers.push(onSnapshot(q, (snap) => {
    const logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // 同じ日の中は新しい順（書き込み直後は createdAt がまだ空なので一番上に置く）
    const time = (l) => l.createdAt?.toMillis?.() ?? Infinity;
    logs.sort((a, b) => b.date.localeCompare(a.date) || time(b) - time(a));
    renderLogs(logs, user);
  }));
}

function renderLogs(logs, user) {
  const box = $("log-list");
  box.replaceChildren();
  let lastDate = "";
  for (const l of logs) {
    if (l.date !== lastDate) {
      lastDate = l.date;
      const h = document.createElement("h3");
      h.className = "day";
      h.textContent = formatDate(l.date);
      box.append(h);
    }
    const item = document.createElement("div");
    item.className = "log";

    const text = document.createElement("div");
    text.className = "text";
    text.textContent = l.text;

    const meta = document.createElement("div");
    meta.className = "meta";
    const author = document.createElement("span");
    author.textContent = l.author;
    meta.append(author);
    if (l.authorUid === user.uid) {
      const del = document.createElement("button");
      del.className = "small";
      del.textContent = "削除";
      del.onclick = () => {
        if (confirm("この記録を削除しますか？")) deleteDoc(doc(db, "logs", l.id));
      };
      meta.append(del);
    }
    item.append(text, meta);
    box.append(item);
  }
  $("log-empty").hidden = logs.length > 0;
}

function formatDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  const w = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日（${w}）`;
}

$("log-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("log-text").value.trim();
  if (!text) return;
  await addDoc(collection(db, "logs"), {
    date: $("log-date").value,
    text,
    author: myName,
    authorUid: auth.currentUser.uid,
    createdAt: serverTimestamp(),
  });
  $("log-text").value = "";
};
