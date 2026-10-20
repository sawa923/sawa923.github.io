# わが家ノート（デモ版）

家族用アプリ「わが家ノート」（`/kazoku/`）のポートフォリオ用デモです。
公開URL: https://sawa923.github.io/wagaya-demo/

- ログイン不要。誰でも触れます。
- Firebase は使わず、データはブラウザの localStorage（`wagaya-demo-data`）にだけ保存します。
- 架空の家族「ひろ」「みか」のサンプルデータが最初から入っています（日付は開いた日を基準に作ります）。
- 画面右上の「使う人」で操作する人を切り替え、「リセット」でサンプルデータに戻せます。
- 天気は東京（Open-Meteo）を表示します。

## 仕組み

`app.js` と `style.css` は本番 `/kazoku/` のコピーです。`store.js` が Firestore の
`collection / doc / setDoc / deleteDoc / getDocs / onSnapshot / query / where / serverTimestamp`
を同じ形でまねて localStorage に読み書きするので、アプリ本体はほぼそのまま動きます。
本番のコードやデータには影響しません。JS/CSS を変えたら `index.html` の `?v=N` を上げてください。
