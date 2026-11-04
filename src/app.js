(function(scope){
"use strict";
const MODEL=scope.FulltextTaskModel, ORIGIN="https://www.ablesci.com", PREF="extensions.fulltext-assistant.", PANE="fulltext-assistant-preferences";
function create({Zotero,Services,IOUtils,PathUtils,rootURI,pluginID,version}){
  let tasks=[],intents={},messages=[],settings={points:10,pollSeconds:60,autoDownload:true};
  let account={status:"signed_out",message:"绑定科研通后可以求助、接收消息和下载应助文件。",username:"",hasSavedPassword:false};
  let messagesStatus={state:"idle",message:"登录后显示站内消息",lastCheckedAt:null};
  let credentials,session,adapter,publisher,publisherWindow,siteWindow,siteBrowser,activePageTaskId=null,selectedTaskId=null;
  let stopped=false,timer,pumping=false,polling=false,saveChain=Promise.resolve(),intentChain=Promise.resolve(),loginPromise=null,accountEpoch=0;
  const listeners=new Set(),menuIDs=[],active=new Set(),cancellations=new Map();
  const dataDir=PathUtils.join(Zotero.DataDirectory.dir,"fulltext-assistant"),queuePath=PathUtils.join(dataDir,"tasks.json"),intentPath=PathUtils.join(dataDir,"submission-intents.json");
  const now=()=>new Date().toISOString();
  const parseHTML=html=>new (Zotero.getMainWindow()?.DOMParser||Services.appShell.hiddenDOMWindow.DOMParser)().parseFromString(html,"text/html");
  function emit(){if(!stopped)for(const f of listeners){try{f(api.getSnapshot());}catch(e){Zotero.logError(e);}}}
  function safeError(e){return String(e?.message||e||"操作未完成").replace(/https?:\/\/[^\s]*[?][^\s]*/g,"[请求地址]").slice(0,600);}
  function save(){const value=MODEL.serializeQueue(tasks);saveChain=saveChain.catch(()=>{}).then(async()=>{await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});await IOUtils.writeUTF8(queuePath,value,{tmpPath:queuePath+".tmp"});});return saveChain;}
  function taskById(id){const task=tasks.find(t=>t.id===id);if(!task)throw new Error("任务不存在。");return task;}
  async function update(id,patch){const i=tasks.findIndex(t=>t.id===id);if(i<0)return null;tasks[i]=MODEL.updateTask(tasks[i],patch);await save();emit();return tasks[i];}
  function abortIf(id,ticket){if(stopped||cancellations.get(id)!==ticket||taskById(id).state==="paused"){const e=new Error("任务已暂停");e.name="AbortError";throw e;}}
  function accountCurrent(epoch){if(epoch!==accountEpoch||stopped){const e=new Error("账号会话已改变，请重新操作。");e.name="AbortError";throw e;}}
  async function pauseAccountTasks(){
    const affected=tasks.filter(t=>(t.allowAssist||t.requestID)&&!["imported","closed"].includes(t.state));
    for(const t of affected)cancellations.set(t.id,(cancellations.get(t.id)||0)+1);
    for(const t of affected)await update(t.id,{state:["submitting","submission_unknown"].includes(t.state)?"submission_unknown":"paused",nextCheckAt:null,lastError:"账号已退出或切换；确认账号后可重试此任务。"});
  }
  const intentStore={
    async get(key){await intentChain;return intents[key]||null;},
    async claim(key,record){let result=false;const op=intentChain.catch(()=>{}).then(async()=>{if(Object.hasOwn(intents,key)&&!["cancelled_before_send","rejected"].includes(intents[key].state))return;const next={...intents,[key]:record};await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});await IOUtils.writeUTF8(intentPath,JSON.stringify(next),{tmpPath:intentPath+".tmp"});intents=next;result=true;});intentChain=op;await op;return result;},
    async set(key,record){const op=intentChain.catch(()=>{}).then(async()=>{const next={...intents,[key]:record};await IOUtils.writeUTF8(intentPath,JSON.stringify(next),{tmpPath:intentPath+".tmp"});intents=next;});intentChain=op;await op;}
  };
  function hasProtectedIntent(task){return Object.values(intents).some(intent=>intent.doi===task.doi&&!["cancelled_before_send","rejected"].includes(intent.state));}
  function itemDOI(item){try{return MODEL.normalizeDOI(item.getField("DOI")||item.getExtraField?.("DOI"));}catch(_){throw new Error("当前条目的 DOI 无效，请核对后重试。");}}
  async function linkedItem(task,doi){
    if(!task.itemID)return null;
    const item=await Zotero.Items.getAsync(task.itemID);
    if(!item||item.deleted||item.key!==task.itemKey||item.libraryID!==task.libraryID)throw new Error("原文献条目已删除或发生变化。");
    const currentDOI=itemDOI(item);
    if(currentDOI&&doi&&currentDOI!==MODEL.normalizeDOI(doi))throw new Error("当前 Zotero 条目 DOI 与求助文献不一致，已停止关联或下载，请核对条目。");
    return item;
  }
  async function bindRequest(id,reference,patch={}){
    const parsed=MODEL.parseRequestURL(reference.requestURL),duplicate=tasks.find(t=>t.id!==id&&t.requestID===parsed.requestID);
    if(duplicate?.itemID)throw new Error("该求助已关联另一个条目，请使用已有附件或在文库合并重复项。");
    if(duplicate&&active.has(duplicate.id))throw new Error("此求助正在检查，请等待检查完成后再关联。");
    if(duplicate)tasks=tasks.filter(t=>t.id!==duplicate.id);
    return update(id,{...parsed,...patch});
  }
  async function transport({url,method="GET",body,headers,responseType="text"}){const xhr=await session.request(method,url,{body,headers,responseType,timeout:25000,successCodes:false});return{url:xhr.responseURL||url,status:xhr.status,text:responseType==="text"?xhr.responseText:undefined,data:responseType!=="text"?xhr.response:undefined,headers:{"content-type":xhr.getResponseHeader("Content-Type")||""}};}
  function registerMenu(menuID,label,command){const id=Zotero.MenuManager.registerMenu({menuID,pluginID,target:"main/library/item",menus:[{menuType:"menuitem",onShowing(e,c){c.menuElem.setAttribute("label",typeof label==="function"?label():label);c.setEnabled((c.items||[]).some(i=>i.isRegularItem()));},onCommand(e,c){Promise.resolve(command(c.items||[])).catch(error=>Services.prompt.alert(null,"全文助手",safeError(error)));}}]});if(id)menuIDs.push(id);}
  function schedulePump(){Promise.resolve().then(()=>pump()).catch(e=>Zotero.logError(new Error(safeError(e))));}
  async function pump(){if(pumping||stopped)return;pumping=true;try{while(!stopped){const batch=tasks.filter(t=>t.state==="queued"&&!active.has(t.id)).slice(0,2);if(!batch.length)break;await Promise.all(batch.map(t=>runTask(t.id)));}}finally{pumping=false;}}
  async function importResponse(task,download,ticket){
    if(!task.itemID)throw new Error("此求助尚未关联 Zotero 条目，请从文库条目右键发起或关联。");
    const item=await linkedItem(task,task.doi);
    const library=Zotero.Libraries.get(item.libraryID);if(!library?.editable||!library?.filesEditable)throw new Error("此文库不允许保存附件。");
    const existing=await item.getBestAttachment();if(existing?.attachmentContentType==="application/pdf"&&await existing.fileExists())return existing;
    const url=new URL(download.url);if(url.protocol!=="https:"||url.username||url.password)throw new Error("下载地址无效。");
    const options={responseType:"arraybuffer",timeout:60000,headers:download.headers||{},body:download.body};
    // Domain-scoped Gecko cookies; no account Cookie header is sent to a CDN.
    const xhr=url.origin===ORIGIN?await session.request(download.method||"GET",url.href,options):await Zotero.HTTP.request("GET",url.href,{...options,debug:false,logBodyLength:0,errorDelayMax:0,noRetryOnThrottle:true});
    abortIf(task.id,ticket);const bytes=new Uint8Array(xhr.response);
    const finalURL=new URL(xhr.responseURL||url.href);
    if(finalURL.protocol!=="https:"||finalURL.username||finalURL.password||!(download.allowedOrigins||[url.origin]).includes(finalURL.origin))throw new Error("文件响应跳转到了未核实的下载服务器，已停止导入。");
    if(Number.isSafeInteger(download.expectedSize)&&download.expectedSize>0&&bytes.length!==download.expectedSize)throw new Error("下载文件大小与网站记录不一致，请重试或在网页核对文件。");
    if(!scope.FulltextPublisher.validPDF(bytes))throw new Error("下载返回的不是完整有效的 PDF，可能需要重新登录或在网站完成验证。");
    const current=await linkedItem(task,task.doi),currentLibrary=Zotero.Libraries.get(task.libraryID);
    if(!current||current.deleted||current.key!==task.itemKey||current.libraryID!==task.libraryID||!currentLibrary?.editable||!currentLibrary?.filesEditable)throw new Error("下载期间原条目或文库权限发生变化，已停止导入。");
    const tempDir=(await Zotero.Attachments.createTemporaryStorageDirectory()).path,file=PathUtils.join(tempDir,"fulltext.pdf");
    try{await IOUtils.write(file,bytes);abortIf(task.id,ticket);const duplicate=await current.getBestAttachment();if(duplicate?.attachmentContentType==="application/pdf"&&await duplicate.fileExists())return duplicate;const finalItem=await linkedItem(task,task.doi),finalLibrary=Zotero.Libraries.get(task.libraryID);if(!finalLibrary?.editable||!finalLibrary?.filesEditable)throw new Error("导入前文库权限发生变化，已停止导入。");abortIf(task.id,ticket);return await Zotero.Attachments.importFromFile({file,parentItemID:finalItem.id,title:"全文",contentType:"application/pdf",fileBaseName:Zotero.Attachments.getFileBaseNameFromItem(finalItem)});}
    finally{await IOUtils.remove(tempDir,{recursive:true,ignoreAbsent:true}).catch(()=>{});}
  }
  async function checkRemote(id,ticket,{forceDownload=false}={}){
    const task=taskById(id),result=await adapter.getRequest(task.requestID);abortIf(id,ticket);
    if(task.doi&&result.doi&&MODEL.normalizeDOI(task.doi)!==MODEL.normalizeDOI(result.doi))throw new Error("求助页面 DOI 与原条目不一致，已停止下载，请核对关联。");
    await linkedItem(task,result.doi||task.doi);abortIf(id,ticket);
    const files=(result.files||[]).filter(f=>!["reject","withdraw"].includes(f.status));const available=result.state==="available"&&files.length>0;
    await update(id,{state:available?"available":result.state==="closed"?"closed":"waiting",doi:task.doi||result.doi||"",attempts:0,lastCheckedAt:now(),nextCheckAt:result.state==="closed"?null:new Date(Date.now()+settings.pollSeconds*1000).toISOString(),lastError:result.state==="closed"?"历史求助已关闭或文件已过期，请打开求助网页处理；插件不会自动重复发布。":""});
    if(!available||(!settings.autoDownload&&!forceDownload)||!task.itemID)return;
    if(account.status!=="authenticated"){await update(id,{state:"pending_login",lastError:"已有人应助；登录科研通后可下载。"});return;}
    await update(id,{state:"downloading"});abortIf(id,ticket);let lastError;
    for(const file of files){try{const download=await adapter.getDownload(result,file);abortIf(id,ticket);const attachment=await importResponse({...task,doi:result.doi||task.doi},download,ticket);await update(id,{state:"imported",source:"ablesci",attachmentID:attachment.id,nextCheckAt:null,lastError:""});return;}catch(e){if(e.name==="AbortError")throw e;lastError=e;}}
    throw lastError||new Error("暂未找到可下载的 PDF。");
  }
  async function runTask(id,options={}){
    if(active.has(id)||stopped)return;active.add(id);const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);
    try{
      let task=taskById(id);if(task.requestID){await checkRemote(id,ticket,options);return;}
      const item=await Zotero.Items.getAsync(task.itemID);if(!item||item.deleted||item.key!==task.itemKey||item.libraryID!==task.libraryID)throw new Error("原文献条目不存在。");
      const library=Zotero.Libraries.get(item.libraryID);if(!library.editable||!library.filesEditable)throw new Error("此文库不允许保存附件。");
      let currentDOI="";try{currentDOI=MODEL.normalizeDOI(item.getField("DOI")||item.getExtraField?.("DOI"));}catch(_){}
      await update(id,{doi:currentDOI,title:item.getField("title"),officialURL:item.getField("url")});abortIf(id,ticket);
      await update(id,{state:"resolving",lastError:"正在从论文网页查找全文…"});abortIf(id,ticket);
      const acquired=await publisher.acquire(item,{isCancelled:()=>stopped||cancellations.get(id)!==ticket,onProgress(info){if(cancellations.get(id)===ticket)update(id,{lastError:info.message}).catch(()=>{});}});abortIf(id,ticket);
      if(acquired.attachmentID){await update(id,{state:"imported",attachmentID:acquired.attachmentID,source:acquired.source,nextCheckAt:null,lastError:""});return;}
      task=taskById(id);if(!task.allowAssist){await update(id,{state:acquired.state==="needs_login"?"needs_login":"not_found",lastError:acquired.message,nextCheckAt:null});return;}
      if(!task.doi){await update(id,{state:"needs_review",lastError:"条目缺少 DOI，请补全后再发起科研通求助。"});return;}
      if(!(await api.refreshAccount()).authenticated){await update(id,{state:"pending_login",lastError:"网页未获取到全文。请先在设置中登录科研通。"});return;}
      const previous=await adapter.findExistingRequest(task.doi);abortIf(id,ticket);
      if(previous){await bindRequest(id,previous,{state:"waiting",lastError:""});await checkRemote(id,ticket);return;}
      await update(id,{state:"submitting",lastError:"正在按任务记录的积分发起求助…"});abortIf(id,ticket);
      const posted=await adapter.submitRequest({doi:task.doi,points:task.requestedPoints,title:task.title,isCancelled:()=>stopped||cancellations.get(id)!==ticket});
      // Preserve the remote identity even when paused while a submission was in flight.
      await bindRequest(id,posted,{state:cancellations.get(id)===ticket?"waiting":"paused",nextCheckAt:new Date(Date.now()+settings.pollSeconds*1000).toISOString(),lastError:""});abortIf(id,ticket);await checkRemote(id,ticket);
    }catch(e){if(e.name!=="AbortError"&&!stopped){const task=taskById(id),auth=/AUTH|LOGIN/.test(e.code||""),uncertain=e.reconcileRequired===true||/UNKNOWN|UNCERTAIN|DUPLICATE_INTENT|SUBMISSION_MISMATCH/.test(e.code||"");if(cancellations.get(id)!==ticket&&!uncertain)return;const transient=!!task.requestID&&e.retryable===true&&!auth&&!uncertain,attempts=task.attempts+1,retrySeconds=Math.min(3600,settings.pollSeconds*2**Math.min(attempts-1,6));await update(id,{state:auth?"pending_login":uncertain?"submission_unknown":transient?"waiting":"error",lastError:(transient?"检查暂时失败，将在 "+retrySeconds+" 秒后重试。":"")+safeError(e),attempts,nextCheckAt:transient?new Date(Date.now()+retrySeconds*1000).toISOString():null});}}
    finally{active.delete(id);emit();}
  }
  async function poll(){if(stopped||polling)return;polling=true;try{for(const t of tasks.filter(t=>t.requestID&&["waiting","available","ready_to_check"].includes(t.state)&&(!t.nextCheckAt||Date.parse(t.nextCheckAt)<=Date.now()))){if(stopped)break;await runTask(t.id);await Zotero.Promise.delay(1200);}if(account.status==="authenticated"&&(!messagesStatus.lastCheckedAt||Date.now()-Date.parse(messagesStatus.lastCheckedAt)>=settings.pollSeconds*1000))await api.refreshMessages().catch(()=>{});}finally{polling=false;}}
  function wrapped(values){const o={...values};o.wrappedJSObject=o;return o;}
  const api={
    async start(){
      try{settings.points=MODEL.validatePoints(Services.prefs.getIntPref(PREF+"points",10));}catch(_){settings.points=10;}
      settings.pollSeconds=Math.max(60,Math.min(3600,Services.prefs.getIntPref(PREF+"pollSeconds",60)));settings.autoDownload=Services.prefs.getBoolPref(PREF+"autoDownload",true);
      if(await IOUtils.exists(queuePath))tasks=MODEL.deserializeQueue(await IOUtils.readUTF8(queuePath)).tasks;
      if(await IOUtils.exists(intentPath)){const data=JSON.parse(await IOUtils.readUTF8(intentPath));if(data&&typeof data==="object"&&!Array.isArray(data))intents=data;}
      tasks=tasks.map(t=>MODEL.updateTask(t,{state:t.state==="submitting"?"submission_unknown":["resolving","downloading"].includes(t.state)?"queued":t.state}));
      credentials=scope.FulltextCredentials.create({Services});session=scope.FulltextSession.create({Zotero,Services,rootURI,credentials});await session.initialize();
      const summary=await credentials.getSummary();account.username=summary.username;account.hasSavedPassword=summary.saved;
      adapter=scope.FulltextAbleSci.create({request:transport,parseHTML,model:MODEL,intentStore});publisher=scope.FulltextPublisher.create({Zotero,Services,IOUtils,PathUtils,parseHTML});
      publisherWindow=scope.FulltextPublisherWindow.create({Zotero,Services,rootURI});
      registerMenu("fulltext-assistant-get","全文助手：批量获取全文",items=>api.captureItems(items));
      registerMenu("fulltext-assistant-ask",()=>"全文助手：网页优先，科研通兜底（"+settings.points+" 积分）",items=>api.captureItems(items,{allowAssist:true}));
      registerMenu("fulltext-assistant-status","全文助手：查看任务与设置",()=>api.openPreferences());
      await Zotero.PreferencePanes.register({id:PANE,pluginID,src:"ui/preferences.xhtml",label:"全文助手",image:"assets/icon-32.png",scripts:["ui/prefs.js"],stylesheets:["ui/prefs.css"]});
      timer=setInterval(()=>poll().catch(e=>Zotero.logError(new Error(safeError(e)))),15000);await save();
      if(session.getStatus().hasCookies)api.refreshAccount().then(()=>poll()).catch(()=>{});schedulePump();
    },
    getSnapshot(){return{version,tasks:tasks.map(t=>({...t})),settings:{...settings},session:{...account,persistent:true,storageError:session?.getStatus().error},messages:messages.map(m=>({...m})),messagesStatus:{...messagesStatus},selectedTaskId};},
    subscribe(f){listeners.add(f);return()=>listeners.delete(f);},getSelectedTask(){return tasks.find(t=>t.id===selectedTaskId)||null;},selectTask(id){taskById(id);selectedTaskId=id;emit();},
    openPreferences(){Zotero.Utilities.Internal.openPreferences(PANE);},openWindow(){return api.openPreferences();},
    async saveSettings(value){const points=MODEL.validatePoints(value.points??settings.points),seconds=Number(value.pollSeconds??settings.pollSeconds);if(!Number.isInteger(seconds)||seconds<60||seconds>3600)throw new Error("检查间隔应为 60–3600 秒的整数。");settings={points,pollSeconds:seconds,autoDownload:value.autoDownload??settings.autoDownload};Services.prefs.setIntPref(PREF+"points",points);Services.prefs.setIntPref(PREF+"pollSeconds",seconds);Services.prefs.setBoolPref(PREF+"autoDownload",settings.autoDownload);emit();},
    async captureItems(items,{allowAssist=false}={}){
      for(const item of items.filter(i=>i.isRegularItem())){let doi="";try{doi=MODEL.normalizeDOI(item.getField("DOI")||item.getExtraField?.("DOI"));}catch(_){}const r=MODEL.addTask(tasks,{libraryID:item.libraryID,itemID:item.id,itemKey:item.key,doi,title:item.getField("title"),officialURL:item.getField("url"),state:"queued",requestedPoints:settings.points,allowAssist});tasks=r.tasks;selectedTaskId=r.task.id;if(!r.added&&!["imported","submitting","submission_unknown"].includes(r.task.state)&&!active.has(r.task.id))await update(r.task.id,{state:"queued",allowAssist:allowAssist||r.task.allowAssist,lastError:"",...(allowAssist&&!r.task.requestID&&!hasProtectedIntent(r.task)?{requestedPoints:settings.points}:{})});}
      await save();emit();api.openPreferences();schedulePump();
    },
    async requestAssist(value,{points}={}){
      const ids=Array.from(new Set(Array.isArray(value)?value:[value]));
      const amount=points===undefined?null:MODEL.validatePoints(points);
      const accepted=[],skipped=[];
      for(const id of ids){
        const t=taskById(id);
        if(!t.doi||t.attachmentID||t.requestID||active.has(id)||!["not_found","needs_login","pending_login","paused","error"].includes(t.state)){
          skipped.push(id);continue;
        }
        if(amount!==null&&hasProtectedIntent(t)){skipped.push(id);continue;}
        await update(id,{allowAssist:true,state:"queued",lastError:"",...(amount===null?{}:{requestedPoints:amount})});accepted.push(id);
      }
      schedulePump();return {accepted:accepted.length,skipped:skipped.length,acceptedIDs:accepted,skippedIDs:skipped};
    },
    async checkTask(id){const task=taskById(id);if(task.state==="submission_unknown"){const previous=await adapter.findExistingRequest(task.doi);if(!previous)throw new Error("尚未找到匹配的已发布求助。请在网站核对，不会自动重复提交。");await bindRequest(id,previous,{state:"waiting"});}if(taskById(id).requestID)await runTask(id);else await api.retryTask(id);},
    async downloadTask(id){const task=taskById(id);if(!task.requestID||!task.itemID)throw new Error("请先将可下载求助关联到文库条目。");if(!(await api.refreshAccount()).authenticated)throw new Error("请先登录科研通。");await runTask(id,{forceDownload:true});},
    async retryTask(id,{points}={}){const t=taskById(id);if(t.state==="submission_unknown")return api.checkTask(id);if(active.has(id))return;const patch={state:"queued",lastError:""};if(points!==undefined&&!t.requestID){if(hasProtectedIntent(t))throw new Error("此文献已有提交记录，请先检查已发布求助，不能更改其悬赏积分。");patch.requestedPoints=MODEL.validatePoints(points);}await update(id,patch);schedulePump();},
    async pauseTask(id){cancellations.set(id,(cancellations.get(id)||0)+1);await update(id,{state:"paused",nextCheckAt:null,lastError:"本地已暂停，网站上的求助保持原状态。"});},
    async addExistingRequest(url,itemTaskId){
      const parsed=MODEL.parseRequestURL(url);
      const targetNow=()=>{const target=itemTaskId?taskById(itemTaskId):null;if(target?.requestID&&target.requestID!==parsed.requestID)throw new Error("此条目已关联另一个求助，不能覆盖现有关联。");if(target&&!target.requestID&&active.has(target.id))throw new Error("此任务正在处理，请先暂停任务后再关联已有求助。");return target;};
      let target=targetNow();
      if(target?.requestID===parsed.requestID){selectedTaskId=target.id;emit();return target;}
      const remote=await adapter.getRequest(parsed.requestID);target=targetNow();
      if(target){
        const current=await linkedItem(target,remote.doi||target.doi);target=targetNow();
        if(target.requestID===parsed.requestID){selectedTaskId=target.id;emit();return target;}
        await bindRequest(target.id,parsed,{doi:remote.doi||(current?itemDOI(current):target.doi),state:"waiting",lastError:""});selectedTaskId=target.id;
      }else{const r=MODEL.addTask(tasks,{...parsed,doi:remote.doi||"",title:remote.title||"已有求助",state:"waiting",requestedPoints:settings.points});tasks=r.tasks;selectedTaskId=r.task.id;await save();}
      emit();return api.getSelectedTask();
    },
    async saveCredentialsAndLogin({username,password}){const saved=await credentials.getSummary();if(!password&&(!saved.saved||saved.username!==username))throw new Error("首次绑定或更换账号时需要输入密码，也可以直接选择网页登录。");if(saved.username!==username)await api.logout();if(password)await credentials.save({username,password});const s=await credentials.getSummary();account.username=s.username;account.hasSavedPassword=s.saved;emit();return api.openLogin();},
    async forgetCredentials(){await credentials.remove();account.hasSavedPassword=false;account.username="";emit();},
    async refreshAccount(){
      if(loginPromise)return loginPromise;let epoch=accountEpoch;
      loginPromise=(async()=>{try{
        const result=await adapter.getAccount();accountCurrent(epoch);
        if(account.accountID&&(!result.authenticated||account.accountID!==result.accountID)){epoch=++accountEpoch;await pauseAccountTasks();accountCurrent(epoch);messages=[];messagesStatus={state:"idle",message:"账号状态已改变，请登录后刷新消息",lastCheckedAt:null};}
        account.status=result.authenticated?"authenticated":"signed_out";account.accountID=result.authenticated?result.accountID:null;
        account.message=result.message||(result.authenticated?"登录已绑定；会话会在重启后恢复。":"请完成科研通网页登录。");account.displayName=result.username||"";emit();
        if(result.authenticated){await session.flush();accountCurrent(epoch);for(const t of tasks.filter(t=>t.state==="pending_login")){accountCurrent(epoch);await update(t.id,{state:t.requestID?"waiting":"queued",lastError:""});}schedulePump();}
        return result;
      }catch(e){if(epoch===accountEpoch&&!stopped){account.status="error";account.message=safeError(e);emit();}throw e;}finally{if(epoch===accountEpoch)loginPromise=null;}})();return loginPromise;
    },
    async refreshMessages(){if(account.status!=="authenticated")throw new Error("请先绑定科研通账号。");const epoch=accountEpoch;messagesStatus={...messagesStatus,state:"loading",message:"正在读取站内消息"};emit();try{const result=await adapter.listMessages();accountCurrent(epoch);messages=result;messagesStatus={state:"loaded",message:messages.length?"":"暂无站内消息",lastCheckedAt:now()};emit();return messages;}catch(e){if(epoch===accountEpoch&&!stopped){messagesStatus={state:"error",message:safeError(e),lastCheckedAt:now()};emit();}throw e;}},
    async openMessage(id){const m=messages.find(m=>m.id===id);if(!m?.url)throw new Error("此消息没有可打开的链接。");return api.openSite(m.url,null);},
    async openLogin(){return api.openSite(ORIGIN+"/site/login",null,"login");},
    async openRequest(id){const t=taskById(id);if(t.requestURL)return api.openSite(t.requestURL,id,"request");return api.openTask(id);},
    async openTask(id){const t=taskById(id);if(t.attachmentID)return Zotero.getActiveZoteroPane().viewAttachment(t.attachmentID);if(t.requestURL)return api.openSite(t.requestURL,id,"request");const url=t.officialURL||(t.doi?"https://doi.org/"+t.doi:"");if(!url)throw new Error("此条目没有 DOI 或网页地址。");return publisherWindow.open({url,taskId:id,app:api});},
    async openSite(url,taskId,mode="request"){const checked=new URL(url);if(checked.origin!==ORIGIN)throw new Error("科研通账号窗口仅打开科研通网站。");activePageTaskId=taskId;if(siteWindow&&!siteWindow.closed&&siteBrowser){siteWindow.FulltextSiteMode=mode;session.load(siteBrowser,url);siteWindow.focus();return siteWindow;}siteWindow=Zotero.getMainWindow().openDialog("chrome://fulltext-assistant/content/ui/browser.xhtml","fulltext-assistant-site","chrome,centerscreen,resizable,dialog=no,width=1080,height=800",wrapped({app:api,url,mode}));return siteWindow;},
      async attachBrowser(win, holder, url) {
        if (stopped) throw new Error("插件已停止。");
        siteWindow = win;
        const browser = win.document.createXULElement("browser");
        session.configureBrowser(browser);
        browser.setAttribute("flex", "1");
        browser.style.cssText = "flex: 1; min-height: 0; width: 100%;";
        // A dynamic XUL browser also has an initial about:blank document load.
        // Wait for that document before starting the requested navigation, so its
        // pending initialization cannot replace our first loadURI call.
        await new Promise((resolve, reject) => {
          let finished = false;
          let timeout;
          let interval;
          const finish = (error) => {
            if (finished) return;
            finished = true;
            win.clearTimeout(timeout);
            win.clearInterval(interval);
            browser.removeEventListener("XULFrameLoaderCreated", check);
            browser.removeEventListener("load", check, true);
            win.removeEventListener("unload", onUnload);
            if (error) reject(error); else resolve();
          };
          const onUnload = () => finish(new Error("登录窗口已关闭。"));
          const check = () => {
            if (stopped || win.closed || siteWindow !== win) {
              finish(new Error("登录窗口已关闭或被替换。"));
              return;
            }
            try {
              if (browser.frameLoader && browser.browsingContext && browser.webNavigation
                  && browser.contentDocument?.readyState === "complete"
                  && (!browser.isRemoteBrowser || browser.frameLoader.remoteTab)) finish();
            }
            catch (_) { /* The binding may exist before its frame loader is ready. */ }
          };
          browser.addEventListener("XULFrameLoaderCreated", check);
          browser.addEventListener("load", check, true);
          win.addEventListener("unload", onUnload, { once: true });
          timeout = win.setTimeout(() => finish(new Error("内置浏览器初始化超时，请关闭此窗口后重试。")), 10000);
          interval = win.setInterval(check, 50);
          try {
            holder.appendChild(browser);
            browser.getBoundingClientRect();
            check();
          }
          catch (error) { finish(error); }
        });
        // Leave the initial document's load event before navigating its docshell.
        await new Promise(resolve => win.setTimeout(resolve, 0));
        if (stopped || win.closed || siteWindow !== win) throw new Error("登录窗口已关闭或被替换。");
        siteBrowser = browser;
        session.load(browser, url);
        return browser;
      },
    detachBrowser(win){if(siteWindow===win){siteWindow=null;siteBrowser=null;activePageTaskId=null;}},
    async fillSavedLogin(){if(account.hasSavedPassword&&siteBrowser)return session.fillSavedLogin(siteBrowser);return null;},
    async inspectActivePage(){if(!siteBrowser)throw new Error("网页尚未打开。");const result=await session.inspect(siteBrowser);await api.refreshAccount();if(activePageTaskId&&result.requestKey===taskById(activePageTaskId).requestID)await api.checkTask(activePageTaskId);return result;},
    async logout(){accountEpoch++;loginPromise=null;if(siteWindow&&!siteWindow.closed)siteWindow.close();siteWindow=null;siteBrowser=null;account={...account,accountID:null,displayName:"",status:"signed_out",message:"已退出科研通。已保存的账号密码可用于下次登录。"};messages=[];messagesStatus={state:"idle",message:"登录后显示站内消息",lastCheckedAt:null};emit();await pauseAccountTasks();await session.clearSession();},
    async clearSession(){return api.logout();},
    async stop(){stopped=true;clearInterval(timer);for(const id of menuIDs)Zotero.MenuManager.unregisterMenu(id);if(siteWindow&&!siteWindow.closed)siteWindow.close();publisherWindow?.destroy();try{await saveChain;await intentChain;}finally{await session?.destroy();listeners.clear();}}
  };
  return api;
}
scope.FulltextApp={create};
})(globalThis);
