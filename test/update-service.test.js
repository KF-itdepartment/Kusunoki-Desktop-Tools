const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateService, releaseTagUrl } = require('../electron/update-service');

function setup({ packaged = false, platform = 'win32', response = null, answer = 1 } = {}) {
  const events = new EventEmitter(); const calls=[];
  const updater = Object.assign(events, { autoDownload:false, autoInstallOnAppQuit:false, checkForUpdates:async()=>response, downloadUpdate:async()=>calls.push('download'), quitAndInstall:()=>calls.push('install') });
  const app={isPackaged:packaged,getVersion:()=> '1.0.0'}; const dialog={showMessageBox:async()=>({response:answer})}; const shell={openExternal:async(url)=>calls.push(`open:${url}`)};
  return { service:createUpdateService({app,autoUpdater:updater,dialog,shell,processPlatform:platform,logger:{warn:()=>{}}}),calls };
}

test('development update checks are disabled and no-update is handled', async () => {
  assert.deepEqual(await setup().service.check(), { status:'disabled', reason:'development' });
  const { service } = setup({ packaged:true, response:{updateInfo:{version:'1.0.0'}} });
  assert.deepEqual(await service.check(), { status:'none' });
});

test('Windows update asks, downloads and installs; refusal is held', async () => {
  const accepted=setup({packaged:true,response:{updateInfo:{version:'1.1.0'}},answer:0}); assert.equal((await accepted.service.check()).status,'installing'); assert.deepEqual(accepted.calls,['download','install']);
  const refused=setup({packaged:true,response:{updateInfo:{version:'1.1.0'}},answer:1}); assert.equal((await refused.service.check()).status,'refused'); assert.deepEqual(await refused.service.check(),{status:'skipped',reason:'refused-this-launch'});
});

test('unsigned mac update opens the versioned release page manually', async () => {
  const { service, calls }=setup({packaged:true,platform:'darwin',response:{updateInfo:{version:'1.1.0'}},answer:0}); const result=await service.check(); assert.equal(result.status,'manual'); assert.equal(calls[0],'open:https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/tag/v1.1.0'); assert.equal(result.url,'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/tag/v1.1.0');
});

test('release tag URL accepts semver and rejects URL injection', () => {
  assert.equal(releaseTagUrl('v2.3.4'), 'https://github.com/KF-itdepartment/Kusunoki-Desktop-Tools/releases/tag/v2.3.4');
  assert.throws(() => releaseTagUrl('2.3.4/../../evil'), /不正/);
});
