# Kusunoki Desktop Tools

Kusunoki Desktop Tools は、QRコード生成、PDF編集、ブラウザ完結の画像編集を一つのデスクトップシェルにまとめたElectronアプリです。QR生成は起動時にオンラインAPIモードで開始し、ヘッダーの切替からローカルモードも選べます。オンラインAPIに失敗した場合は同じ入力をローカルで再生成し、そのセッション中はオフラインへ切り替えます。一括生成で失敗した場合はオンラインの途中結果を破棄して全件をローカルで再実行します。PDF処理、画像編集、素材トレイはローカルで動作し、更新確認は独立しています。レンダラーはCSPとリクエストブロックで外部API/CDNへ直接通信できず、QR API呼び出しはmain processから固定HTTPSエンドポイントへ行います。

## ダウンロード・インストール

[Windows版Setup.exeを直接ダウンロード](https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/latest/download/Kusunoki-Desktop-Tools-Setup.exe)

Windows版は上のリンクから、最新版の固定名 `Kusunoki-Desktop-Tools-Setup.exe` を直接ダウンロードして実行してください。その他のOSは [GitHub Releases](https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/latest) の **Release Assets** からお使いのOSに合うファイルを選択してください。

- Windowsを使っている方は、`Kusunoki-Desktop-Tools-Setup.exe` をダウンロードしてください。
- Apple Silicon（M1/M2/M3/M4等）のMacは、`*-arm64.dmg` をダウンロードしてください。
- Intel CPUのMacは、`*-x64.dmg` をダウンロードしてください。
- Linuxは、`*.AppImage` をダウンロードしてください。

Windowsでは `win-unpacked` 内のexeではなく、`Kusunoki-Desktop-Tools-Setup.exe` を実行してインストールしてください。インストール後はスタートメニューまたはインストール版から起動します。

未署名版では、WindowsのSmartScreenまたはmacOSのGatekeeperによる警告が表示される場合があります。

## 開発

```bash
npm install
npm test
npm run dev
npm run electron:smoke  # hidden-window smoke: generated PDF/Pic iframe and local libraries
```

`npm install` の `prepare` が `vendor/qr-generator/public`、`vendor/pdf-editor`、`vendor/pic-editor/public` の上流画面・スクリプト・スタイルなどを `renderer/generated/upstream/` へ展開します。画像エディターは `renderer/generated/upstream/pic/index.html` を同一オリジンのiframeで表示し、Fabric.jsを含むbundle、HTML、CSS、仕様書をmanifestのSHA-256で追跡します。画像エディターはブラウザ内だけで動作し、外部fetch・CDN・IPC・Node APIを使用しません。QRの `batch-utils.mjs` は同じソースから `batch-utils.js` へ機械的にclassic/global変換され、シェルが実際にロードします。CSVはUTF-8（BOM可）を優先し、UTF-8として不正な場合はShift_JISへフォールバックします。PDFの `index.html` / `script.js` は unpkg参照を `pdf-lib`、`pdfjs-dist@3.11.174`、`jszip` のnpm同梱ファイルへ変換し、生成された `pdf-data-url.js`（`fetch()`を使わないdata URL変換）と `pdf-frame-bridge.js` とともに上流PDF iframeとして通常表示・実行されます。外側iframeにHTML sandbox属性は付けず、Electronの `BrowserWindow`（`sandbox: true`、`nodeIntegration: false`、厳格CSP、外部要求ブロック）をプロセス境界にします。QR→PDF受渡しは検証済みpostMessageから上流UIの `#wm-img-input` へFile/DataTransferを設定します。統合アダプターと上流SHA-256は `renderer/vendor/MANIFEST.json` で追跡できます。QR APIは `https://qr-generator.kf-itdepartment.workers.dev/api/qr` に固定され、main processのQRサービスが応答を検証します。オンライン失敗時の同じ入力のローカル再生成とセッションモード切替はrendererが行います。開発者ツール・Node.js API・ファイルシステムはレンダラーへ公開していません。
画面の切替は上部に常設した5つのボタンではなく、Electronの「ツール」メニューに集約しています。「QRコード」から「素材トレイ」まで順番に並び、`CmdOrCtrl+1`〜`CmdOrCtrl+5` でも切り替えられます。QR画面にだけオンライン／オフライン切替が表示されます。「ファイル」メニューの「素材をインポート…」ではPNG・JPEG・WebP・SVGを複数選択でき、アプリがエクスポートしたZIPも読み込めます。「素材をエクスポート…」は保存済み素材を `kusunoki-material-archive` v1 の決定的なZIPにまとめます。ZIPはmanifest、パス、MIME、画像シグネチャ、SVGの安全性、件数・サイズをmain processで検証し、失敗時は既存素材を変更しません。
上流submoduleが未初期化でも、コミット済みの `renderer/generated/upstream/` と `MANIFEST.json` をSHA-256検証してそのまま使うfallbackがあります。ブラウザ用npm依存だけは毎回 `node_modules` から再ステージします。fallbackの再現確認には `KUSUNOKI_STAGE_FALLBACK=1 npm run stage:vendors`（Windows cmdでは `set KUSUNOKI_STAGE_FALLBACK=1&& npm run stage:vendors`）を使えます。

## ビルド

