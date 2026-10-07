# 스마트폰 APK 만들기 (설치 없이, GitHub 클라우드 빌드)

PC에 Node/Java/Android SDK 설치가 필요 없습니다.
GitHub에 올리면 클라우드에서 APK를 자동 빌드해줍니다. 약 5~10분 소요.

## 1. GitHub 저장소 만들기

1. https://github.com/new 접속 → 저장소 생성 (예: `mini-tradingview`)
2. 이 폴더(`기본 프로젝트`)의 파일들을 업로드
   - `.github/workflows/build-apk.yml`, `capacitor.config.json`,
     `package.json`, `scripts/sync-www.js`, `manifest.webmanifest`,
     `index.html`, `app.js`, `chart.js`, `datafeed.js`, `pinebundle.js`,
     `styles.css`, `alert.wav`, `종목예시.txt` 포함
   - `node_modules/`는 올리지 마세요 (`.gitignore`가 자동 제외)
   - `server.js`, `server.bat`, `차트실행.bat`는 올려도 APK에 포함되지 않음 (`www/`만 패키징)

PowerShell에서:
```powershell
cd "E:\work\기본 프로젝트"
git init; git add .; git commit -m "apk build"
git branch -M main
git remote add origin https://github.com/<아이디>/mini-tradingview.git
git push -u origin main
```

## 2. APK 빌드 + 다운로드

1. GitHub 저장소 → `Actions` 탭 → `Build Android APK (debug)` → `Run workflow`
   (`main`에 push하면 자동 실행됨)
2. 빌드 완료 후 하단의 `Artifacts` → `app-debug` 다운로드 → 압축 해제 → `app-debug.apk`
3. 스마트폰에 복사 → 탭해서 설치 (알 수 없는 앱 설치 허용 필요)

## 3. APK에서 동작 방식

- 웹 자산은 `www/`에 복사되어 패키징됨 (`npm run sync-www`가 자동 수행).
  `node_modules`, `server.js`는 제외됨.
- `server.js` 프록시 없이 동작하므로:
  - 키움 API: 프록시(`/kiwoom-*`) 시도 후 실패하면 `https://api.kiwoom.com` /
    `https://mockapi.kiwoom.com` 직접 호출로 폴백 (데스크톱 `file://` 모드와 동일).
    직접 호출이 CORS에 막히면 시뮬레이션 피드로 동작. 실데이터가 필요하면
    키움 앱키/시크릿 입력 후 연결 시도.
  - 지수(US100/IXIC 등): 프록시 실패 시 야후 직접 호출
    (`query1/2.finance.yahoo.com`)로 폴백하도록 `datafeed.js` 패치됨.
    직접 호출도 막히면 시뮬레이션 피드.
  - 실시간 WS: `wss://...:10000` 직접 연결 (모바일 네트워크에서 10000번 포트
    차단 시 실시간이 안 들어올 수 있음 → 폴링/시뮬으로 표시됨).
- `alert.wav` 포함됨. TTS(음성안내)는 안드로이드 WebView TTS를 사용.
  소리/진동이 안 나면 앱 설정에서 미디어 권한 확인.

## 4. 로컬에서 직접 빌드하려면 (선택)

```powershell
# Node 20 + Java 17 + Android Studio 설치 후
npm install
npm run sync-www
npx cap init "Mini TradingView" com.minitradingview.app --web-dir=www
npx cap add android
npx cap sync android
cd android; ./gradlew assembleDebug
# 결과물: android/app/build/outputs/apk/debug/app-debug.apk
```

## 5. 앱 이름/ID 바꾸기

- `capacitor.config.json`의 `appName`, `appId` 수정
  (예: `com.mycompany.chartapp`)
- 워크플로우의 `npx cap init "Mini TradingView" com.minitradingview.app` 부분도
  동일하게 수정.

## 6. 서명된 출시용 APK (스토어 배포용)

현재 워크플로우는 디버그 APK입니다. 바로 설치는 되지만 스토어 배포는 불가.
출시용은 `keystore` 생성 후 `assembleRelease` + 서명 단계 추가 필요.
필요하면 말해주세요.
