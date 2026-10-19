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
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, query, orderBy, limit, serverTimestamp,
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
  fillAssigneeSelect($("chore-assignee"), "");
  $("log-date").value = today();
  show("view-app");
  watchChores();
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

// ---- 家事 ----
function fillAssigneeSelect(select, current) {
  select.replaceChildren();
  const options = [{ value: "", label: "担当：未定" }, ...members.map((m) => ({ value: m.name, label: m.name }))];
  if (current && !members.some((m) => m.name === current)) options.push({ value: current, label: current });
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    select.append(opt);
  }
  select.value = current;
}

let chores = [];
function watchChores() {
  const q = query(collection(db, "chores"), orderBy("createdAt", "desc"));
  unsubscribers.push(onSnapshot(q, (snap) => {
    chores = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderChores();
  }));
}

function renderChores() {
  const showDone = $("show-done").checked;
  const visible = chores
    .filter((c) => showDone || !c.done)
    .sort((a, b) => Number(a.done) - Number(b.done));
  const list = $("chore-list");
  list.replaceChildren();
  for (const c of visible) {
    const li = document.createElement("li");
    li.classList.toggle("done", !!c.done);

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = !!c.done;
    check.onchange = () => updateDoc(doc(db, "chores", c.id), { done: check.checked });

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = c.title;

    const who = document.createElement("select");
    fillAssigneeSelect(who, c.assignee || "");
    who.onchange = () => updateDoc(doc(db, "chores", c.id), { assignee: who.value });

    const del = document.createElement("button");
    del.className = "small";
    del.textContent = "削除";
    del.onclick = () => {
      if (confirm("「" + c.title + "」を削除しますか？")) deleteDoc(doc(db, "chores", c.id));
    };

    li.append(check, title, who, del);
    list.append(li);
  }
  $("chore-empty").hidden = visible.length > 0;
}
$("show-done").onchange = renderChores;

$("chore-form").onsubmit = async (e) => {
  e.preventDefault();
  const title = $("chore-title").value.trim();
  if (!title) return;
  await addDoc(collection(db, "chores"), {
    title,
    assignee: $("chore-assignee").value,
    done: false,
    createdBy: myName,
    createdAt: serverTimestamp(),
  });
  $("chore-title").value = "";
  $("chore-assignee").value = "";
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
