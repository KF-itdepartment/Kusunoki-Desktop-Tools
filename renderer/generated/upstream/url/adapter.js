'use strict';

// Generated from the analytics URL upstream config. Do not edit by hand.
(() => {
  const config = window.KusunokiUrlConfig;
  if (!config || !Array.isArray(config.sourceOptions) || !Array.isArray(config.mediumOptions)) throw new Error('生成済みURL設定を読み込めません。');
  window.KusunokiGeneratedUrl = Object.freeze({ config, source: 'generated/upstream/url/config.js', sourceHash: config.sourceSha256 });
})();
