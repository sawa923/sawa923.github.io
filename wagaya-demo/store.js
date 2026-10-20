// デモ版のデータ置き場。Firestore の使っている関数だけを同じ形でまねて、
// 中身はこの端末の localStorage に保存する（ほかの人とは共有されない）。
const KEY = "wagaya-demo-data";
const listeners = new Set();
let data = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && saved.chores) return saved;
  } catch {}
  return { chores: sampleData() };
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
}
persist();

// 時刻は { __ts: ミリ秒 } で保存し、読むときに Firestore の Timestamp のように toMillis() を持たせる
const revive = (v) => v && typeof v === "object" && "__ts" in v ? { toMillis: () => v.__ts } : v;
const pack = (v) => v && typeof v.toMillis === "function" ? { __ts: v.toMillis() } : v;
const reviveAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, revive(v)]));
const packAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, pack(v)]));

export const collection = (_db, name) => ({ kind: "collection", name, filters: [] });
export const doc = (_db, name, id) => ({ kind: "doc", name, id });
export const where = (field, op, value) => ({ field, op, value });
export const query = (col, ...filters) => ({ ...col, filters: [...col.filters, ...filters] });
export const serverTimestamp = () => ({ __ts: Date.now() });

function matches(row, { field, op, value }) {
  const v = row[field];
  if (op === "==") return v === value;
  if (op === ">=") return v >= value;
  if (op === "<=") return v <= value;
  throw new Error("未対応の条件: " + op);
}

function snapshot(ref) {
  const rows = data[ref.name] || {};
  if (ref.kind === "doc") {
    const row = rows[ref.id];
    return { id: ref.id, exists: () => !!row, data: () => row ? reviveAll(row) : undefined };
  }
  const docs = Object.entries(rows)
    .filter(([, row]) => ref.filters.every((f) => matches(row, f)))
    .map(([id, row]) => ({ id, ref: doc(null, ref.name, id), data: () => reviveAll(row) }));
  return { docs };
}

let pending = false;
function changed() {
  persist();
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    for (const l of [...listeners]) if (listeners.has(l)) l.cb(snapshot(l.ref));
  });
}

export async function setDoc(ref, fields) {
  (data[ref.name] ||= {})[ref.id] = packAll(JSON.parse(JSON.stringify(fields, (k, v) => pack(v))));
  changed();
}
export async function deleteDoc(ref) {
  if (data[ref.name]) delete data[ref.name][ref.id];
  changed();
}
export async function getDocs(ref) {
  return snapshot(ref);
}
export function onSnapshot(ref, cb) {
  const l = { ref, cb };
  listeners.add(l);
  queueMicrotask(() => { if (listeners.has(l)) cb(snapshot(ref)); });
  return () => listeners.delete(l);
}

// 入力した内容を消して、サンプルデータに戻す
export function resetStore() {
  data = { chores: sampleData() };
  persist();
}

