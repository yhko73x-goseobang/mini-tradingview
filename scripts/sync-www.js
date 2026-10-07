// www/ 폴더 동기화 — APK에 들어갈 웹 자산만 복사 (node_modules, server.js 제외)
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const www = path.join(root, "www");
const files = [
  "index.html",
  "app.js",
  "chart.js",
  "datafeed.js",
  "pinebundle.js",
  "styles.css",
  "alert.wav",
  "manifest.webmanifest",
  "종목예시.txt",
];

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
for (const f of files) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(www, f));
  else console.log("skip (없음): " + f);
}
// 아이콘이 있으면 복사, 없으면 안내
for (const ic of ["icon-192.png", "icon-512.png"]) {
  const src = path.join(root, ic);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(www, ic));
}
console.log("www 동기화 완료:", fs.readdirSync(www).join(", "));
