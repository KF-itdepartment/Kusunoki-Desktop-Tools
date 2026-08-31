'use strict';

(function exposeUrlUtils(globalObject, factory) {
  const api = factory(globalObject);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (globalObject) globalObject.KusunokiUrlUtils = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, (globalObject) => {
  const fallbackConfig = {
    sourceOptions: [
      { value: 'twitter', label: 'Twitter (公式SNS)' },
      { value: 'instagram', label: 'Instagram (公式SNS)' },
      { value: 'youtube', label: 'YouTube (公式SNS)' },
      { value: 'poster', label: 'ポスター' },
      { value: 'pamphlet', label: 'パンフレット' },
      { value: 'leaflet', label: 'リーフレット' },
      { value: 'flyer', label: 'ビラ' },
      { value: 'spec', label: '学校ホームページ' },
      { value: 'ticket', label: '入場券' },
      { value: 'signboard', label: '門・看板' },
      { value: 'other', label: 'その他（手入力）' }
    ],
    mediumOptions: [
      { value: 'qr', label: 'QR (QRコード)' },
      { value: 'sns_post', label: 'sns_post (通常投稿のリンク)' },
      { value: 'bio', label: 'bio (プロフィールのリンク)' },
      { value: 'link', label: 'link (一般的なハイパーリンク)' },
      { value: 'other', label: 'other (手入力)' }
    ]
  };
  const config = globalObject?.KusunokiUrlConfig || fallbackConfig;
  const sourceOptions = Array.isArray(config.sourceOptions) ? config.sourceOptions.map((item) => ({ value: String(item.value), label: String(item.label) })) : fallbackConfig.sourceOptions;
  const mediumOptions = Array.isArray(config.mediumOptions) ? config.mediumOptions.map((item) => ({ value: String(item.value), label: String(item.label) })) : fallbackConfig.mediumOptions;
  const sourceValues = new Set(sourceOptions.map((item) => item.value));
  const mediumValues = new Set(mediumOptions.map((item) => item.value));
  const SHORTID_PATTERN = /^[0-9a-zA-Z_]{6,15}$/u;

  function invalid(code, message) {
    const error = new TypeError(message);
    error.code = code;
    return error;
  }

  function validateBaseUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) throw invalid('base-url-required', 'base URLを入力してください。');
    let url;
    try {
      url = new URL(text);
    } catch {
      throw invalid('base-url-invalid', 'base URLが正しいURL形式ではありません。');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw invalid('base-url-scheme', 'base URLはHTTPまたはHTTPSで入力してください。');
    }
    return url;
  }

  function resolveOptionValue(value, custom, kind) {
    const source = kind === 'source';
    const values = source ? sourceValues : mediumValues;
    const name = source ? 'utm_source' : 'utm_medium';
    const selected = String(value ?? '').trim();
    if (!values.has(selected)) throw invalid(`${kind}-invalid`, `${name}の選択値が不正です。`);
    if (selected !== 'other') return selected;
    const resolved = String(custom ?? '').trim();
    if (!resolved) throw invalid(`${kind}-custom-required`, `${name}の手入力値を入力してください。`);
    return resolved;
  }

  function validateCampaign(value) {
    const campaign = String(value ?? '').trim();
    if (!campaign) throw invalid('campaign-required', 'キャンペーン名を入力してください。');
    return campaign;
  }

  function buildUtmUrl(baseUrl, valuesOrSource, mediumArg, campaignArg, sourceCustomArg, mediumCustomArg) {
    const values = valuesOrSource && typeof valuesOrSource === 'object' && !Array.isArray(valuesOrSource)
      ? valuesOrSource
      : {
        source: valuesOrSource,
        medium: mediumArg,
        campaign: campaignArg,
        sourceCustom: sourceCustomArg,
        mediumCustom: mediumCustomArg
      };
    const url = validateBaseUrl(baseUrl);
    const source = resolveOptionValue(values.source, values.sourceCustom, 'source');
    const medium = resolveOptionValue(values.medium, values.mediumCustom, 'medium');
    const campaign = validateCampaign(values.campaign);
    // URLSearchParams.set preserves all unrelated query parameters and the
    // URL hash while replacing any existing UTM key deterministically.
    url.searchParams.set('utm_source', source);
    url.searchParams.set('utm_medium', medium);
    url.searchParams.set('utm_campaign', campaign);
    return url.toString();
  }

  function validateShortid(value) {
    const shortid = String(value ?? '').trim();
    if (!shortid) return '';
    if (!SHORTID_PATTERN.test(shortid)) throw invalid('shortid-invalid', 'shortidは6〜15文字の英数字または_で入力してください。');
    return shortid;
  }

  return {
    DEFAULTS: Object.freeze({
      baseUrl: 'https://kusunokisai.com',
      source: 'twitter',
      medium: 'qr',
      campaign: 'kusunoki2026'
    }),
    SHORTID_PATTERN,
    sourceOptions: Object.freeze(sourceOptions.map((item) => Object.freeze(item))),
    mediumOptions: Object.freeze(mediumOptions.map((item) => Object.freeze(item))),
    validateBaseUrl,
    resolveOptionValue,
    validateCampaign,
    buildUtmUrl,
    validateShortid
  };
});