```bash
npm run build        # electron-builder --dir
npm run pack:dry-run # 配布物ディレクトリを作成（publishなし）
npm run pack         # Windows NSIS / macOS DMG / Linux AppImage
npm run verify:pack  # pack後にasarへ上流画面・ロゴ・同梱ライブラリが入ったことを確認
```

対象は Windows x64 NSIS、macOS x64/arm64 DMG、Linux x64 AppImage です。コード署名用の証明書はリポジトリへ置かず、リリース環境の秘密情報として設定してください。macOS の署名なしビルドはGatekeeperの警告が出るため、更新確認の「はい」は該当バージョンの `releases/tag/vX.Y.Z` を開く手動ダウンロードになります。ヘルプのReleaseリンクは一覧ページを開きます。

## 上流同期

`vendor/qr-generator`、`vendor/pdf-editor`、`vendor/pic-editor` はGit submoduleです。URLは `.gitmodules` に固定され、統合固有の変更は加えません。通常のCI/Releaseはprivate upstreamをcheckoutせず、コミット済みgeneratedファイルだけで動作します。同期ワークフローは毎時（および `workflow_dispatch`）に候補checkoutをテスト・buildし、成功した場合だけ `main` へsubmodule gitlink、generated upstream、manifestをまとめてcommitします。

```bash
git submodule update --init --recursive
npm run sync-upstreams
npm run verify:upstreams
```

ローカルの `sync-upstreams` は、4つのsubmoduleと同期対象の親repoパスがcleanであることを先に確認し、各 `origin/main` をfetchしてから取得したSHAへdetached checkoutします。その後 `stage-vendors.js` を実行し、submodule gitlinkとgenerated upstream・manifestを同じworking treeへ反映します。commit/pushは行わないため、結果を確認してから必要な変更だけを自分でcommitしてください。親repoの無関係な変更には触れません。未初期化・dirty・fetch・checkout・生成失敗時は非ゼロで終了し、fetch失敗時はcheckoutを開始しません。

`npm run verify:upstreams` は読み取り専用です。submoduleのsourceが存在する場合はcanonical LFのSHA-256でsource、manifest、generatedファイルの整合性を検証し、CIなどでsourceが利用できない場合はsource checks skippedと明示してコミット済みgenerated fallbackだけを検証します。

private upstreamをGitHub Actionsから同期する場合だけ、統合repoの Settings → Secrets and variables → Actions に `UPSTREAM_TOKEN` を登録します。Fine-grained PATまたは組織管理secretを使用し、対象は `KF-itdepartment/QR-Generator`、`KF-itdepartment/pdf-editor`、`KF-itdepartment/pic-editor`、`KF-itdepartment/analytics_url_generator`、権限は各repoの `Contents: Read` のみにしてください。Actions workflowはこのtokenをupstreamのread checkoutにだけ渡し、統合repoへのcommit/pushにはGitHub Actionsの `GITHUB_TOKEN` を使います。広範な個人OAuth tokenや書き込み権限tokenを流用しないでください。`UPSTREAM_TOKEN` が未設定なら同期jobは `private upstream sync disabled` をjob summaryへ記録して成功終了します。

## URL upstream / UPSTREAM_TOKEN

The URL shortening upstream is the third read-only submodule `vendor/analytics-url-generator` (`https://github.com/KF-itdepartment/analytics_url_generator.git`), pinned to commit `b65e77c8600572f5ddac80b4bc78dde4476b5380`. The browser picture editor is staged from the fourth application submodule `vendor/pic-editor` at commit `3d7c346`; its local-only runtime is copied to `renderer/generated/upstream/pic/`. Its `SOURCE_OPTIONS` and `MEDIUM_OPTIONS` are extracted from `src/index.js` into `renderer/generated/upstream/url/config.js`; the generated config, picture assets, and adapters are tracked by MANIFEST schema 4. UTM URL construction stays local to the renderer. Only the fixed Worker endpoint is called by the main process for shortening, and x.gd credentials remain Worker secrets.

When `UPSTREAM_TOKEN` is configured for GitHub Actions, grant read-only `Contents` access to `KF-itdepartment/QR-Generator`, `KF-itdepartment/pdf-editor`, `KF-itdepartment/pic-editor`, and `KF-itdepartment/analytics_url_generator`. The workflow passes that token only to upstream read checkouts; the integration repository continues to use `GITHUB_TOKEN` for its own commit/push.

## リリース

`.github/workflows/release.yml` は、最初の `main` 更新では `package.json` の `1.0.0` を変更せず、候補のテスト/build成功後に検証済みSHAを3OSへ渡し、全OS成果物の成功後にだけ `v1.0.0` tagとGitHub Releaseを作成します。既存tagに対応する次回以降だけpatch番号を上げ、候補のテスト/build成功後にversion commitをpushします。version commitだけに付ける `[release-version]` markerとconcurrencyでbumpの無限ループを防ぎます。公開先は `KF-itdepartment/Kusunoki-Desktop-Tools` です。

本リポジトリにはGitHubへのpushや署名資格情報を含めていません。ローカルのElectron実行・テスト・packにはGitHub認証は不要ですが、実際のRelease公開、署名、macOS公証はCIの権限と各OSの証明書が必要です。
