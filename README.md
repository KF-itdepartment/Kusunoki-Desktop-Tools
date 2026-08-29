# Kusunoki Desktop Tools

Kusunoki Desktop Tools v1.0.0 は、QRコード生成とPDF編集を一つのデスクトップシェルにまとめたElectronアプリです。QR生成・PDF処理・素材トレイはローカルで動作します。外部通信はユーザーが更新確認を実行したとき（またはパッケージ版の起動時更新確認）だけです。レンダラーはCSPとリクエストブロックで外部API/CDNを利用できません。

## 開発

```bash
npm install
npm test
npm run dev
```

`npm install` の `prepare` が `pdfjs-dist@3.11.174` と `jszip@3.10.1` のブラウザー用ファイルを `renderer/vendor/` へステージします。開発者ツール・Node.js API・ファイルシステムはレンダラーへ公開していません。

## ビルド

```bash
npm run build        # electron-builder --dir
npm run pack:dry-run # 配布物ディレクトリを作成（publishなし）
npm run pack         # Windows NSIS / macOS DMG / Linux AppImage
```

対象は Windows x64 NSIS、macOS x64/arm64 DMG、Linux x64 AppImage です。コード署名用の証明書はリポジトリへ置かず、リリース環境の秘密情報として設定してください。macOS の署名なしビルドはGatekeeperの警告が出るため、更新確認の「はい」はGitHub Releaseページを開く手動ダウンロードになります。

## 上流同期

`vendor/qr-generator` と `vendor/pdf-editor` はGit submoduleです。URLは `.gitmodules` に固定され、統合固有の変更は加えません。同期ワークフローは毎時（および `workflow_dispatch`）に候補checkoutをテスト・buildし、成功した場合だけ `main` へsubmodule gitlinkをcommitします。GitHub認証のないローカル環境では次の確認だけ行えます。

```bash
git submodule update --init --recursive
npm run sync-upstreams
```

## リリース

`.github/workflows/release.yml` は `main` 更新時にパッチ番号を自動採番し、`vX.Y.Z` tagを作成して3OSの成果物とelectron-builderの更新メタデータをGitHub Releaseへ公開します。version commitだけに付ける `[release-version]` markerでbumpの無限ループを防ぎます。公開先は `KF-itdepartment/Kusunoki-Desktop-Tools` です。

本リポジトリにはGitHubへのpushや署名資格情報を含めていません。ローカルのElectron実行・テスト・packにはGitHub認証は不要ですが、実際のRelease公開、署名、macOS公証はCIの権限と各OSの証明書が必要です。