// ---- サンプルデータ（架空の家族「ひろ」と「みか」。日付は今日を基準に作る） ----
function sampleData() {
  const rows = {};
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const now = new Date();
  const day = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const ts = { __ts: now.getTime() };
  const who = () => (rand() < 0.5 ? "ひろ" : "みか");

  // 家事：過去3週間ほどのチェックと、これからの予定（○）
  const kaji = [["toilet", "トイレ掃除", 0.25], ["bath", "お風呂掃除", 0.45], ["entrance", "玄関掃除", 0.12],
    ["mop", "モップ掛け", 0.2], ["vacuum", "床掃除機", 0.4], ["trash", "ゴミ出し", 0.3]];
  for (let o = -22; o <= 0; o++) {
    for (const [key, title, p] of kaji) {
      if (rand() < p) rows[`${day(o)}_${key}`] = { title, cat: "kaji", key, date: day(o), done: true, by: who(), createdAt: ts };
    }
  }
  rows[`${day(3)}_toilet`] = { title: "トイレ掃除", cat: "kaji", key: "toilet", date: day(3), done: false, by: "みか", createdAt: ts };
  rows[`${day(6)}_entrance`] = { title: "玄関掃除", cat: "kaji", key: "entrance", date: day(6), done: false, by: "ひろ", createdAt: ts };

  // 予定
  const plans = [
    [-3, "hiro", "ひろ", [{ time: "19:00", text: "会社の飲み会" }]],
    [-1, "mika", "みか", [{ time: "10:00", end: "12:00", text: "ヨガ教室" }]],
    [0, "note", "備考", [{ time: "", text: "燃えないゴミの日" }]],
    [1, "hiro", "ひろ", [{ time: "09:30", text: "歯医者" }]],
    [2, "mika", "みか", [{ time: "13:00", end: "15:00", text: "友だちとランチ" }, { time: "18:00", text: "習い事" }]],
    [5, "hiro", "ひろ", [{ time: "", text: "出張（大阪）" }]],
    [5, "mika", "みか", [{ time: "11:00", text: "美容院" }]],
    [9, "note", "備考", [{ time: "", text: "実家に帰る" }]],
  ];
  for (const [o, key, title, entries] of plans) {
    rows[`${day(o)}_yotei_${key}`] = { title, cat: "yotei", key, date: day(o), done: true, entries, by: title === "備考" ? "みか" : title, createdAt: ts };
  }

  // 体重（書き込めるのは「ひろ」だけ）
  let kg = 71.2;
  for (let o = -45; o <= 0; o++) {
    kg += (rand() - 0.58) * 0.5;
    if (rand() < 0.8) rows[`${day(o)}_weight`] = { title: "体重", cat: "weight", key: "kg", date: day(o), done: true, kg: Math.round(kg * 10) / 10, by: "ひろ", createdAt: ts };
  }

  // 買い物
  const shop = [["牛乳", 1, "", false], ["卵", 2, "Mサイズ", false], ["食パン", 1, "6枚切り", false], ["トマト", 3, "", false], ["洗濯洗剤", 1, "詰め替え", true]];
  shop.forEach(([title, count, memo, done], i) => {
    rows[`shop_demo${i}`] = { title, cat: "shopping", date: "shop", done, count, memo, by: who(), createdAt: { __ts: now.getTime() - (10 - i) * 60000 } };
  });

  // ToDo
  const todos = [["網戸の掃除", 3, "ひろ", false], ["年末の旅行の宿を予約", 20, "2人", false], ["車の点検の予約", -1, "みか", false],
    ["郵便局で荷物を受け取る", 1, "", false], ["電球の交換", -4, "ひろ", true]];
  todos.forEach(([title, o, w, done], i) => {
    rows[`todo_demo${i}`] = { title, cat: "todo", date: "todo", done, due: day(o), who: w, by: who(), createdAt: ts };
  });

  // 家計簿：先月の1日から今日まで
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startOffset = Math.round((first - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  let n = 0;
  const kb = (o, kind, amount, kbCat, memo, payer) => {
    rows[`kb_demo${n++}`] = { title: memo || kbCat, cat: "kakeibo", date: day(o), done: true, kind, amount, kbCat, memo, payer, by: payer, createdAt: ts };
  };
  for (let o = startOffset; o <= 0; o++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + o);
    if (d.getDate() === 25) kb(o, "in", 280000, "給料", "", "ひろ");
    if (d.getDate() === 10) kb(o, "in", 120000, "給料", "パート代", "みか");
    if (d.getDate() === 27) kb(o, "out", 85000, "住居", "家賃", "ひろ");
    if (d.getDate() === 15) kb(o, "out", 9800, "光熱費", "電気代", "ひろ");
    if (d.getDate() === 18) kb(o, "out", 6200, "通信", "スマホ2台", "ひろ");
    if (rand() < 0.45) kb(o, "out", Math.round((1500 + rand() * 4500) / 10) * 10, "食費", "スーパー", who());
    if (rand() < 0.15) kb(o, "out", Math.round((800 + rand() * 2500) / 10) * 10, "日用品", "ドラッグストア", who());
    if (rand() < 0.1) kb(o, "out", Math.round((2000 + rand() * 6000) / 100) * 100, "外食", "ごはん", who());
  }
  return rows;
}
