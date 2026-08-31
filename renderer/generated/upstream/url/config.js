'use strict';

// Generated from vendor/analytics-url-generator/src/index.js. Do not edit by hand.
(() => {
  const sourceOptions = [
  {
    "value": "twitter",
    "label": "Twitter (公式SNS)"
  },
  {
    "value": "instagram",
    "label": "Instagram (公式SNS)"
  },
  {
    "value": "youtube",
    "label": "YouTube (公式SNS)"
  },
  {
    "value": "poster",
    "label": "ポスター"
  },
  {
    "value": "pamphlet",
    "label": "パンフレット"
  },
  {
    "value": "leaflet",
    "label": "リーフレット"
  },
  {
    "value": "flyer",
    "label": "ビラ"
  },
  {
    "value": "spec",
    "label": "学校ホームページ"
  },
  {
    "value": "ticket",
    "label": "入場券"
  },
  {
    "value": "signboard",
    "label": "門・看板"
  },
  {
    "value": "other",
    "label": "その他（手入力）"
  }
];
  const mediumOptions = [
  {
    "value": "qr",
    "label": "QR (QRコード)"
  },
  {
    "value": "sns_post",
    "label": "sns_post (通常投稿のリンク)"
  },
  {
    "value": "bio",
    "label": "bio (プロフィールのリンク)"
  },
  {
    "value": "link",
    "label": "link (一般的なハイパーリンク)"
  },
  {
    "value": "other",
    "label": "other (手入力)"
  }
];
  const metadata = {
  "upstreamCommit": "b65e77c8600572f5ddac80b4bc78dde4476b5380",
  "source": "vendor/analytics-url-generator/src/index.js",
  "sourceSha256": "9f51555d91426ce44073760cf8a009fe9fba612f5e56a790941647093ed0cc17"
};
  const config = { sourceOptions, mediumOptions, SOURCE_OPTIONS: sourceOptions, MEDIUM_OPTIONS: mediumOptions, ...metadata };
  window.KusunokiUrlConfig = Object.freeze(config);
})();
