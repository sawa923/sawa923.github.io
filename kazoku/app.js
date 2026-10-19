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
}];
const SETTINGS_VERSION = 2;
// 列ごとの文字色（列の名前で決める）
const COLUMN_COLORS = { "たく": "blue", "あゆ": "pink" };
// チェックした人ごとの✓の色（チェックした人の名前で決める）
const CHECK_COLORS = { "たく": "green" };
const colorClass = (item) => COLUMN_COLORS[item.name] ? ` color-${COLUMN_COLORS[item.name]}` : "";   // 2 で「予定」を追加
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
    // 予定表ができる前の設定には「予定」を足す（一度保存したあとは消しても戻らない）
    if (saved && (data.version || 1) < 2 && !saved.some((c) => c.id === "yotei")) {
      saved = [...saved, DEFAULT_CATEGORIES.find((c) => c.id === "yotei")];
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
  const q = query(collection(db, "chores"),
    where("date", ">=", ymd(y, m, 1)), where("date", "<=", ymd(y, m, days)));
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
  if (document.activeElement?.classList.contains("text-cell")) { renderPending = true; return; }
  renderPending = false;
  const isText = cat.type === "text";
  $("grid").classList.toggle("text-grid", isText);
  $("hint-text").textContent = isText
    ? "マスを押すと書き込めます。ほかの場所を押すと保存されます。"
    : planMode
      ? "予定を入れるモードです。マスを押すと○が付きます。もう一度押すと外れます。"
      : "終わったらマスを押すとチェックが付きます。もう一度押すと外れます。";
  $("plan-toggle").hidden = isText;
  const y = month.getFullYear(), m = month.getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  const todayStr = today();
  $("no-items").hidden = cat.items.length > 0;

  const head = $("grid-head");
  head.replaceChildren();
  const tr = document.createElement("tr");
  for (const [label, cls] of [["日付", "col-date"], ["曜日", "col-wd"]]) {
    const th = document.createElement("th");
    th.className = cls;
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

    for (const item of cat.items) {
      const id = checkId(cat, date, item);
      const done = checks.get(id);
      const cell = document.createElement("td");
      if (isText) {
        cell.append(textCell(id, date, cat, item, done?.text || "", `${m}月${d}日 ${item.name}`));
        row.append(cell);
        continue;
      }
      const btn = document.createElement("button");
      // done が false の文書は「予定」の○（チェックとしては数えない）
      const planned = done && done.done === false;
      const checked = done && !planned;
      btn.className = "cell"
        + (checked ? " done" + (CHECK_COLORS[done.by] ? ` by-${CHECK_COLORS[done.by]}` : "") : "")
        + (planned ? " planned" : "");
      btn.setAttribute("aria-label", `${m}月${d}日 ${item.name}`
        + (checked ? `（${done.by}）` : planned ? "（予定）" : ""));
      if (done) {
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
      btn.onclick = () => toggleCheck(id, date, cat, item, done);
      cell.append(btn);
      row.append(cell);
    }
    body.append(row);
  }
}

function textCell(id, date, cat, item, value, label) {
  const ta = document.createElement("textarea");
  ta.className = "text-cell" + colorClass(item);
  ta.rows = 1;
  ta.maxLength = 200;
  ta.value = value;
  ta.setAttribute("aria-label", label);
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  ta.addEventListener("blur", () => {
    // フォーカスが次のマスへ移ってから保存する（描き直しで次のマスが消えないように）
    setTimeout(() => {
      const text = ta.value.trim();
      if (text !== value) {
        value = text;
        if (text) {
          setDoc(doc(db, "chores", id), {
            title: item.name, cat: cat.id, key: item.key, date, done: true, text, by: myName, createdAt: serverTimestamp(),
          });
        } else {
          deleteDoc(doc(db, "chores", id));
        }
      }
      if (renderPending) renderGrid();
    }, 0);
  });
  return ta;
}

// 「予定」ボタンがオンの間は、マスを押すと✓の代わりに○（予定）を付け外しする
let planMode = false;

function toggleCheck(id, date, cat, item, done) {
  const planned = done && done.done === false;
  // 同じ種類の印がもう付いていれば外す。違う種類なら上書きする（○→✓ など）
  if (done && planned === planMode) {
    deleteDoc(doc(db, "chores", id));
  } else {
    setDoc(doc(db, "chores", id), {
      title: item.name, cat: cat.id, key: item.key, date, done: !planMode, by: myName, createdAt: serverTimestamp(),
    });
  }
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
