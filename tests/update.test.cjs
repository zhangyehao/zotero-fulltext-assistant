const test = require('node:test');
const assert = require('node:assert/strict');
const {create, PLUGIN_ID, RELEASE_NOTES_URL} = require('../src/update.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) {
  let clock = 0, nextTimer = 0, writes = [], requests = [], snapshots = [], launches = [];
  const timers = new Map(), installListeners = new Set(), addonListeners = new Set();
  const states = ['AVAILABLE','DOWNLOADING','CHECKING_UPDATE','DOWNLOADED','DOWNLOAD_FAILED','AWAITING_PROMPT','PROMPTS_DONE','POSTPONED','READY','INSTALLING','INSTALLED','INSTALL_FAILED','CANCELLED'];
  const manager = {AUTOUPDATE_DISABLE:0,AUTOUPDATE_DEFAULT:1,AUTOUPDATE_ENABLE:2,UPDATE_WHEN_USER_REQUESTED:1,
    updateEnabled:true, autoUpdateDefault:options.defaultAuto ?? true, installs:[], ...Object.fromEntries(states.map((name,i)=>['STATE_'+name,i])),
    async getAddonByID(id) { assert.equal(id,PLUGIN_ID);return options.missing ? null : addon; },
    async getAllInstalls() {return [...manager.installs];},
    shouldAutoUpdate(value) {return value.applyBackgroundUpdates===2 || value.applyBackgroundUpdates===1 && manager.autoUpdateDefault;},
    addAddonListener(value) {addonListeners.add(value);},removeAddonListener(value) {addonListeners.delete(value);},
    addInstallListener(value) {installListeners.add(value);},removeInstallListener(value) {installListeners.delete(value);},
  };
  let mode=options.mode??1;
  const addon={id:PLUGIN_ID,version:'0.9.0',
    get applyBackgroundUpdates(){return mode;},set applyBackgroundUpdates(value){mode=value;writes.push(value);for(const l of [...addonListeners])l.onPropertyChanged?.(addon,['applyBackgroundUpdates']);},
    findUpdates(listener,reason){requests.push({listener,reason});if(options.findThrows)throw new Error('private URL must not reach UI');},
  };
  const fire=(method,value,...args)=>{for(const l of [...installListeners]){const result=l[method]?.(value,...args);assert.notEqual(result,false,'listeners must not veto native installation');}};
  function install(version='0.10.0',extra={}) {
    const value={existingAddon:addon,version,state:manager.STATE_AVAILABLE,progress:0,maxProgress:-1,calls:0,cancels:0,
      install(){this.calls++;this.state=manager.STATE_DOWNLOADING;fire('onDownloadStarted',this);},
      cancel(){this.cancels++;this.state=manager.STATE_CANCELLED;fire('onDownloadCancelled',this);},...extra};
    manager.installs.push(value);return value;
  }
  const controller=create({AddonManager:manager,Services:{vc:{compare(a,b){const aa=a.split('.').map(Number),bb=b.split('.').map(Number);for(let i=0;i<Math.max(aa.length,bb.length);i++){const d=(aa[i]||0)-(bb[i]||0);if(d)return Math.sign(d);}return 0;}}},
    Zotero:{launchURL:url=>launches.push(url)},pluginID:PLUGIN_ID,version:'0.9.0',emit:value=>snapshots.push(value),now:()=>clock,
    setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,at:clock+ms});return id;},clearTimeout:id=>timers.delete(id),checkTimeoutMs:100,installTimeoutMs:200});
  const finish=(value,error=0,index=requests.length-1)=>{const l=requests[index].listener;if(value)l.onUpdateAvailable(addon,value);else l.onNoUpdateAvailable?.(addon);l.onUpdateFinished(addon,error);};
  async function advance(ms){clock+=ms;for(const [id,t]of[...timers])if(t.at<=clock&&timers.delete(id))t.fn();await tick();}
  return {controller,manager,addon,timers,installListeners,addonListeners,requests,snapshots,writes,launches,install,fire,finish,advance,options};
}
async function available(env){const promise=env.controller.check();await tick();const install=env.install();env.finish(install);await promise;return install;}

