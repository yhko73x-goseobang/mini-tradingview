// www/ 폴더 동기화 — 30m 멀티TF 알리미(APK용) 웹 자산만 복사
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "alert-30m");
const www = path.join(root, "www");
const files = [
  "index.html",
  "app.js",
  "datafeed.js",
  "indicators.js",
  "alerter.js",
  "styles.css",
  "manifest.webmanifest",
  "관심종목.txt",
  "종목예시30m.txt",
];

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
for (const f of files) {
  const s = path.join(src, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(www, f));
  else console.log("skip (없음): " + f);
}
// alert.wav는 루트에 있으므로 가져옴
const wav = path.join(root, "alert.wav");
if (fs.existsSync(wav)) fs.copyFileSync(wav, path.join(www, "alert.wav"));
for (const ic of ["icon-192.png", "icon-512.png"]) {
  const s = path.join(src, ic);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(www, ic));
}
console.log("www(30m) 동기화 완료:", fs.readdirSync(www).join(", "));
