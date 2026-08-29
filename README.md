# Kusunoki Desktop Tools

Kusunoki Desktop Tools v1.0.0 は、QRコード生成とPDF編集を一つのデスクトップシェルにまとめたElectronアプリです。QR生成・PDF処理・素材トレイはローカルで動作します。外部通信はユーザーが更新確認を実行したとき（またはパッケージ版の起動時更新確認）だけです。レンダラーはCSPとリクエストブロックで外部API/CDNを利用できません。

## 開発

```bash
npm install
npm test
npm run dev
npm run electron:smoke  # hidden-window smoke: generated PDF iframe and local libraries
```

`npm install` の `prepare` が `vendor/qr-generator/public` と `vendor/pdf-editor` の上流画面・スクリプト・ロゴを `renderer/generated/upstream/` へ展開します。QRの `batch-utils.mjs` は同じソースから `batch-utils.js` へ機械的にclassic/global変換され、シェルが実際にロードします。PDFの `index.html` / `script.js` は unpkg参照を `pdf-lib`、`pdfjs-dist@3.11.174`、`jszip` のnpm同梱ファイルへ変換し、生成された `pdf-data-url.js`（`fetch()`を使わないdata URL変換）と `pdf-frame-bridge.js` とともに上流PDF iframeとして通常表示・実行されます。外側iframeにHTML sandbox属性は付けず、Electronの `BrowserWindow`（`sandbox: true`、`nodeIntegration: false`、厳格CSP、外部要求ブロック）をプロセス境界にします。QR→PDF受渡しは検証済みpostMessageから上流UIの `#wm-img-input` へFile/DataTransferを設定します。統合アダプターと上流SHA-256は `renderer/vendor/MANIFEST.json` で追跡できます。単体QRの生成は上流画面のHTTP API依存を持ち込まず、ローカル `electron/qr-service.js` adapter（同期時はQR機能テストとmanifest確認）を使用します。開発者ツール・Node.js API・ファイルシステムはレンダラーへ公開していません。

## ビルド

```bash
npm run build        # electron-builder --dir
npm run pack:dry-run # 配布物ディレクトリを作成（publishなし）
npm run pack         # Windows NSIS / macOS DMG / Linux AppImage
npm run verify:pack  # pack後にasarへ上流画面・ロゴ・同梱ライブラリが入ったことを確認
```

対象は Windows x64 NSIS、macOS x64/arm64 DMG、Linux x64 AppImage です。コード署名用の証明書はリポジトリへ置かず、リリース環境の秘密情報として設定してください。macOS の署名なしビルドはGatekeeperの警告が出るため、更新確認の「はい」は該当バージョンの `releases/tag/vX.Y.Z` を開く手動ダウンロードになります。ヘルプのReleaseリンクは一覧ページを開きます。

## 上流同期

`vendor/qr-generator` と `vendor/pdf-editor` はGit submoduleです。URLは `.gitmodules` に固定され、統合固有の変更は加えません。同期ワークフローは毎時（および `workflow_dispatch`）に候補checkoutをテスト・buildし、成功した場合だけ `main` へsubmodule gitlinkをcommitします。GitHub認証のないローカル環境では次の確認だけ行えます。

```bash
git submodule update --init --recursive
npm run sync-upstreams
```

## リリース

`.github/workflows/release.yml` は、最初の `main` 更新では `package.json` の `1.0.0` を変更せず、候補のテスト/build成功後に検証済みSHAを3OSへ渡し、全OS成果物の成功後にだけ `v1.0.0` tagとGitHub Releaseを作成します。既存tagに対応する次回以降だけpatch番号を上げ、候補のテスト/build成功後にversion commitをpushします。version commitだけに付ける `[release-version]` markerとconcurrencyでbumpの無限ループを防ぎます。公開先は `KF-itdepartment/Kusunoki-Desktop-Tools` です。

本リポジトリにはGitHubへのpushや署名資格情報を含めていません。ローカルのElectron実行・テスト・packにはGitHub認証は不要ですが、実際のRelease公開、署名、macOS公証はCIの権限と各OSの証明書が必要です。