test('initialization reads native defaults without checking, installing, or rewriting preferences',async()=>{
  const e=setup();const s=await e.controller.initialize();assert.equal(s.state,'idle');assert.equal(s.currentVersion,'0.9.0');assert.equal(s.autoUpdate,true);assert.equal(s.canCheck,true);assert.equal(e.requests.length,0);assert.deepEqual(e.writes,[]);
  await e.controller.initialize();assert.equal(e.installListeners.size,1);assert.equal(e.addonListeners.size,1);e.controller.destroy();
});
test('manual checking does not install even with native automatic updates enabled',async()=>{
  const e=setup();const value=await available(e);const s=e.controller.getSnapshot();assert.equal(s.state,'available');assert.equal(s.availableVersion,'0.10.0');assert.equal(s.canInstall,true);assert.equal(value.calls,0);assert.equal(e.requests[0].reason,e.manager.UPDATE_WHEN_USER_REQUESTED);assert.equal(e.timers.size,0);e.controller.destroy();
});
test('overlapping checks share one native lookup and only successful completion reports current',async()=>{
  const e=setup();const a=e.controller.check(),b=e.controller.check();assert.equal(a,b);await tick();assert.equal(e.requests.length,1);e.finish(null);const s=await a;assert.equal(s.state,'current');assert.equal(s.checkedAt,new Date(0).toISOString());assert.equal(s.canCheck,true);e.controller.destroy();
});
test('onNoUpdateAvailable followed by an error is not reported as up to date',async()=>{
  const e=setup();const p=e.controller.check();await tick();e.finish(null,-2);const s=await p;assert.equal(s.state,'error');assert.equal(s.errorCode,'CHECK_FAILED');assert.equal(s.checkedAt,null);assert.equal(s.canCheck,true);e.controller.destroy();
});
test('native check exceptions are redacted and retryable',async()=>{
  const e=setup({findThrows:true});const s=await e.controller.check();assert.equal(s.errorCode,'CHECK_FAILED');assert(!s.message.includes('private URL'));assert.equal(s.canCheck,true);e.options.findThrows=false;const p=e.controller.check();await tick();e.finish(null);assert.equal((await p).state,'current');e.controller.destroy();
});
test('check timeout ignores old callbacks and permits a fresh check',async()=>{
  const e=setup();const first=e.controller.check();await tick();await e.advance(101);assert.equal((await first).errorCode,'CHECK_TIMEOUT');const second=e.controller.check();await tick();e.finish(e.install(),0,0);assert.equal(e.controller.getSnapshot().state,'checking');e.finish(null,0,1);assert.equal((await second).state,'current');e.controller.destroy();
});
test('wrong-addon update candidates are refused instead of installed',async()=>{
  const e=setup();const p=e.controller.check();await tick();const value=e.install('0.10.0',{existingAddon:{id:'unrelated@invalid'}});e.finish(value);assert.equal((await p).errorCode,'CHECK_IDENTITY');assert.equal(e.controller.getSnapshot().canInstall,false);assert.equal(value.calls,0);e.controller.destroy();
});
test('older native candidates cannot downgrade the installed version',async()=>{
  const e=setup();const p=e.controller.check();await tick();e.finish(e.install('0.8.0'));assert.equal((await p).state,'current');assert.equal(e.controller.getSnapshot().canInstall,false);e.controller.destroy();
});
test('automatic-update toggle persists only the native add-on setting and never starts a download',async()=>{
  const e=setup();await e.controller.initialize();assert.equal((await e.controller.setAutoUpdate(false)).autoUpdate,false);assert.equal((await e.controller.setAutoUpdate(true)).autoUpdate,true);assert.deepEqual(e.writes,[0,2]);assert.equal(e.requests.length,0);e.manager.updateEnabled=false;assert.equal(e.controller.getSnapshot().globalUpdatesEnabled,false);assert.equal(e.controller.getSnapshot().autoUpdate,true);await assert.rejects(e.controller.setAutoUpdate('true'),TypeError);e.controller.destroy();
});
test('rapid preference changes cannot let an older action overwrite the newer selection',async()=>{
  const e=setup();await e.controller.initialize();await Promise.all([e.controller.setAutoUpdate(true),e.controller.setAutoUpdate(false)]);assert.deepEqual(e.writes,[0]);assert.equal(e.controller.getSnapshot().autoUpdate,false);e.controller.destroy();
});
test('changes from Zotero plugin manager are reflected in the snapshot',async()=>{
  const e=setup();await e.controller.initialize();e.addon.applyBackgroundUpdates=0;assert.equal(e.controller.getSnapshot().autoUpdate,false);e.addon.applyBackgroundUpdates=1;e.manager.autoUpdateDefault=false;e.addon.applyBackgroundUpdates=1;assert.equal(e.controller.getSnapshot().autoUpdate,false);e.controller.destroy();
});
test('manual installation delegates once to native installer and reports native progress and completion',async()=>{
  const e=setup();const value=await available(e);const a=e.controller.install(),b=e.controller.install();assert.equal(a,b);assert.equal(value.calls,1);value.progress=250;value.maxProgress=1000;e.fire('onDownloadProgress',value);assert.deepEqual(e.controller.getSnapshot().progress,{received:250,total:1000,percent:25});
  value.state=e.manager.STATE_INSTALLING;e.fire('onDownloadEnded',value);e.fire('onInstallStarted',value);assert.equal(e.controller.getSnapshot().state,'installing');value.state=e.manager.STATE_INSTALLED;e.fire('onInstallEnded',value,{id:PLUGIN_ID,version:value.version});const s=await a;assert.equal(s.state,'installed');assert.equal(s.currentVersion,'0.10.0');assert.equal(s.canInstall,false);assert.equal(s.canCheck,true);assert.equal(e.timers.size,0);e.controller.destroy();
});
test('failed download and native validation failures never report successful installation',async()=>{
  const e=setup();const value=await available(e);const p=e.controller.install();value.state=e.manager.STATE_DOWNLOAD_FAILED;value.error=-2;e.fire('onDownloadFailed',value);const s=await p;assert.equal(s.errorCode,'DOWNLOAD_FAILED');assert.equal(s.currentVersion,'0.9.0');assert.equal(s.canCheck,true);assert.equal(s.canInstall,false);e.controller.destroy();
});
test('a downloaded candidate changed by another operation must be checked again',async()=>{
  const e=setup();const value=await available(e);value.state=e.manager.STATE_CANCELLED;assert.equal((await e.controller.install()).errorCode,'UPDATE_STALE');assert.equal(value.calls,0);e.controller.destroy();
});
test('native install completion for another version cannot claim success',async()=>{
  const e=setup();const value=await available(e);const p=e.controller.install();e.fire('onInstallEnded',value,{id:PLUGIN_ID,version:'0.8.0'});assert.equal((await p).errorCode,'INSTALL_IDENTITY');assert.equal(e.controller.getSnapshot().currentVersion,'0.9.0');e.controller.destroy();
});
test('download timeout uses native cancel then allows retry',async()=>{
  const e=setup();const value=await available(e);const p=e.controller.install();await e.advance(201);const s=await p;assert.equal(s.errorCode,'INSTALL_TIMEOUT');assert.equal(value.cancels,1);assert.equal(s.canCheck,true);assert.equal(s.canInstall,false);e.controller.destroy();
});
test('installation timeout never cancels replacement or allows a duplicate while native install is active',async()=>{
  const e=setup();const value=await available(e);const p=e.controller.install();value.state=e.manager.STATE_INSTALLING;e.fire('onInstallStarted',value);await e.advance(201);const s=await p;assert.equal(s.errorCode,'INSTALL_TIMEOUT');assert.equal(value.cancels,0);assert.equal(s.canCheck,false);await e.controller.install();assert.equal(value.calls,1);e.fire('onInstallEnded',value,{id:PLUGIN_ID,version:value.version});assert.equal(e.controller.getSnapshot().state,'installed');e.controller.destroy();
});
test('already running native background installation is observed without starting another lookup',async()=>{
  const e=setup();const value=e.install('0.10.0',{state:e.manager.STATE_DOWNLOADING});await e.controller.initialize();assert.equal(e.controller.getSnapshot().state,'downloading');await e.controller.check();assert.equal(e.requests.length,0);assert.equal(value.calls,0);e.controller.destroy();assert.equal(value.cancels,0);
});
test('unrelated addon install events do not alter this plugin state',async()=>{
  const e=setup();await e.controller.initialize();const value=e.install('9.0.0',{existingAddon:{id:'other@invalid'},state:e.manager.STATE_DOWNLOADING});e.fire('onDownloadStarted',value);e.fire('onDownloadFailed',value);assert.equal(e.controller.getSnapshot().state,'idle');e.controller.destroy();
});
test('native postponement exposes restart guidance without pretending installation completed',async()=>{
  const e=setup();const value=await available(e);const p=e.controller.install();value.state=e.manager.STATE_POSTPONED;e.fire('onInstallPostponed',value);const s=await p;assert.equal(s.state,'installing');assert.equal(s.restartRequired,true);assert.equal(s.currentVersion,'0.9.0');assert.equal(s.canCheck,false);e.controller.destroy();assert.equal(value.cancels,0);
});
test('destroy settles lookup and removes timers/listeners; late callbacks cannot emit',async()=>{
  const e=setup();const p=e.controller.check();await tick();const count=e.snapshots.length;e.controller.destroy();assert.equal((await p).stopped,true);assert.equal(e.timers.size,0);assert.equal(e.addonListeners.size,0);assert.equal(e.installListeners.size,0);e.finish(e.install());await tick();assert.equal(e.snapshots.length,count);assert.equal((await e.controller.check()).stopped,true);
});
test('self replacement can destroy controller without cancelling or deadlocking installation',async()=>{
  const e=setup();const value=await available(e);const p=e.controller.install();value.state=e.manager.STATE_INSTALLING;e.fire('onInstallStarted',value);const count=e.snapshots.length;e.controller.destroy();assert.equal((await p).stopped,true);assert.equal(value.cancels,0);assert.equal(e.timers.size,0);e.fire('onInstallEnded',value,{id:PLUGIN_ID,version:value.version});assert.equal(e.snapshots.length,count);
});
test('destroy while initialization is pending never registers listeners or emits afterward',async()=>{
  const e=setup();let release;e.manager.getAddonByID=()=>new Promise(resolve=>release=resolve);const p=e.controller.initialize();e.controller.destroy();release(e.addon);await p;assert.equal(e.installListeners.size,0);assert.equal(e.addonListeners.size,0);assert.equal(e.snapshots.length,0);
});
test('unavailable addon fails safely and can be retried without breaking plugin startup',async()=>{
  const e=setup({missing:true});assert.equal((await e.controller.initialize()).errorCode,'INITIALIZE_FAILED');assert.equal(e.controller.getSnapshot().canCheck,true);e.options.missing=false;const p=e.controller.check();await tick();e.finish(null);assert.equal((await p).state,'current');e.controller.destroy();
});
test('snapshots are defensive and release notes always use the fixed public entry',async()=>{
  const e=setup();const value=await available(e);const p=e.controller.install();value.progress=1;value.maxProgress=10;e.fire('onDownloadProgress',value);const copy=e.controller.getSnapshot();copy.progress.received=999;assert.equal(e.controller.getSnapshot().progress.received,1);assert.equal(e.controller.openReleaseNotes('https://untrusted.invalid'),true);assert.deepEqual(e.launches,[RELEASE_NOTES_URL]);e.controller.destroy();await p;assert.equal(e.controller.openReleaseNotes(),false);
});
test('controller rejects another plugin identity before touching native APIs',()=>{
  assert.throws(()=>create({pluginID:'other@invalid'}),/Unexpected update target/);
});
test('the production fallback imports the native ES module without constructing a custom update URL',async()=>{
  const e=setup();const imports=[];const controller=create({ChromeUtils:{importESModule(uri){imports.push(uri);return{AddonManager:e.manager};}},version:'0.9.0'});
  const s=await controller.initialize();assert.equal(s.currentVersion,'0.9.0');assert.deepEqual(imports,['resource://gre/modules/AddonManager.sys.mjs']);assert.equal(e.requests.length,0);controller.destroy();
});
test('initialization listener registration failure cleans up and allows a later retry',async()=>{
  const e=setup();const add=e.manager.addInstallListener;e.manager.addInstallListener=()=>{throw new Error('unavailable');};assert.equal((await e.controller.initialize()).state,'error');assert.equal(e.addonListeners.size,0);e.manager.addInstallListener=add;assert.equal((await e.controller.initialize()).state,'idle');assert.equal(e.addonListeners.size,1);assert.equal(e.installListeners.size,1);e.controller.destroy();
});
test('a rejected native install promise without terminal callback is still retryable',async()=>{
  const e=setup();const value=await available(e);value.install=()=>Promise.reject(new Error('native rejection with private URL'));const s=await e.controller.install();assert.equal(s.errorCode,'INSTALL_FAILED');assert.equal(s.canCheck,true);assert(!s.message.includes('private URL'));e.controller.destroy();
});
