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
} = await import(`${SDK}/firebase-auth.js`);
const {
  getFirestore, collection, doc, addDoc, setDoc, deleteDoc, getDocs,
  onSnapshot, query, where, orderBy, limit, serverTimestamp,
} = await import(`${SDK}/firebase-firestore.js`);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let members = [];      // [{ email, name }]
let myName = "";
let unsubscribers = [];

$("login").onclick = async () => {
  $("login-error").hidden = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
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
  watchChores();
  scrollToToday();
  watchLogs(user);
});

// ---- タブ ----
for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    $("tab-chores").hidden = tab.dataset.tab !== "chores";
    $("tab-logs").hidden = tab.dataset.tab !== "logs";
  };
}

// ---- 家事（月ごとの表） ----
// 列に並べる家事。増やす・並べ替えるときはここを書き換える（key は変えない）
const CHORES = [
  { key: "toilet", name: "トイレ掃除" },
  { key: "bath", name: "お風呂掃除" },
  { key: "entrance", name: "玄関掃除" },
  { key: "mop", name: "モップ掛け" },
  { key: "vacuum", name: "床掃除機" },
  { key: "trash", name: "ゴミ出し" },
];
const WEEKDAYS = "日月火水木金土";

let month = new Date();   // 表示中の月（日付は使わない）
month.setDate(1);
let checks = new Map();   // "2026-10-01_toilet" → { by }
let unwatchMonth = null;

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function watchChores() {
  if (unwatchMonth) unwatchMonth();
  const y = month.getFullYear(), m = month.getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  $("month-label").textContent = `${y}年${m}月`;
  // チェック1つ = chores コレクションの文書1つ（ID は「日付_家事」）
  const q = query(collection(db, "chores"),
    where("date", ">=", ymd(y, m, 1)), where("date", "<=", ymd(y, m, days)));
  checks = new Map();
  renderGrid();
  unwatchMonth = onSnapshot(q, (snap) => {
    checks = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderGrid();
  });
}

function renderGrid() {
  const y = month.getFullYear(), m = month.getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  const todayStr = today();

  const head = $("grid-head");
  head.replaceChildren();
  const tr = document.createElement("tr");
  for (const label of ["日付", "曜日"]) {
    const th = document.createElement("th");
    th.textContent = label;
    tr.append(th);
  }
  for (const c of CHORES) {
    const th = document.createElement("th");
    th.className = "chore-head";
    const span = document.createElement("span");
    span.textContent = c.name;
    th.append(span);
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

    for (const c of CHORES) {
      const id = `${date}_${c.key}`;
      const done = checks.get(id);
      const cell = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "cell" + (done ? " done" : "");
      btn.setAttribute("aria-label", `${m}月${d}日 ${c.name}` + (done ? `（${done.by}）` : ""));
      if (done) {
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = "✓";
        const by = document.createElement("span");
        by.className = "by";
        by.textContent = done.by;
        btn.append(mark, by);
      }
      btn.onclick = () => toggleCheck(id, date, c, done);
      cell.append(btn);
      row.append(cell);
    }
    body.append(row);
  }
}

function toggleCheck(id, date, chore, done) {
  if (done) {
    deleteDoc(doc(db, "chores", id));
  } else {
    setDoc(doc(db, "chores", id), {
      title: chore.name, key: chore.key, date, done: true, by: myName, createdAt: serverTimestamp(),
    });
  }
}

$("prev-month").onclick = () => { month.setMonth(month.getMonth() - 1); watchChores(); };
$("next-month").onclick = () => { month.setMonth(month.getMonth() + 1); watchChores(); };
$("this-month").onclick = () => { month = new Date(); month.setDate(1); watchChores(); scrollToToday(); };

function scrollToToday() {
  requestAnimationFrame(() => document.querySelector("#grid-body tr.today")?.scrollIntoView({ block: "center" }));
}

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
