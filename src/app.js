(function(scope){
"use strict";
const MODEL=scope.FulltextTaskModel, ORIGIN="https://www.ablesci.com", PREF="extensions.fulltext-assistant.", PANE="fulltext-assistant-preferences";
function create({Zotero,Services,IOUtils,PathUtils,rootURI,pluginID,version,pickPDF,pickDirectory,pdfIdentity:injectedPDFIdentity,discoverDownloadDirectories,edgeHost:injectedEdgeHost,edgeAcquire:injectedEdgeAcquire}){
  let tasks=[],intents={},messages=[],settings={points:10,pollSeconds:60,autoDownload:true,acceptSiteMinimum:false,checkInReminder:true,downloadDirectories:[],language:"zh-CN"};
  let sourceSettings={},sourceCredentials={openalex:false,core:false,semanticScholar:false},sources,updater,sourceUsage,queueLoaded=false;
  let currentBatch=null,accessHistory={schemaVersion:1,entries:[]},accessSaveChain=Promise.resolve();
  const downloadCandidates=new Map();
  let captureSummary=null,captureSequence=0,captureChain=Promise.resolve();
  let account={status:"signed_out",message:"绑定科研通后可以求助、接收消息和下载应助文件。",username:"",hasSavedPassword:false};
  let messagesStatus={state:"idle",message:"登录后显示站内消息",lastCheckedAt:null};
  let credentials,session,adapter,publisher,publisherSession,publisherWindow,edgeHost,edgeAcquire,siteWindow,siteBrowser,activePageTaskId=null,selectedTaskId=null;
  let stopped=false,timer,downloadTimer,pdfIdentity,downloadWatch,pumping=false,polling=false,saveChain=Promise.resolve(),intentChain=Promise.resolve(),loginPromise=null,accountEpoch=0;
  const listeners=new Set(),menuIDs=[],active=new Set(),cancellations=new Map(),browserRuns=new Map(),browserHandoffs=new Map(),localRuns=new Map(),pendingPDFs=new Map(),completionRuns=new Map(),taskRuns=new Map();
  const browserStates=new Set(["browser_waiting","browser_scanning","browser_downloading"]);
  const dataDir=PathUtils.join(Zotero.DataDirectory.dir,"fulltext-assistant"),queuePath=PathUtils.join(dataDir,"tasks.json"),intentPath=PathUtils.join(dataDir,"submission-intents.json");
  const now=()=>new Date().toISOString();
  const translate=(text,params)=>scope.FulltextI18n?.translate(text,settings.language,params)||String(text||"");
  const accessPath=PathUtils.join(dataDir,"access-history.json");
  const checkInPath=PathUtils.join(dataDir,"checkin-status.json");
  let checkInRecords=[],checkInRun=null,checkInTimer,checkInWatchUntil=0,checkInSaveChain=Promise.resolve();
  const localDay=()=>{const date=new Date();return [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-");};
  const emptyCheckIn=()=>({state:account.status==="authenticated"?"idle":"signed_out",day:localDay(),signed:null,balance:null,reward:null,rewardVerified:false,checkedAt:null,attemptedAt:null,message:""});
  function checkInSnapshot(){
    const value=account.status==="authenticated"?checkInRecords.find(record=>record.accountID===account.accountID):null;
    const result=value?{...value}:emptyCheckIn();delete result.accountID;
    if(result.day!==localDay()){result.day=localDay();result.state="idle";result.signed=null;result.reward=null;result.rewardVerified=false;result.message="";}
    if(checkInRun?.epoch===accountEpoch&&account.status==="authenticated")result.state="checking";
    return result;
  }
  async function saveCheckIn(record){
    checkInRecords=[record,...checkInRecords.filter(value=>value.accountID!==record.accountID)].slice(0,20);
    const data=JSON.stringify({schemaVersion:1,accounts:checkInRecords});
    const operation=checkInSaveChain.catch(()=>{}).then(async()=>{await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});await IOUtils.writeUTF8(checkInPath,data,{tmpPath:checkInPath+".tmp"});});
    checkInSaveChain=operation;await operation;
  }
  function normalizedCheckIn(value){
    if(!value||typeof value.accountID!=="string"||!value.accountID||!/^\d{4}-\d{2}-\d{2}$/.test(value.day||""))return null;
    const number=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?n:null;
    const timestamp=n=>typeof n==="string"&&Number.isFinite(Date.parse(n))?n:null;
    return {accountID:value.accountID,day:value.day,state:value.state==="error"?"error":"loaded",signed:typeof value.signed==="boolean"?value.signed:null,balance:number(value.balance),reward:number(value.reward),rewardVerified:value.rewardVerified===true&&number(value.reward)!==null&&value.signed===true,checkedAt:timestamp(value.checkedAt),attemptedAt:timestamp(value.attemptedAt),message:typeof value.message==="string"?value.message.slice(0,600):""};
  }
  async function checkInTick(){
    if(stopped||!settings.checkInReminder||account.status!=="authenticated")return;
    const current=checkInRecords.find(record=>record.accountID===account.accountID),watching=Date.now()<checkInWatchUntil;
    if(!watching&&new Date().getHours()<6)return;
    if(!watching&&current?.day===localDay()&&current.state==="loaded")return;
    await api.refreshCheckIn();
  }
  function accessHint(task){const module=scope.FulltextAccessHistory;if(!module)return{scope:"none",confidence:"none",institutionalConfirmed:false};const primary=module.lookup(accessHistory,{url:task.publisherURL||task.officialURL,doi:task.doi}),original=module.lookup(accessHistory,{url:task.officialURL,doi:task.doi});return primary.scope==="article"?primary:original.scope==="article"?original:primary.scope!=="none"?primary:original;}
  async function rememberAccess(task,kind,source,confirmedByUser=false){
    if(!scope.FulltextAccessHistory||!task.doi||!(task.publisherURL||task.officialURL))return;
    const operation=accessSaveChain.catch(()=>{}).then(async()=>{
      const next=scope.FulltextAccessHistory.record(accessHistory,{url:task.publisherURL||task.officialURL,doi:task.doi,kind,source,confirmedByUser,at:now()});
      await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});
      await IOUtils.writeUTF8(accessPath,JSON.stringify(next),{tmpPath:accessPath+".tmp"});accessHistory=next;emit();
    });accessSaveChain=operation;await operation;
  }
  const discoverFolders=()=>discoverDownloadDirectories?discoverDownloadDirectories():scope.FulltextDownloadFolders.discover({Services,IOUtils,PathUtils});
  const filename=path=>PathUtils.filename?PathUtils.filename(path):path.split(/[\\/]/).pop();
  function validatePaper(expected,current){if(!current||itemDOI(current)!==expected.doi||(!expected.doi&&current.getField("title")!==expected.title))throw new Error("核对期间原文献的 DOI 或标题已改变，请重新选择 PDF。");}
  async function digest(bytes){
    const subtle=Zotero.getMainWindow()?.crypto?.subtle||scope.crypto?.subtle;
    if(subtle)return Array.from(new Uint8Array(await subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");
    const hash=Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);hash.init(hash.SHA256);hash.update(bytes,bytes.length);return Array.from(hash.finish(false),c=>c.charCodeAt(0).toString(16).padStart(2,"0")).join("");
  }
  const reviewPath=id=>PathUtils.join(dataDir,"review-"+id+".pdf");
  async function importSelectedFile(id,{file,bytes,expected,automatic=false,confirmed=false,assistReview=null,sourceReview=null,forceReview=false,beforeStart}={}){
    beforeStart?.();
    let task=taskById(id);if(!task.itemID)throw new Error("请先关联文献，再选择对应的 PDF。");
    if(task.submissionReview)throw new Error("请先核对已提交的求助，再切换获取方式。");
    if(active.has(id))throw new Error("此任务仍在处理，请先暂停后再选择 PDF。");
    const wasWatching=downloadWatch?.isWatching(id);downloadWatch?.cancel(id);
    const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);active.add(id);
    const check=()=>{if(stopped||cancellations.get(id)!==ticket){const e=new Error("导入已取消");e.name="AbortError";throw e;}};
    try{
      const item=await linkedItem(task,task.doi),library=Zotero.Libraries.get(task.libraryID);check();
      if(!library?.editable||!library.filesEditable)throw new Error("此文库不能保存附件。");
      const paper={doi:itemDOI(item),title:item.getField("title")};
      if(expected)validatePaper(expected,item);
      const existing=await scope.FulltextPublisher.findExistingPDF(item,{Zotero,IOUtils});check();
      if(existing){
        check();validatePaper(paper,await linkedItem(task,task.doi));check();pendingPDFs.delete(id);
        await update(id,{state:"imported",attachmentID:existing,source:"existing",attempts:0,lastError:"",nextCheckAt:null});
        return{cancelled:false,attachmentID:existing};
      }
      if(!file){
        if(pickPDF)file=await pickPDF(task);
        else{
          const {FilePicker}=ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
          const picker=new FilePicker();picker.init(Zotero.getMainWindow(),"选择此文献的 PDF："+task.title,picker.modeOpen);picker.appendFilter("PDF 文件","*.pdf");
          if(await picker.show()===picker.returnOK)file=picker.file;
        }
        check();
        if(!file){if(wasWatching)await update(id,{state:"paused",lastError:"已取消文件选择。需要继续自动入库时，请再次点击浏览器下载。",nextCheckAt:null});return{cancelled:true};}
      }
      check();
      if(!bytes){
        const info=await IOUtils.stat(file,{followSymlinks:false});check();
        if(info.type!=="regular"||info.size<1024||info.size>100*1024*1024)throw new Error("请选择 1 KiB 至 100 MiB 的 PDF 文件。");
        bytes=await IOUtils.read(file);check();
      }
      if(bytes.length>100*1024*1024||!scope.FulltextPublisher.validPDF(bytes))throw new Error("所选文件不是完整有效的 PDF，未导入。");
      if(confirmed){
        const pending=pendingPDFs.get(id);
        if(!pending||pending.path!==file||await digest(bytes)!==pending.digest)throw new Error("待确认的 PDF 已改变，请重新选择并核对。");
        validatePaper(pending.paper,item);check();
      }
      if(sourceReview){
        if(!confirmed||JSON.stringify(task.sourceReview)!==JSON.stringify(sourceReview)||await digest(bytes)!==sourceReview.sha256)throw new Error("待确认的全文文件已改变，请重新获取并核对。");
        validatePaper(sourceReview,item);check();
      }
      if(assistReview){
        if(!confirmed||JSON.stringify(task.assistReview)!==JSON.stringify(assistReview)||await digest(bytes)!==assistReview.sha256)throw new Error("待确认的应助文件或关联已改变，请重新下载并核对。");
        validatePaper(assistReview,item);check();
      }
      const identity=await pdfIdentity.inspect(file,paper,{bytes});check();
      validatePaper(paper,await linkedItem(task,task.doi));check();
      if(identity.status==="mismatch")throw new Error("PDF 与此文献不匹配，已拒绝导入。"+(identity.message||"请核对 DOI 和标题。"));
      if(identity.status!=="match"||forceReview&&!confirmed){
        const pending=pendingPDFs.get(id);
        if(automatic)throw new Error("新 PDF 的论文身份无法确认，未自动导入，请手动选择并核对。");
        if(confirmed){
          if(!pending||pending.path!==file||await digest(bytes)!==pending.digest)throw new Error("待确认的 PDF 已改变，请重新选择并核对。");
          validatePaper(pending.paper,item);check();
        }else{
          const fingerprint=await digest(bytes);check();
          pendingPDFs.set(id,{path:file,digest:fingerprint,paper,filename:filename(file),summary:identity.summary||identity.message||"无法从文件确认 DOI 或标题。"});
          await update(id,{state:"manual_review",acquisitionMode:"manual",nextCheckAt:null,lastError:(identity.status==="match"?"PDF 身份已匹配；请预览后明确确认入库。":"无法自动确认此 PDF 是否为目标论文。"+(identity.message||"")+" 请先预览，核对后再明确确认。")});
          return{needsReview:true,identity:{status:"unknown",message:identity.message||""}};
        }
      }
      check();await update(id,{state:"downloading",lastError:"论文身份已核对，正在保存 PDF…"});check();
      let reused=false;
      const attachment=await persistPDF({...task,doi:paper.doi,title:paper.title},bytes,ticket,current=>validatePaper(paper,current),()=>{reused=true;});
      pendingPDFs.delete(id);
      const receipt=assistReview&&!reused?makeAssistReceipt(assistReview,attachment,paper,"manual"):null;
      await update(id,{state:"imported",source:receipt?"ablesci":sourceReview&&!reused?sourceReview.source:automatic?"browser_download":"local_file",fulltextVersion:sourceReview&&!reused?sourceReview.fulltextVersion:"unknown",sourceReview:null,attachmentID:attachment.id,attempts:0,nextCheckAt:null,lastError:"",assistReview:null,assistReceipt:receipt,acquisitionMode:""});
      downloadCandidates.delete(id);
      if(sourceReview)await IOUtils.remove(reviewPath(id),{ignoreAbsent:true}).catch(()=>{});
      if(!assistReview&&!sourceReview&&!reused&&!task.requestID)await rememberAccess(taskById(id),"browser_success",automatic?"browser_download":"browser_import").catch(error=>Zotero.logError(new Error(safeError(error))));
      if(assistReview){await IOUtils.remove(reviewPath(id),{ignoreAbsent:true}).catch(()=>{});if(receipt)await finishAssist(id).catch(error=>Zotero.logError(new Error(safeError(error))));}
      return{cancelled:false,attachmentID:attachment.id,...(confirmed&&!reused&&!assistReview?{localConfirmation:{attachmentID:attachment.id,sha256:await digest(bytes),...paper}}:{})};
    }catch(error){
      if(error.name!=="AbortError"&&!stopped&&cancellations.get(id)===ticket){pendingPDFs.delete(id);await update(id,{state:"error",lastError:safeError(error),nextCheckAt:null});}
      throw error;
    }finally{active.delete(id);emit();}
  }
  function startLocalImport(id,options){
    if(localRuns.has(id))return localRuns.get(id);
    const operation=Promise.resolve().then(()=>importSelectedFile(id,options)).then(async result=>{
      const task=taskById(id);
      // Import has released its lock. Correlate a browser/manual fallback with
      // the exact website file before attributing it or settling that request.
      if(!stopped&&!result.cancelled&&!result.needsReview&&task.state==="imported"&&task.requestID&&!task.assistReceipt)
        await api.verifyAssistCompletion(id,result.localConfirmation||null);
      return result;
    }).finally(()=>localRuns.delete(id));localRuns.set(id,operation);return operation;
  }
  async function setDownloadDirectories(values){
    const directories=scope.FulltextDownloadFolders.normalize(values);
    if(JSON.stringify(directories)===JSON.stringify(settings.downloadDirectories))return{changed:false,paused:0};
    const waiting=tasks.filter(task=>task.state==="manual_waiting");
    for(const task of waiting){await api.pauseTask(task.id);await update(task.id,{lastError:"下载文件夹已更改，检查已暂停；请点击浏览器下载重新开始。"});}
    settings.downloadDirectories=directories;
    Services.prefs.setStringPref(PREF+"downloadDirectories",JSON.stringify(directories));emit();return{changed:true,paused:waiting.length};
  }
  const parseHTML=html=>new (Zotero.getMainWindow()?.DOMParser||Services.appShell.hiddenDOMWindow.DOMParser)().parseFromString(html,"text/html");
  function emit(){if(!stopped)for(const f of listeners){try{f(api.getSnapshot());}catch(e){Zotero.logError(e);}}}
  function safeError(e){return String(e?.message||e||"操作未完成").replace(/https?:\/\/[^\s]*[?][^\s]*/g,"[请求地址]").slice(0,600);}
  function save(){if(!queueLoaded)return Promise.resolve();const value=MODEL.serializeQueue({schemaVersion:MODEL.SCHEMA_VERSION,tasks,currentBatch});saveChain=saveChain.catch(()=>{}).then(async()=>{await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});await IOUtils.writeUTF8(queuePath,value,{tmpPath:queuePath+".tmp"});});return saveChain;}
  function taskById(id){const task=tasks.find(t=>t.id===id);if(!task)throw new Error("任务不存在。");return task;}
  async function update(id,patch,{queueAtEnd=false}={}){const i=tasks.findIndex(t=>t.id===id);if(i<0)return null;const next=MODEL.updateTask(tasks[i],patch);if(queueAtEnd){tasks.splice(i,1);tasks.push(next);}else tasks[i]=next;await save();emit();return tasks.find(task=>task.id===id)||null;}
  // Queue order is independent of creation date: an explicitly resumed task
  // joins after work already waiting, keeping its identity and remote history.
  const enqueue=(id,patch)=>update(id,{...patch,state:"queued"},{queueAtEnd:true});
  function abortIf(id,ticket){if(stopped||cancellations.get(id)!==ticket||taskById(id).state==="paused"){const e=new Error("任务已暂停");e.name="AbortError";throw e;}}
  function accountCurrent(epoch){if(epoch!==accountEpoch||stopped){const e=new Error("账号会话已改变，请重新操作。");e.name="AbortError";throw e;}}
  async function pauseAccountTasks(){
    const affected=tasks.filter(t=>!["browser","manual"].includes(t.acquisitionMode)&&(t.allowAssist||t.requestID)&&!["imported","closed"].includes(t.state));
    for(const t of affected)cancellations.set(t.id,(cancellations.get(t.id)||0)+1);
    for(const t of affected)await update(t.id,{state:["submitting","submission_unknown"].includes(t.state)?"submission_unknown":"paused",nextCheckAt:null,lastError:"账号已退出或切换；确认账号后可重试此任务。"});
  }
  const intentStore={
    async get(key){await intentChain;return intents[key]||null;},
    async claim(key,record){let result=false;const op=intentChain.catch(()=>{}).then(async()=>{if(Object.hasOwn(intents,key)&&!["cancelled_before_send","rejected"].includes(intents[key].state))return;const next={...intents,[key]:record};await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});await IOUtils.writeUTF8(intentPath,JSON.stringify(next),{tmpPath:intentPath+".tmp"});intents=next;result=true;});intentChain=op;await op;return result;},
    async set(key,record){const op=intentChain.catch(()=>{}).then(async()=>{const next={...intents,[key]:record};await IOUtils.writeUTF8(intentPath,JSON.stringify(next),{tmpPath:intentPath+".tmp"});intents=next;});intentChain=op;await op;}
  };
  function hasProtectedIntent(task){return !!task.submissionReview||Object.values(intents).some(intent=>intent.doi===task.doi&&!["cancelled_before_send","rejected"].includes(intent.state));}
  const copyCaptureSummary=value=>value?{...value,queuedTaskIDs:[...value.queuedTaskIDs]}:null;
  function taskForItem(item){
    const matches=tasks.filter(task=>task.libraryID===item.libraryID&&(task.itemKey&&item.key?task.itemKey===item.key:task.itemID===item.id));
    return matches.find(task=>active.has(task.id)||localRuns.has(task.id)||browserRuns.has(task.id)||browserHandoffs.has(task.id))||
      matches.find(task=>task.requestID||hasProtectedIntent(task))||matches[0]||null;
  }
  async function captureItemParent(value){
    if(!value||value.deleted)return null;
    const item=value.isRegularItem?.()?value:value.isAttachment?.()&&value.parentID?await Zotero.Items.getAsync(value.parentID):null;
    return item?.id&&!item.deleted&&item.isRegularItem?.()&&(!value.libraryID||value.libraryID===item.libraryID)?item:null;
  }
  function downloadError(error) {
    const status = Number(error?.status || error?.xmlhttp?.status || 0);
    const timedOut = /timeout|timed out|超时/i.test(String(error?.name || "") + " " + String(error?.message || ""));
    const transient = timedOut || [408, 429].includes(status) || status >= 500
      || (!status && /network|connection|NS_ERROR_(?:NET|CONNECTION|OFFLINE)|网络|连接/i.test(String(error?.name || "") + " " + String(error?.message || "")));
    if (!transient) return error;
    const result = new Error(timedOut ? "PDF 文件下载超时，文件尚未保存；将重新获取下载地址后重试。" : "PDF 文件传输暂时失败，将重新获取下载地址后重试。");
    result.code = timedOut ? "DOWNLOAD_TIMEOUT" : "DOWNLOAD_NETWORK";
    result.retryable = true; return result;
  }
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
    downloadWatch?.cancel(id);pendingPDFs.delete(id);
    if(duplicate){downloadWatch?.cancel(duplicate.id);pendingPDFs.delete(duplicate.id);tasks=tasks.filter(t=>t.id!==duplicate.id);}
    return update(id,{...parsed,...patch,...verifiedPoints(reference),submissionReview:null,acquisitionMode:""});
  }
  function verifiedPoints(reference){
    if(reference?.pointsVerified!==true)return{};
    try{return{requestedPoints:MODEL.validatePoints(reference.requestedPoints),pointsVerified:true};}catch(_){return{};}
  }
  async function transport({url,method="GET",body,headers,responseType="text"}){const xhr=await session.request(method,url,{body,headers,responseType,timeout:25000,successCodes:false});return{url:xhr.responseURL||url,status:xhr.status,text:responseType==="text"?xhr.responseText:undefined,data:responseType!=="text"?xhr.response:undefined,headers:{"content-type":xhr.getResponseHeader("Content-Type")||""}};}
  function registerMenus(){
    const canCapture=items=>(items||[]).some(item=>item.isRegularItem?.()||(item.isAttachment?.()&&item.parentID));
    const action=(label,command,{needsItems=true}={})=>({
      menuType:"menuitem",
      onShowing(event,context){context.menuElem.setAttribute("label",translate(typeof label==="function"?label():label));context.setEnabled(!needsItems||canCapture(context.items));},
      onCommand(event,context){Promise.resolve().then(()=>command(context.items||[])).catch(error=>Services.prompt.alert(null,translate("全文助手"),translate(safeError(error))));}
    });
    const id=Zotero.MenuManager.registerMenu({menuID:"fulltext-assistant",pluginID,target:"main/library/item",menus:[{
      menuType:"submenu",icon:rootURI+"assets/icon-16.png",
      onShowing(event,context){context.menuElem.setAttribute("label",translate("全文助手"));context.setEnabled(true);},
      menus:[
        action("批量获取全文",items=>api.captureItems(items)),
        action(()=>"网页优先，科研通兜底（"+settings.points+(settings.acceptSiteMinimum?" 积分起）":" 积分）"),items=>api.captureItems(items,{allowAssist:true})),
        {menuType:"separator"},
        action("任务与设置",()=>api.openPreferences(),{needsItems:false})
      ]
    }]});
    if(id)menuIDs.push(id);
  }
  function schedulePump(){Promise.resolve().then(()=>pump()).catch(e=>Zotero.logError(new Error(safeError(e))));}
  async function pump(){if(pumping||stopped)return;pumping=true;try{while(!stopped){const batch=tasks.filter(t=>t.state==="queued"&&!active.has(t.id)).slice(0,2);if(!batch.length)break;await Promise.all(batch.map(t=>runTask(t.id)));}}finally{pumping=false;}}
  function makeAssistReceipt(download,attachment,paper,verifiedBy){
    if(!/^[A-Za-z0-9]{1,128}$/.test(download.accountID||"")||!/^[A-Za-z0-9]{1,128}$/.test(download.fileID||"")||!/^[A-Za-z0-9]{1,128}$/.test(download.requestID||"")||!/^[a-f0-9]{64}$/.test(download.sha256||""))return null;
    return {requestID:download.requestID,fileID:download.fileID,accountID:download.accountID,attachmentID:attachment.id,sha256:download.sha256,doi:paper.doi,title:paper.title,verifiedBy,verifiedAt:now(),adoption:"pending",messages:"pending",needsReconcile:false,attempts:0,nextCheckAt:null,lastError:"",acceptedAt:null,readAt:null};
  }
  async function importResponse(task,download,ticket,{verifyExisting=false,localConfirmation=null}={}){
    if(!task.itemID)throw new Error("此求助尚未关联 Zotero 条目，请从文库条目右键发起或关联。");
    const item=await linkedItem(task,task.doi);
    const library=Zotero.Libraries.get(item.libraryID);if(!library?.editable||!library?.filesEditable)throw new Error("此文库不允许保存附件。");
    const existing=await scope.FulltextPublisher.findExistingPDF(item,{Zotero,IOUtils});if(existing&&!verifyExisting)return{attachment:{id:existing},existing:true};
    const url=new URL(download.url);if(url.protocol!=="https:"||url.username||url.password)throw new Error("下载地址无效。");
    const timeout=Math.max(180000,Math.min(600000,Number(download.timeoutMs)||Math.ceil((download.expectedSize||0)/65536)*1000));
    const options={responseType:"arraybuffer",timeout,headers:download.headers||{},body:download.body};
    // Domain-scoped Gecko cookies; no account Cookie header is sent to a CDN.
    let xhr;
    try { xhr=url.origin===ORIGIN?await session.request(download.method||"GET",url.href,options):await Zotero.HTTP.request("GET",url.href,{...options,debug:false,logBodyLength:0,errorDelayMax:0,noRetryOnThrottle:true}); }
    catch(error) { abortIf(task.id,ticket); throw downloadError(error); }
    abortIf(task.id,ticket);const bytes=new Uint8Array(xhr.response);
    const finalURL=new URL(xhr.responseURL||url.href);
    const verifiedCDN=download.route==="highspeed"&&download.transport==="cdn"&&download.allowedRedirectDomain==="ablesci.com"&&!finalURL.port&&(finalURL.hostname==="ablesci.com"||finalURL.hostname.endsWith(".ablesci.com"));
    if(finalURL.protocol!=="https:"||finalURL.username||finalURL.password||(!(download.allowedOrigins||[url.origin]).includes(finalURL.origin)&&!verifiedCDN))throw new Error("文件响应跳转到了未核实的下载服务器，已停止导入。");
    if(Number.isSafeInteger(download.expectedSize)&&download.expectedSize>0&&bytes.length!==download.expectedSize)throw new Error("下载文件大小与网站记录不一致，请重试或在网页核对文件。");
    if(!scope.FulltextPublisher.validPDF(bytes))throw new Error("下载返回的不是完整有效的 PDF，可能需要重新登录或在网站完成验证。");
    const paper={doi:itemDOI(item),title:item.getField("title")};
    const identity=await pdfIdentity.inspect(null,paper,{bytes});abortIf(task.id,ticket);
    validatePaper(paper,await linkedItem(task,task.doi));abortIf(task.id,ticket);
    if(identity.status==="mismatch")throw new Error("科研通应助文件与原论文不匹配，未导入、未采纳。"+(identity.message||"请核对 DOI 和标题。"));
    const sha256=await digest(bytes);abortIf(task.id,ticket);
    if(verifyExisting){
      const manuallyConfirmed=localConfirmation&&localConfirmation.attachmentID===task.attachmentID&&localConfirmation.sha256===sha256&&localConfirmation.doi===paper.doi&&localConfirmation.title===paper.title;
      if(identity.status!=="match"&&!manuallyConfirmed)throw new Error("无法自动确认旧应助文件的论文身份，请在求助网页核对后采纳。");
      const saved=await Zotero.Items.getAsync(task.attachmentID);abortIf(task.id,ticket);
      if(!saved||saved.deleted||saved.parentID!==task.itemID||saved.libraryID!==task.libraryID||saved.attachmentContentType!=="application/pdf")throw new Error("原应助附件的关联已改变，未补采纳。");
      const path=await saved.getFilePathAsync(),info=path&&await IOUtils.stat(path);abortIf(task.id,ticket);
      if(!info||info.type!=="regular"||info.size!==bytes.length||await digest(await IOUtils.read(path))!==sha256)throw new Error("应助文件与已保存 PDF 的内容不同，未自动补采纳。");abortIf(task.id,ticket);
      return{attachment:saved,receipt:makeAssistReceipt({...download,sha256},saved,paper,manuallyConfirmed?"manual":identity.matchedBy==="title"?"title":"doi")};
    }
    if(identity.status!=="match"){
      if(!download.accountID||!download.fileID||download.requestID!==task.requestID)throw new Error("应助 PDF 的论文身份无法确认，请在求助网页核对文件。");
      const file=reviewPath(task.id),review={requestID:download.requestID,fileID:download.fileID,accountID:download.accountID,sha256,doi:paper.doi,title:paper.title,createdAt:now()};
      await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});abortIf(task.id,ticket);await IOUtils.write(file,bytes);abortIf(task.id,ticket);
      pendingPDFs.set(task.id,{path:file,digest:sha256,paper,filename:download.filename||"应助全文.pdf",summary:identity.summary||identity.message||"无法自动确认 DOI 或标题。",assistReview:review});
      await update(task.id,{state:"manual_review",assistReview:review,acquisitionMode:"",nextCheckAt:null,lastError:"应助 PDF 已暂存，尚未入库或采纳。请预览并核对论文；确认后将保存全文、采纳该文件并标记对应通知已读。"});
      return {needsReview:true};
    }
    let reused=false;
    const attachment=await persistPDF({...task,...paper},bytes,ticket,current=>validatePaper(paper,current),()=>{reused=true;});
    return {attachment,existing:reused,receipt:reused?null:makeAssistReceipt({...download,sha256},attachment,paper,identity.matchedBy==="title"?"title":"doi")};
  }
  async function persistPDF(task,bytes,ticket,validateIdentity=()=>{},onExisting=()=>{}){
    abortIf(task.id,ticket);
    const current=await linkedItem(task,task.doi),currentLibrary=Zotero.Libraries.get(task.libraryID);
    validateIdentity(current);
    if(!current||current.deleted||current.key!==task.itemKey||current.libraryID!==task.libraryID||!currentLibrary?.editable||!currentLibrary?.filesEditable)throw new Error("下载期间原条目或文库权限发生变化，已停止导入。");
    const tempDir=(await Zotero.Attachments.createTemporaryStorageDirectory()).path,file=PathUtils.join(tempDir,"fulltext.pdf");
    try{await IOUtils.write(file,bytes);abortIf(task.id,ticket);const duplicate=await scope.FulltextPublisher.findExistingPDF(current,{Zotero,IOUtils});if(duplicate){onExisting();return{id:duplicate};}const finalItem=await linkedItem(task,task.doi),finalLibrary=Zotero.Libraries.get(task.libraryID);if(!finalLibrary?.editable||!finalLibrary?.filesEditable)throw new Error("导入前文库权限发生变化，已停止导入。");abortIf(task.id,ticket);validateIdentity(finalItem);return await Zotero.Attachments.importFromFile({file,parentItemID:finalItem.id,title:"全文",contentType:"application/pdf",fileBaseName:Zotero.Attachments.getFileBaseNameFromItem(finalItem)});}
    finally{await IOUtils.remove(tempDir,{recursive:true,ignoreAbsent:true}).catch(()=>{});}
  }
  function finishAssist(id){
    if(completionRuns.has(id))return completionRuns.get(id);
    const operation=Promise.resolve().then(()=>completeAssist(id)).finally(()=>completionRuns.delete(id));completionRuns.set(id,operation);return operation;
  }
  async function completeAssist(id){
    let task=taskById(id),receipt=task.assistReceipt;
    if(task.state!=="imported"||!receipt)return{completed:false,message:"此历史记录没有具体应助文件的核验凭据，不会自动采纳。"};
    if(receipt.adoption==="accepted"&&receipt.messages==="done")return{completed:true};
    const epoch=accountEpoch,signature=JSON.stringify([receipt.requestID,receipt.fileID,receipt.accountID,receipt.attachmentID,receipt.sha256,receipt.doi,receipt.title]);
    const check=()=>{accountCurrent(epoch);const current=taskById(id);if(current.state!=="imported"||!current.assistReceipt||JSON.stringify([current.assistReceipt.requestID,current.assistReceipt.fileID,current.assistReceipt.accountID,current.assistReceipt.attachmentID,current.assistReceipt.sha256,current.assistReceipt.doi,current.assistReceipt.title])!==signature){const e=new Error("应助文件的关联已改变，已停止采纳和消息操作。");e.name="AbortError";throw e;}};
    const patchReceipt=async patch=>{check();await update(id,{assistReceipt:{...taskById(id).assistReceipt,...patch}});check();receipt=taskById(id).assistReceipt;};
    const verifySaved=async()=>{
      task=taskById(id);const item=await linkedItem(task,receipt.doi);check();validatePaper(receipt,item);
      const attachment=await Zotero.Items.getAsync(receipt.attachmentID);check();
      if(!attachment||attachment.deleted||attachment.parentID!==task.itemID||attachment.libraryID!==task.libraryID||attachment.attachmentContentType!=="application/pdf")throw new Error("已保存附件的关联已改变，请在求助网页人工核对采纳。");
      const path=await attachment.getFilePathAsync();check();
      const stat=path&&await IOUtils.stat(path);check();
      if(!stat||stat.type!=="regular"||stat.size>100*1024*1024)throw new Error("已保存的 PDF 不存在或已改变，未执行采纳。");
      const bytes=await IOUtils.read(path);check();
      if(await digest(bytes)!==receipt.sha256)throw new Error("已保存的 PDF 内容已改变，未自动采纳；请在求助网页核对。");check();
    };
    try{
      const currentAccount=await api.refreshAccount();check();
      if(!currentAccount.authenticated||currentAccount.accountID!==receipt.accountID)throw new Error("请登录下载此文件时的科研通账号，再继续采纳和已读。PDF 已保存在文库中。");
      await verifySaved();
      const options={requestID:receipt.requestID,fileID:receipt.fileID,accountID:receipt.accountID,doi:receipt.doi,isCancelled:()=>stopped||epoch!==accountEpoch};
      if(receipt.adoption!=="accepted"){
        const accepted=await adapter.acceptFile({...options,reconcileOnly:receipt.needsReconcile===true,beforeSend:async()=>{await verifySaved();await patchReceipt({needsReconcile:true,lastError:"正在核实科研通采纳结果…"});}});check();
        if(!accepted?.accepted)throw new Error("科研通尚未确认采纳结果，请稍后核实。");
        await update(id,verifiedPoints(accepted));check();
        await patchReceipt({adoption:"accepted",needsReconcile:false,acceptedAt:now(),lastError:"",attempts:0,nextCheckAt:null});
      }
      const read=await adapter.markRequestMessagesRead(options);check();
      if(!read?.completed)throw new Error("文件已采纳，对应消息的已读状态尚未确认。");
      await patchReceipt({messages:"done",readAt:now(),lastError:"",attempts:0,nextCheckAt:null});
      await api.refreshMessages().catch(()=>{});const completed=taskById(id).assistReceipt?.messages==="done";return{completed,message:completed?"":"已采纳；新到达的对应上传通知将继续处理。"};
    }catch(error){
      if(error.name==="AbortError"||stopped||epoch!==accountEpoch)return{completed:false,cancelled:true};
      check();receipt=taskById(id).assistReceipt;const attempts=receipt.attempts+1;
      await patchReceipt({attempts,lastError:safeError(error),needsReconcile:receipt.adoption==="accepted"?false:error.definitivelyRejected?false:receipt.needsReconcile||error.reconcileRequired===true,nextCheckAt:new Date(Date.now()+Math.min(3600,settings.pollSeconds*2**Math.min(attempts-1,6))*1000).toISOString()});
      return{completed:false,message:safeError(error)};
    }
  }
  async function checkRemote(id,ticket,{forceDownload=false}={}){
    const task=taskById(id),result=await adapter.getRequest(task.requestID);abortIf(id,ticket);
    if(task.doi&&result.doi&&MODEL.normalizeDOI(task.doi)!==MODEL.normalizeDOI(result.doi))throw new Error("求助页面 DOI 与原条目不一致，已停止下载，请核对关联。");
    await linkedItem(task,result.doi||task.doi);abortIf(id,ticket);
    const files=(result.files||[]).filter(f=>!["reject","withdraw"].includes(f.status));const available=result.state==="available"&&files.length>0;
    await update(id,{...verifiedPoints(result),state:available?"available":result.state==="closed"?"closed":"waiting",doi:task.doi||result.doi||"",title:!task.itemID&&result.title?result.title:task.title,attempts:available?task.attempts:0,lastCheckedAt:now(),nextCheckAt:result.state==="closed"?null:new Date(Date.now()+settings.pollSeconds*1000).toISOString(),lastError:result.state==="closed"?"历史求助已关闭或文件已过期，请打开求助网页处理；插件不会自动重复发布。":""});
    if(!available||(!settings.autoDownload&&!forceDownload)||!task.itemID)return;
    if(account.status!=="authenticated"){await update(id,{state:"pending_login",lastError:"已有人应助；登录科研通后可下载。"});return;}
    await update(id,{state:"downloading"});abortIf(id,ticket);let lastError;
    for(const file of files){
      let download;
      try{
        download=await adapter.getDownload(result,file,{route:"auto-free",isCancelled:()=>stopped||cancellations.get(id)!==ticket});abortIf(id,ticket);
        await update(id,{downloadRoute:download.route||"normal",lastError:download.route==="highspeed"?"正在通过已核实的免积分高速线路下载 PDF…":"正在通过普通免费线路下载 PDF…"});abortIf(id,ticket);
        let imported;
        try { imported=await importResponse({...task,doi:result.doi||task.doi},download,ticket); }
        catch(error) {
          const highspeedFallback=download.route==="highspeed"&&download.canFallback;
          const normalFallback=download.route==="normal"&&download.normalServerCount>1;
          if(error.name==="AbortError"||!error.retryable||(!highspeedFallback&&!normalFallback))throw error;
          await update(id,{lastError:"当前下载节点暂时不可用，正在重新获取备用线路…"});abortIf(id,ticket);
          download=await adapter.getDownload(result,file,{route:highspeedFallback?"auto-free":"normal",fallback:!!highspeedFallback,normalServerIndex:normalFallback?((download.normalServerIndex||0)+1)%download.normalServerCount:0,isCancelled:()=>stopped||cancellations.get(id)!==ticket});abortIf(id,ticket);
          await update(id,{downloadRoute:download.route||"normal"});abortIf(id,ticket);
          imported=await importResponse({...task,doi:result.doi||task.doi},download,ticket);
        }
        if(imported.needsReview)return;
        await update(id,{state:"imported",source:imported.existing?"existing":"ablesci",downloadRoute:download.route||"normal",attachmentID:imported.attachment.id,attempts:0,nextCheckAt:null,lastError:"",assistReview:null,assistReceipt:imported.receipt||null});
        if(imported.receipt)await finishAssist(id).catch(error=>Zotero.logError(new Error(safeError(error))));return;
      }catch(e){if(e.name==="AbortError")throw e;lastError=e;}
    }
    throw lastError||new Error("暂未找到可下载的 PDF。");
  }
  function runTask(id,options={}){
    if(taskRuns.has(id))return taskRuns.get(id);
    const operation=runTaskImpl(id,options).finally(()=>taskRuns.delete(id));taskRuns.set(id,operation);return operation;
  }
  async function runTaskImpl(id,options={}){
    if(active.has(id)||stopped)return;active.add(id);const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);
    try{
      let task=taskById(id);if(task.requestID){await checkRemote(id,ticket,options);return;}
      const item=await Zotero.Items.getAsync(task.itemID);if(!item||item.deleted||item.key!==task.itemKey||item.libraryID!==task.libraryID)throw new Error("原文献条目不存在。");
      const library=Zotero.Libraries.get(item.libraryID);if(!library.editable||!library.filesEditable)throw new Error("此文库不允许保存附件。");
      let currentDOI="";try{currentDOI=MODEL.normalizeDOI(item.getField("DOI")||item.getExtraField?.("DOI"));}catch(_){}
      await update(id,{doi:currentDOI,title:item.getField("title"),officialURL:item.getField("url")});abortIf(id,ticket);
      await update(id,{state:"resolving",lastError:"正在优先查找开放全文与配置来源…"});abortIf(id,ticket);
      const acquired=await publisher.acquire(item,{isCancelled:()=>stopped||cancellations.get(id)!==ticket,onProgress(info){if(!stopped&&cancellations.get(id)===ticket)update(id,{lastError:info.message}).catch(()=>{});}});
      // A committed attachment is real even if pause/shutdown raced its final write.
      if(acquired.attachmentID){await update(id,{state:"imported",attachmentID:acquired.attachmentID,source:acquired.source,fulltextVersion:acquired.fulltextVersion||"unknown",sourceReview:null,sourceDiagnostics:acquired.sourceDiagnostics||[],...(acquired.publisherURL?{publisherURL:acquired.publisherURL}:{}),nextCheckAt:null,lastError:""});return;}
      abortIf(id,ticket);
      await update(id,{...(acquired.publisherURL?{publisherURL:acquired.publisherURL}:{}),accessEvidence:acquired.accessEvidence||null,sourceDiagnostics:acquired.sourceDiagnostics||[]});abortIf(id,ticket);
      if(acquired.needsReview&&acquired.reviewBytes){
        const paper=acquired.paper||{doi:currentDOI,title:item.getField("title")};validatePaper(paper,item);const sha256=await digest(acquired.reviewBytes),file=reviewPath(id);abortIf(id,ticket);
        const review=MODEL.updateTask(taskById(id),{state:"manual_review",sourceReview:{...paper,sha256,source:acquired.source,sourceURL:acquired.sourceURL||"",fulltextVersion:acquired.fulltextVersion||"unknown"}}).sourceReview;
        await IOUtils.makeDirectory(dataDir,{ignoreExisting:true});await IOUtils.write(file,acquired.reviewBytes);abortIf(id,ticket);
        pendingPDFs.set(id,{path:file,digest:sha256,paper,filename:"全文候选.pdf",summary:"已取得 PDF，但不能充分确认论文身份。请预览 DOI 和标题后确认。",sourceReview:review});
        await update(id,{state:"manual_review",sourceReview:review,acquisitionMode:"",nextCheckAt:null,lastError:"已取得 PDF，但论文身份仍待核对；尚未入库，也未转为科研通求助。"});return;
      }
      task=taskById(id);const history=accessHint(task);
      if(!task.allowAssist){await update(id,{state:acquired.state==="needs_login"||history.institutionalConfirmed?"needs_login":"not_found",lastError:history.institutionalConfirmed?history.message:acquired.message,nextCheckAt:null});return;}
      if(!task.doi){await update(id,{state:"needs_review",lastError:"条目缺少 DOI，请补全后再发起科研通求助。"});return;}
      if(!(await api.refreshAccount()).authenticated){await update(id,{state:"pending_login",lastError:"网页未获取到全文。请先在设置中登录科研通。"});return;}
      const previous=await adapter.findExistingRequest(task.doi);abortIf(id,ticket);
      if(previous){await bindRequest(id,previous,{state:"waiting",lastError:""});await checkRemote(id,ticket);return;}
      await update(id,{state:"submitting",lastError:"正在按任务记录的积分发起求助…"});abortIf(id,ticket);
      const posted=await adapter.submitRequest({doi:task.doi,points:task.requestedPoints,acceptSiteMinimum:task.acceptSiteMinimum,title:task.title,isCancelled:()=>stopped||cancellations.get(id)!==ticket});
      // Preserve the remote identity even when paused while a submission was in flight.
      await bindRequest(id,posted,{state:cancellations.get(id)===ticket?"waiting":"paused",nextCheckAt:new Date(Date.now()+settings.pollSeconds*1000).toISOString(),lastError:""});abortIf(id,ticket);await checkRemote(id,ticket);
    }catch(e){if(e.name!=="AbortError"&&!stopped){const task=taskById(id),auth=/AUTH|LOGIN/.test(e.code||""),uncertain=e.reconcileRequired===true||/UNKNOWN|UNCERTAIN|DUPLICATE_INTENT|SUBMISSION_MISMATCH/.test(e.code||"");if(cancellations.get(id)!==ticket&&!uncertain)return;const transient=!!task.requestID&&e.retryable===true&&!auth&&!uncertain,attempts=task.attempts+1,retrySeconds=Math.min(3600,settings.pollSeconds*2**Math.min(attempts-1,6));await update(id,{state:auth?"pending_login":uncertain?"submission_unknown":transient?"waiting":"error",submissionReview:e.submissionReview||task.submissionReview,lastError:(transient?"检查暂时失败，将在 "+retrySeconds+" 秒后重试。":"")+safeError(e),attempts,nextCheckAt:transient?new Date(Date.now()+retrySeconds*1000).toISOString():null});}}
    finally{active.delete(id);emit();}
  }
  async function poll(){if(stopped||polling)return;polling=true;try{for(const t of tasks.filter(t=>t.requestID&&["waiting","available","ready_to_check"].includes(t.state)&&(!t.nextCheckAt||Date.parse(t.nextCheckAt)<=Date.now()))){if(stopped)break;const current=taskById(t.id);if(!["waiting","available","ready_to_check"].includes(current.state)||(current.nextCheckAt&&Date.parse(current.nextCheckAt)>Date.now()))continue;await runTask(t.id);await Zotero.Promise.delay(1200);}if(account.status==="authenticated")for(const t of tasks.filter(t=>t.state==="imported"&&t.assistReceipt&&t.assistReceipt.messages!=="done"&&(!t.assistReceipt.nextCheckAt||Date.parse(t.assistReceipt.nextCheckAt)<=Date.now()))){if(stopped)break;await finishAssist(t.id).catch(error=>Zotero.logError(new Error(safeError(error))));}if(account.status==="authenticated"){const costTask=tasks.find(t=>t.state==="imported"&&t.source==="ablesci"&&t.requestID&&!t.pointsVerified&&(!t.lastCheckedAt||Date.now()-Date.parse(t.lastCheckedAt)>=settings.pollSeconds*1000));if(costTask)await api.refreshAssistPoints(costTask.id);}if(account.status==="authenticated"&&(!messagesStatus.lastAttemptAt||Date.now()-Date.parse(messagesStatus.lastAttemptAt)>=settings.pollSeconds*1000))await api.refreshMessages().catch(()=>{});}finally{polling=false;}}
  async function runBrowserTask(id,ticket){
    try{
      const task=taskById(id),item=await linkedItem(task,task.doi),library=Zotero.Libraries.get(task.libraryID);
      if(!item||!library?.editable||!library.filesEditable)throw new Error("此条目不存在或文库不能保存附件。");
      abortIf(id,ticket);
      const existing=await scope.FulltextPublisher.findExistingPDF(item,{Zotero,IOUtils});
      if(existing){
        abortIf(id,ticket);await update(id,{state:"imported",source:"existing",attachmentID:existing,lastError:"",nextCheckAt:null});return;
      }
      const result=await edgeAcquire.acquire({...task,officialURL:item.getField("url")||task.officialURL,title:item.getField("title")||task.title},{
        isCancelled:()=>stopped||cancellations.get(id)!==ticket,
        async onProgress(info){abortIf(id,ticket);await update(id,{state:browserStates.has(info.state)?info.state:"browser_scanning",lastError:info.message||"正在查找论文 PDF…",nextCheckAt:null});abortIf(id,ticket);}
      });
      abortIf(id,ticket);
      if(!scope.FulltextPublisher.validPDF(result?.bytes))throw new Error("浏览器未返回完整有效的 PDF，未导入。");
      await update(id,{state:"browser_downloading",lastError:"正在将 PDF 保存到原文献…"});
      const identity=current=>{if(!current||itemDOI(current)!==task.doi||(!task.doi&&current.getField("title")!==task.title))throw new Error("浏览器获取期间原文献身份已改变，请核对 DOI 或标题后重试。");};
      const attachment=await persistPDF(task,result.bytes,ticket,identity);
      await update(id,{state:"imported",source:"edge_browser",downloadRoute:"",attachmentID:attachment.id,attempts:0,lastError:"",nextCheckAt:null});
    }catch(error){
      if(error.name!=="AbortError"&&!stopped&&cancellations.get(id)===ticket)await update(id,{state:"error",lastError:safeError(error),nextCheckAt:null});
    }finally{active.delete(id);browserRuns.delete(id);emit();}
  }
  function wrapped(values){const o={...values};o.wrappedJSObject=o;return o;}
  const api={
    async start(){
      settings.language=scope.FulltextI18n?.normalizeLanguage(Services.prefs.getStringPref?.(PREF+"language","zh-CN"))||"zh-CN";
      try{settings.points=MODEL.validatePoints(Services.prefs.getIntPref(PREF+"points",10));}catch(_){settings.points=10;}
      settings.pollSeconds=Math.max(60,Math.min(3600,Services.prefs.getIntPref(PREF+"pollSeconds",60)));settings.autoDownload=Services.prefs.getBoolPref(PREF+"autoDownload",true);settings.acceptSiteMinimum=Services.prefs.getBoolPref(PREF+"acceptSiteMinimum",false);
      settings.checkInReminder=Services.prefs.getBoolPref(PREF+"checkInReminder",true);
      if(await IOUtils.exists(checkInPath))try{const stored=JSON.parse(await IOUtils.readUTF8(checkInPath));if(stored.schemaVersion===1&&Array.isArray(stored.accounts))checkInRecords=stored.accounts.map(normalizedCheckIn).filter(Boolean).slice(0,20);}catch(error){Zotero.logError(new Error(safeError(error)));}
      const storedDirectories=Services.prefs.getStringPref?.(PREF+"downloadDirectories","")||"";
      try{settings.downloadDirectories=storedDirectories?scope.FulltextDownloadFolders.normalize(JSON.parse(storedDirectories)):await discoverFolders();}catch(_){settings.downloadDirectories=[];}
      if(!storedDirectories)Services.prefs.setStringPref?.(PREF+"downloadDirectories",JSON.stringify(settings.downloadDirectories));
      if(await IOUtils.exists(queuePath)){const stored=MODEL.deserializeQueue(await IOUtils.readUTF8(queuePath));tasks=stored.tasks;currentBatch=stored.currentBatch;captureSummary=currentBatch?.summary||null;captureSequence=captureSummary?.id||0;}
      queueLoaded=true;
      if(scope.FulltextAccessHistory){
        if(await IOUtils.exists(accessPath))try{accessHistory=scope.FulltextAccessHistory.normalize(JSON.parse(await IOUtils.readUTF8(accessPath)));}catch(error){Zotero.logError(new Error(safeError(error)));}
        // Previous versions treated all hand-picked PDFs as publisher access.
        // A linked assistance request makes that inference ambiguous; retain
        // explicit user confirmations but discard automatically inferred hints.
        const ambiguousDOIs=new Set(tasks.filter(t=>t.requestID&&["local_file","browser_download","ablesci"].includes(t.source)).map(t=>t.doi));
        accessHistory.entries=accessHistory.entries.filter(entry=>entry.kind!=="browser_success"||!ambiguousDOIs.has(entry.doi));
        for(const task of tasks.filter(t=>t.state==="imported"&&!t.requestID&&["browser_download","local_file"].includes(t.source)))
          try{accessHistory=scope.FulltextAccessHistory.record(accessHistory,{url:task.officialURL,doi:task.doi,kind:"browser_success",source:"legacy_history",at:task.completedAt||task.updatedAt});}catch(_){}
      }
      if(await IOUtils.exists(intentPath)){const data=JSON.parse(await IOUtils.readUTF8(intentPath));if(data&&typeof data==="object"&&!Array.isArray(data))intents=data;}
      tasks=tasks.map(t=>t.acquisitionMode==="browser"&&t.state!=="imported"?MODEL.updateTask(t,{state:"paused",acquisitionMode:"",nextCheckAt:null,lastError:"已停用专用 Edge 入口。可在日常浏览器下载并自动入库，或选择科研通兜底。"}):t.acquisitionMode==="manual"&&!t.sourceReview&&t.state!=="imported"?MODEL.updateTask(t,{state:"paused",nextCheckAt:null,lastError:"上次下载检查已暂停；点击浏览器下载可重新开始。任务与已有求助保留。"}):["submitting","resolving","downloading"].includes(t.state)?MODEL.updateTask(t,{state:t.state==="submitting"?"submission_unknown":"queued"}):t);
      credentials=scope.FulltextCredentials.create({Services});session=scope.FulltextSession.create({Zotero,Services,rootURI,credentials});await session.initialize();
      const summary=await credentials.getSummary();account.username=summary.username;account.hasSavedPassword=summary.saved;
      publisherSession=scope.FulltextPublisherSession?.create({Zotero,Services});try{await publisherSession?.initialize();}catch(error){Zotero.logError(new Error(safeError(error)));}
      if(scope.FulltextSources){
        try{sourceSettings=scope.FulltextSources.normalizeSettings(JSON.parse(Services.prefs.getStringPref(PREF+"sourceSettings","{}")));}catch(_){sourceSettings=scope.FulltextSources.normalizeSettings({});}
        sourceCredentials=await credentials.getAPIKeySummary();
        sourceUsage=scope.FulltextSourceUsage.create({IOUtils,directory:dataDir,path:PathUtils.join(dataDir,"source-usage.json"),digest});
        sources=scope.FulltextSources.create({Zotero,Services,parseHTML,getSettings:()=>sourceSettings,getAPIKey:provider=>credentials.getAPIKey(provider),reserveDownloadSlot:options=>sourceUsage.reserve(options)});
      }
      if(scope.FulltextUpdate){updater=scope.FulltextUpdate.create({Services,Zotero,pluginID,version,emit});await updater.initialize();}
      pdfIdentity=injectedPDFIdentity||scope.FulltextPDFIdentity.create({Zotero,IOUtils});
      adapter=scope.FulltextAbleSci.create({request:transport,parseHTML,model:MODEL,intentStore});publisher=scope.FulltextPublisher.create({Zotero,Services,IOUtils,PathUtils,parseHTML,publisherSession,pdfIdentity,sources,getSourceSettings:()=>sourceSettings});
      publisherWindow=scope.FulltextPublisherWindow.create({Zotero,Services,rootURI,publisherSession});
      edgeHost=injectedEdgeHost||scope.FulltextEdgeHost?.create({Zotero,Services,IOUtils,PathUtils});
      edgeAcquire=injectedEdgeAcquire||(edgeHost&&scope.FulltextEdgeAcquire?.create({host:edgeHost,parseHTML,validPDF:scope.FulltextPublisher.validPDF,Zotero}));
      for(const task of tasks.filter(t=>t.state==="manual_review"&&t.sourceReview)){
        const review=task.sourceReview,file=reviewPath(task.id);
        if(await IOUtils.exists(file))pendingPDFs.set(task.id,{path:file,digest:review.sha256,paper:{doi:review.doi,title:review.title},filename:"全文候选.pdf",summary:"上次暂存的全文 PDF。请预览并核对论文后确认入库。",sourceReview:{...review}});
        else await update(task.id,{state:"error",sourceReview:null,lastError:"待核对的全文文件已丢失，请重新获取。"});
      }
      for(const task of tasks.filter(t=>t.state==="manual_review"&&t.assistReview)){
        const review=task.assistReview,file=reviewPath(task.id);
        if(await IOUtils.exists(file))pendingPDFs.set(task.id,{path:file,digest:review.sha256,paper:{doi:review.doi,title:review.title},filename:"应助全文.pdf",summary:"上次暂存的应助 PDF。请预览并核对论文，确认后入库及采纳。",assistReview:{...review}});
        else await update(task.id,{state:"error",assistReview:null,lastError:"待核对的应助文件已丢失，请重新下载；未执行采纳。"});
      }
      downloadWatch=scope.FulltextDownloadWatch.create({IOUtils,PathUtils,validPDF:scope.FulltextPublisher.validPDF,inspect:(...args)=>pdfIdentity.inspect(...args),
        async onMatch(id,candidate){
          if(stopped||active.has(id)||localRuns.has(id))return false;
          if(taskById(id).state!=="manual_waiting")return true;
          try{await startLocalImport(id,{file:candidate.path,bytes:candidate.bytes,expected:candidate.expected,automatic:true});}catch(error){if(error.name!=="AbortError")Zotero.logError(new Error(safeError(error)));}return true;
        },
        async onCandidate(id,candidate){
          const ticket=cancellations.get(id),current=()=>!stopped&&cancellations.get(id)===ticket&&tasks.find(t=>t.id===id)?.state==="manual_waiting";
          if(!current()||candidate.identity?.status!=="unknown"||candidate.identity.related!==true||!(candidate.identity.candidateScore>0))return;
          const sha256=await digest(candidate.bytes);
          if(!current())return;
          const list=downloadCandidates.get(id)||[];
          const identity=candidate.identity;
          const record={id:sha256,path:candidate.path,sha256,expected:{...candidate.expected},filename:filename(candidate.path),reason:identity.reason||"",message:identity.message||"文件已发现，但尚不能确认论文身份，请预览核对。",
            related:true,candidateScore:identity.candidateScore,titleSimilarity:Number.isFinite(identity.titleSimilarity)?identity.titleSimilarity:null,
            detectedTitle:identity.detectedTitle||"",detectedDOIs:Array.isArray(identity.detectedDOIs)?identity.detectedDOIs.slice(0,8):[],evidence:identity.evidence?JSON.parse(JSON.stringify(identity.evidence)):null};
          const ordered=[record,...list.filter(value=>value.path!==record.path&&value.id!==record.id)].sort((a,b)=>b.candidateScore-a.candidateScore||a.filename.localeCompare(b.filename));
          downloadCandidates.set(id,ordered.slice(0,3));emit();
        },
        async onIssue(id,issue){
          if(stopped||taskById(id).state!=="manual_waiting")return;
          if(issue.path)downloadCandidates.set(id,(downloadCandidates.get(id)||[]).filter(value=>value.path!==issue.path));
          const message=issue.kind==="identity"?(issue.category==="related"||(downloadCandidates.get(id)||[]).length
            ?"已发现相关候选，请展开下载检查详情核对。"
            :"本轮检查尚未确认匹配的 PDF；已排除和识别不足的文件可在检查详情中查看。") : issue.message;
          await update(id,{state:["expired","directory"].includes(issue.kind)?"paused":"manual_waiting",lastError:message,nextCheckAt:null});
        }
      });
      registerMenus();
      await Zotero.PreferencePanes.register({id:PANE,pluginID,src:"ui/preferences.xhtml",label:translate("全文助手"),image:"assets/icon-32.png",scripts:["ui/prefs.js"],stylesheets:["ui/prefs.css"]});
      timer=setInterval(()=>poll().catch(e=>Zotero.logError(new Error(safeError(e)))),15000);downloadTimer=setInterval(()=>api.checkDownloads().catch(e=>Zotero.logError(new Error(safeError(e)))),2000);await save();
      checkInTimer=setInterval(()=>checkInTick().catch(e=>Zotero.logError(new Error(safeError(e)))),60000);
      if(session.getStatus().hasCookies)api.refreshAccount().then(()=>Promise.allSettled([poll(),checkInTick()])).catch(()=>{});schedulePump();
    },
    getSnapshot(){return{version,sourceSettings:JSON.parse(JSON.stringify(sourceSettings)),sourceCredentials:{...sourceCredentials},updateStatus:updater?.getSnapshot()||{state:"idle",currentVersion:version,autoUpdate:false},checkIn:checkInSnapshot(),tasks:tasks.map(t=>({...t,sourceDiagnostics:t.sourceDiagnostics.map(value=>({...value})),sourceReview:t.sourceReview?{...t.sourceReview}:null,doiCheck:t.doiCheck?{...t.doiCheck}:null,submissionReview:t.submissionReview?{...t.submissionReview}:null,assistReceipt:t.assistReceipt?{...t.assistReceipt}:null,assistReview:t.assistReview?{...t.assistReview}:null,accessEvidence:t.accessEvidence?{...t.accessEvidence}:null,accessHint:accessHint(t),downloadStatus:downloadWatch?.getStatus?.(t.id)||null,downloadDiagnostics:downloadWatch?.getDiagnostics?.(t.id)||[],downloadCandidates:(downloadCandidates.get(t.id)||[]).map(c=>({id:c.id,filename:c.filename,message:c.message,reason:c.reason,related:c.related,candidateScore:c.candidateScore,titleSimilarity:c.titleSimilarity,detectedTitle:c.detectedTitle,detectedDOIs:[...c.detectedDOIs],evidence:c.evidence?JSON.parse(JSON.stringify(c.evidence)):null})),...(pendingPDFs.has(t.id)?{pendingFilename:pendingPDFs.get(t.id).filename,pendingSummary:pendingPDFs.get(t.id).summary,pendingTitle:pendingPDFs.get(t.id).paper.title}:{})})),settings:{...settings,downloadDirectories:[...settings.downloadDirectories],downloadDirectory:settings.downloadDirectories[0]||""},session:{...account,persistent:true,storageError:session?.getStatus().error},publisherSession:publisherSession?.getStatus()||{},messages:messages.map(m=>({...m})),messagesStatus:{...messagesStatus},selectedTaskId,captureSummary:copyCaptureSummary(captureSummary),currentBatch:currentBatch?JSON.parse(JSON.stringify(currentBatch)):null};},
    async saveSourceSettings(value){
      if(!scope.FulltextSources)throw new Error("全文来源模块尚未就绪。");
      if(!value||typeof value!=="object"||!Number.isInteger(value.openalexDailyLimit)||value.openalexDailyLimit<1||value.openalexDailyLimit>1000)throw new Error("OpenAlex 本机每日下载上限须为 1 至 1000 的整数。");
      if(scope.FulltextSources.parseTemplates(value.customTemplates).diagnostics.length)throw new Error("请检查自定义来源：最多 8 个公开 HTTPS 地址，每个地址须包含 {doi}，不能含凭据或本地地址。");
      const next=scope.FulltextSources.normalizeSettings(value);
      Services.prefs.setStringPref(PREF+"sourceSettings",JSON.stringify(next));sourceSettings=next;emit();return{saved:true};
    },
    async saveSourceCredentials(value){
      try{sourceCredentials=await credentials.saveAPIKeys(value);emit();return{saved:true};}
      catch(_){throw new Error("API key 保存失败，请检查格式及 Zotero 安全凭据存储后重试。");}
    },
    checkForUpdates(){return updater?.check();},installUpdate(){return updater?.install();},
    setAutoUpdate(value){return updater?.setAutoUpdate(value);},openReleaseNotes(){return updater?.openReleaseNotes();},
    subscribe(f){listeners.add(f);return()=>listeners.delete(f);},getSelectedTask(){return tasks.find(t=>t.id===selectedTaskId)||null;},selectTask(id){taskById(id);selectedTaskId=id;emit();},
    async openPreferences(){
      // Zotero can expose a newly reopened preferences window before its
      // navigation controller is initialized during a hot add-on upgrade.
      for(let i=0;i<50;i++){
        let win;try{win=Services.wm?.getMostRecentWindow("zotero:pref");}catch(_){}
        if(!win||win.closed||win.Zotero_Preferences?.navigation)break;
        if(stopped)return;await Zotero.Promise.delay(100);
      }
      if(!stopped)return Zotero.Utilities.Internal.openPreferences(PANE);
    },openWindow(){return api.openPreferences();},
    translate,localize(root){return scope.FulltextI18n?.apply(root,settings.language);},
    copyText(value){if(typeof value!=="string"||!value.trim()||value.length>10000)throw new Error("没有可复制的文本。");Zotero.Utilities.Internal.copyTextToClipboard(value);return true;},
    async saveSettings(value){const points=MODEL.validatePoints(value.points??settings.points),seconds=Number(value.pollSeconds??settings.pollSeconds);if(!Number.isInteger(seconds)||seconds<60||seconds>3600)throw new Error("检查间隔应为 60–3600 秒的整数。");const language=value.language??settings.language;if(!["zh-CN","zh-TW","en"].includes(language))throw new Error("不支持此界面语言。");Services.prefs.setStringPref(PREF+"language",language);Services.prefs.setIntPref(PREF+"points",points);Services.prefs.setIntPref(PREF+"pollSeconds",seconds);Services.prefs.setBoolPref(PREF+"autoDownload",value.autoDownload??settings.autoDownload);Services.prefs.setBoolPref(PREF+"acceptSiteMinimum",value.acceptSiteMinimum??settings.acceptSiteMinimum);Services.prefs.setBoolPref(PREF+"checkInReminder",value.checkInReminder??settings.checkInReminder);settings={...settings,points,pollSeconds:seconds,autoDownload:value.autoDownload??settings.autoDownload,acceptSiteMinimum:value.acceptSiteMinimum??settings.acceptSiteMinimum,checkInReminder:value.checkInReminder??settings.checkInReminder,language};emit();},
    async confirmInstitutionalAccess(id){const task=taskById(id);if(task.state!=="imported"||!["browser_download","local_file"].includes(task.source))throw new Error("请先通过浏览器取得并保存此论文，再确认机构访问。");if(!scope.FulltextAccessHistory?.normalizeDOI(task.doi)||!scope.FulltextAccessHistory?.publisherHost(task.publisherURL||task.officialURL))throw new Error("此论文缺少 DOI 或有效出版社网址，暂不能保存机构访问记录。");await linkedItem(task,task.doi);await rememberAccess(task,"institutional_confirmed","user_confirmation",true);return accessHint(task);},
    async forgetInstitutionalAccess(id){const task=taskById(id);if(!scope.FulltextAccessHistory)return;const operation=accessSaveChain.catch(()=>{}).then(async()=>{let next=scope.FulltextAccessHistory.forget(accessHistory,{url:task.publisherURL||task.officialURL,doi:task.doi});next=scope.FulltextAccessHistory.forget(next,{url:task.officialURL,doi:task.doi});await IOUtils.writeUTF8(accessPath,JSON.stringify(next),{tmpPath:accessPath+".tmp"});accessHistory=next;emit();});accessSaveChain=operation;await operation;return accessHint(task);},
    async chooseDownloadDirectory(){
      let directory;
      if(pickDirectory)directory=await pickDirectory();
      else{const {FilePicker}=ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");const picker=new FilePicker();picker.init(Zotero.getMainWindow(),"添加浏览器保存 PDF 的文件夹",picker.modeGetFolder);if(await picker.show()===picker.returnOK)directory=picker.file;}
      if(!directory)return{cancelled:true};
      if((await IOUtils.stat(directory,{followSymlinks:false})).type!=="directory")throw new Error("请选择可访问的文件夹。");
      const result=await setDownloadDirectories([...settings.downloadDirectories,directory]);return{cancelled:false,directory,...result};
    },
    async removeDownloadDirectory(directory){
      return setDownloadDirectories(settings.downloadDirectories.filter(value=>value!==directory));
    },
    async detectDownloadDirectories(){const before=settings.downloadDirectories.length;const result=await setDownloadDirectories([...settings.downloadDirectories,...await discoverFolders()]);return{added:settings.downloadDirectories.length-before,directories:[...settings.downloadDirectories],...result};},
    async checkDownloads(){await downloadWatch.poll();if(tasks.some(t=>t.state==="manual_waiting"))emit();},
    async recheckDownloadedPDFs(id){
      let task=taskById(id);
      if(task.state==="imported")return{alreadyImported:true};
      if(active.has(id)||browserHandoffs.has(id)||localRuns.has(id)||task.submissionReview||["submitting","submission_unknown"].includes(task.state))throw new Error("此任务正在处理，请先完成当前操作。");
      const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);active.add(id);
      const check=()=>{if(stopped||cancellations.get(id)!==ticket){const e=new Error("下载检查已取消。");e.name="AbortError";throw e;}};
      try{
        const item=await linkedItem(task,task.doi);check();
        if(!item)throw new Error("请先关联文献。");
        const paper={doi:itemDOI(item),title:item.getField("title")};
        downloadCandidates.delete(id);pendingPDFs.delete(id);downloadWatch.cancel(id);
        await update(id,{...paper,state:"manual_waiting",acquisitionMode:"manual",lastError:"正在检查本任务创建后下载到配置文件夹的 PDF；已有求助保留，匹配入库后会核验科研通文件来源。",nextCheckAt:null});check();
        await downloadWatch.start(id,[...settings.downloadDirectories],paper,{isCancelled:()=>stopped||cancellations.get(id)!==ticket||taskById(id).state!=="manual_waiting"});check();
        await downloadWatch.rescan(id,{includeExisting:true,since:Date.parse(task.createdAt)});check();
        return{watching:true};
      }catch(error){downloadWatch.cancel(id);if(error.name!=="AbortError"&&!stopped&&cancellations.get(id)===ticket)await update(id,{state:"error",lastError:safeError(error)});throw error;}
      finally{active.delete(id);emit();}
    },
    async reviewDownloadCandidate(id,candidateID){
      const candidate=(downloadCandidates.get(id)||[]).find(value=>value.id===candidateID);
      if(!candidate)throw new Error("此候选文件已失效，请重新检查下载文件夹。");
      const ticket=cancellations.get(id),state=taskById(id).state;
      const check=()=>{if(stopped||cancellations.get(id)!==ticket||tasks.find(t=>t.id===id)?.state!==state||!(downloadCandidates.get(id)||[]).includes(candidate)){const error=new Error("候选文件核对已取消，请重新检查。");error.name="AbortError";throw error;}};
      const info=await IOUtils.stat(candidate.path,{followSymlinks:false});
      check();
      if(info.type!=="regular"||info.size<1024||info.size>100*1024*1024)throw new Error("候选 PDF 已改变，请重新检查。");
      const bytes=await IOUtils.read(candidate.path);check();
      if(await digest(bytes)!==candidate.sha256)throw new Error("候选 PDF 已改变，请重新检查。");
      check();
      const result=await startLocalImport(id,{file:candidate.path,bytes,expected:candidate.expected,forceReview:true,beforeStart:check});
      if(result.needsReview)await api.previewDownloadedPDF(id);
      return result;
    },
    captureItems(items,{allowAssist=false}={}){
      const selection=Array.from(items||[]),seen=new Set(),batchTaskIDs=new Set();
      const operation=captureChain.catch(()=>{}).then(async()=>{
      const summary={id:++captureSequence,selected:selection.length,eligible:0,queued:0,skippedExistingPDF:0,retained:0,ignored:0,duplicates:0,failed:0,cancelled:false,unprocessed:0,at:now(),message:"",queuedTaskIDs:[]};
      for(const value of selection){
        if(stopped){summary.cancelled=true;break;}
        try{
          const item=await captureItemParent(value);
          if(stopped){summary.cancelled=true;break;}
          if(!item){summary.ignored++;continue;}
          const key=item.libraryID+":"+(item.key||item.id);
          if(seen.has(key)){summary.duplicates++;continue;}
          seen.add(key);summary.eligible++;
          // Do this before creating or changing a task, including old history.
          const existingPDF=await scope.FulltextPublisher.findExistingPDF(item,{Zotero,IOUtils});
          if(stopped){summary.cancelled=true;break;}
          if(existingPDF){summary.skippedExistingPDF++;continue;}
          const existing=taskForItem(item);
          if(existing){
            batchTaskIDs.add(existing.id);
            const busy=active.has(existing.id)||localRuns.has(existing.id)||browserRuns.has(existing.id)||browserHandoffs.has(existing.id);
            const repair=existing.state==="imported"&&!busy;
            const retry=!busy&&!existing.requestID&&!existing.attachmentID&&!hasProtectedIntent(existing)&&
              ["not_found","needs_login","pending_login","needs_review","paused","error"].includes(existing.state);
            const fallback=allowAssist&&!busy&&!existing.requestID&&!existing.attachmentID&&!hasProtectedIntent(existing)&&
              ["not_found","needs_login","pending_login","needs_review","paused","error","manual_waiting","manual_review"].includes(existing.state);
            if(!repair&&!retry&&!fallback){summary.retained++;continue;}
            downloadWatch?.cancel(existing.id);pendingPDFs.delete(existing.id);cancellations.set(existing.id,(cancellations.get(existing.id)||0)+1);
            const patch={state:"queued",acquisitionMode:"",lastError:"",nextCheckAt:null};
            if(repair){patch.attachmentID=null;patch.completedAt=null;patch.source="";patch.downloadRoute="";}
            // An old successful public download must not silently authorize a new
            // paid request. Remote repairs retain their original request/budget.
            if(!existing.requestID){patch.allowAssist=allowAssist&&!hasProtectedIntent(existing);if(patch.allowAssist){patch.requestedPoints=settings.points;patch.acceptSiteMinimum=settings.acceptSiteMinimum;}}
            await enqueue(existing.id,patch);if(!stopped)selectedTaskId=existing.id;summary.queued++;summary.queuedTaskIDs.push(existing.id);continue;
          }
          let doi="";try{doi=MODEL.normalizeDOI(item.getField("DOI")||item.getExtraField?.("DOI"));}catch(_){}
          const result=MODEL.addTask(tasks,{libraryID:item.libraryID,itemID:item.id,itemKey:item.key,doi,title:item.getField("title"),officialURL:item.getField("url"),state:"queued",requestedPoints:settings.points,acceptSiteMinimum:settings.acceptSiteMinimum,allowAssist});
          tasks=result.tasks;
          batchTaskIDs.add(result.task.id);
          if(result.added){selectedTaskId=result.task.id;summary.queued++;summary.queuedTaskIDs.push(result.task.id);}else summary.retained++;
        }catch(error){if(stopped){summary.cancelled=true;break;}summary.failed++;Zotero.logError(new Error(safeError(error)));}
      }
      summary.cancelled ||= stopped;
      summary.unprocessed=summary.selected-summary.queued-summary.skippedExistingPDF-summary.retained-summary.ignored-summary.duplicates-summary.failed;
      summary.message="已选择 "+summary.selected+" 项：加入 "+summary.queued+" 项，已有 PDF 跳过 "+summary.skippedExistingPDF+" 项"+
        (summary.retained?"，保留已有任务 "+summary.retained+" 项":"")+(summary.duplicates?"，重复选择 "+summary.duplicates+" 项":"")+
        (summary.ignored?"，忽略不支持的条目 "+summary.ignored+" 项":"")+(summary.failed?"，检查失败 "+summary.failed+" 项":"")+
        (summary.cancelled?"；操作已停止，未处理 "+summary.unprocessed+" 项":"")+"。";
      if(!stopped){captureSummary=summary;currentBatch={id:"batch-"+Date.now().toString(36)+"-"+summary.id,createdAt:summary.at,taskIDs:[...batchTaskIDs],summary:copyCaptureSummary(summary)};await save();if(!stopped){emit();api.openPreferences().catch(error=>Zotero.logError(new Error(safeError(error))));if(summary.queued)schedulePump();}}
      return copyCaptureSummary(summary);
      });
      captureChain=operation;return operation;
    },
    async requestAssist(value,{points}={}){
      const ids=Array.from(new Set(Array.isArray(value)?value:[value]));
      const amount=MODEL.validatePoints(points??settings.points);
      const accepted=[],skipped=[];
      for(const id of ids){
        const t=taskById(id);
        if(!t.doi||t.attachmentID||t.requestID||active.has(id)||!["not_found","needs_login","pending_login","needs_review","paused","error","manual_waiting","manual_review"].includes(t.state)){
          skipped.push(id);continue;
        }
        if(hasProtectedIntent(t)){skipped.push(id);continue;}
        downloadWatch?.cancel(id);pendingPDFs.delete(id);cancellations.set(id,(cancellations.get(id)||0)+1);
        await enqueue(id,{allowAssist:true,acquisitionMode:"",lastError:"",requestedPoints:amount,acceptSiteMinimum:settings.acceptSiteMinimum});accepted.push(id);
      }
      schedulePump();return {accepted:accepted.length,skipped:skipped.length,acceptedIDs:accepted,skippedIDs:skipped};
    },
    async checkTask(id){
      let task=taskById(id);if(active.has(id))return;const cancellation=cancellations.get(id);
      if(task.state==="imported")return task.assistReceipt?finishAssist(id):{completed:true};
      if(task.submissionReview){
        const review=task.submissionReview,epoch=accountEpoch,ticket=(cancellations.get(id)||0)+1;
        cancellations.set(id,ticket);active.add(id);
        const check=()=>{accountCurrent(epoch);if(cancellations.get(id)!==ticket)throw Object.assign(new Error("核对已取消。"),{name:"AbortError"});};
        let bound=false;
        try{
          const currentAccount=await api.refreshAccount();check();if(!currentAccount.authenticated)throw new Error("请先登录发布该求助时的科研通账号。");
          const remote=await adapter.getRequest(review.requestID);check();
          const item=await linkedItem(task,"");check();const expected=item?itemDOI(item):task.doi,received=MODEL.normalizeDOI(remote.doi);
          if(remote.requestID!==review.requestID||remote.ownerID!==currentAccount.accountID)throw new Error("已发布求助的账号或编号不一致，请打开求助页面核对；不会重新发布。");
          if(!expected||!received||expected!==received){await update(id,{state:"submission_unknown",submissionReview:{...review,expectedDOI:expected,receivedDOI:received},lastError:"已发布求助与条目 DOI 仍不一致。请核对出版社原文及 Zotero 条目，修正后再点立即检查；不会重新发布。"});return{completed:false};}
          await bindRequest(id,remote,{doi:expected,title:item?item.getField("title"):task.title,state:"ready_to_check",lastError:"",nextCheckAt:null});check();bound=true;
        }catch(error){if(error.name==="AbortError"||stopped||epoch!==accountEpoch||cancellations.get(id)!==ticket)return{cancelled:true};await update(id,{state:"submission_unknown",lastError:safeError(error)});return{completed:false,message:safeError(error)};}
        finally{active.delete(id);emit();}
        if(bound)await runTask(id);return{bound};
      }
      if(task.acquisitionMode==="browser"&&!task.requestID&&task.state!=="imported")return api.openExternalTask(id);
      if(task.acquisitionMode==="manual"&&!task.requestID&&task.state!=="imported")return api.openSystemBrowserTask(id);
      if(task.state==="submission_unknown"){
        const previous=await adapter.findExistingRequest(task.doi);
        if(stopped||active.has(id)||cancellations.get(id)!==cancellation)return;
        if(!previous)throw new Error("尚未找到匹配的已发布求助。请在网站核对，不会自动重复提交。");
        await bindRequest(id,previous,{state:"waiting"});
      }
      task=taskById(id);
      if(task.requestID){
        if(stopped||active.has(id)||cancellations.get(id)!==cancellation)return;
        downloadWatch?.cancel(id);pendingPDFs.delete(id);downloadCandidates.delete(id);
        if(["paused","manual_waiting","manual_review"].includes(task.state)){
          await update(id,{state:"ready_to_check",acquisitionMode:"",assistReview:null,lastError:"",nextCheckAt:null});
          if(stopped||active.has(id)||cancellations.get(id)!==cancellation||taskById(id).state==="paused")return;
        }
        await runTask(id);
      }else await api.retryTask(id);
    },
    async downloadTask(id){const task=taskById(id);if(task.state==="imported")return task.assistReceipt?finishAssist(id):{completed:true};if(!task.requestID||!task.itemID)throw new Error("请先将可下载求助关联到文库条目。");if(!(await api.refreshAccount()).authenticated)throw new Error("请先登录科研通。");await runTask(id,{forceDownload:true});},
    retryAssistCompletion(id){return finishAssist(id);},
    async refreshAssistPoints(id){
      const original=taskById(id),epoch=accountEpoch;
      if(original.state!=="imported"||original.source!=="ablesci"||!original.requestID)return{verified:false};
      const result=await api.refreshAccount();accountCurrent(epoch);if(!result.authenticated)return{verified:false};
      try{
        const remote=await adapter.getRequest(original.requestID);accountCurrent(epoch);
        const current=taskById(id);if(current.requestID!==original.requestID||current.doi!==original.doi||current.state!=="imported")return{verified:false};
        if(remote.requestID!==original.requestID||remote.ownerID!==result.accountID||MODEL.normalizeDOI(remote.doi)!==original.doi){await update(id,{lastCheckedAt:now()});return{verified:false};}
        const points=verifiedPoints(remote);await update(id,{...points,lastCheckedAt:now()});return{verified:points.pointsVerified===true};
      }catch(error){if(!stopped&&epoch===accountEpoch)await update(id,{lastCheckedAt:now()});return{verified:false};}
    },
    async verifyAssistCompletion(id,localConfirmation=null){
      const original=taskById(id);if(original.assistReceipt)return finishAssist(id);
      if(original.state!=="imported"||!original.requestID||!original.attachmentID)throw new Error("请先保存 PDF 并关联科研通求助，再核验文件来源。");
      if(active.has(id))return{completed:false,message:"正在核验，请稍候。"};
      active.add(id);const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);const epoch=accountEpoch;const check=()=>{abortIf(id,ticket);accountCurrent(epoch);};
      try{
        if(!(await api.refreshAccount()).authenticated)throw new Error("请先登录原科研通账号。");check();
        const result=await adapter.getRequest(original.requestID);check();
        if(result.requestID!==original.requestID||MODEL.normalizeDOI(result.doi)!==original.doi)throw new Error("求助页面与原文献不一致，未补采纳。");
        let lastError;
        for(const file of (result.files||[]).filter(file=>["waiting","accept"].includes(file.status))){
          try{
            const download=await adapter.getDownload(result,file,{route:"auto-free",isCancelled:()=>stopped||epoch!==accountEpoch||cancellations.get(id)!==ticket});check();
            const verified=await importResponse(original,download,ticket,{verifyExisting:true,localConfirmation});check();
            if(!verified.receipt)throw new Error("缺少已核实的应助文件和账号标识，未补采纳。");
            const current=taskById(id);if(current.state!=="imported"||current.attachmentID!==original.attachmentID||current.requestID!==original.requestID)throw new Error("任务关联已改变，未补采纳。");
            await update(id,{source:"ablesci",assistReceipt:verified.receipt,...verifiedPoints(result),lastCheckedAt:now(),lastError:""});check();return await finishAssist(id);
          }catch(error){if(error.name==="AbortError")throw error;lastError=error;}
        }
        throw lastError||new Error("当前没有能与已保存 PDF 核对的应助文件，请打开原求助网页处理。");
      }catch(error){if(error.name==="AbortError")return{completed:false,cancelled:true};if(!stopped)await update(id,{lastError:safeError(error)});return{completed:false,message:safeError(error)};}
      finally{active.delete(id);emit();}
    },
    async retryTask(id,{points}={}){const t=taskById(id);if(t.state==="imported")return t.assistReceipt?finishAssist(id):{completed:true};if(t.state==="submission_unknown"||t.submissionReview)return api.checkTask(id);if(active.has(id))return;if(t.acquisitionMode==="browser"&&!t.requestID)return api.openExternalTask(id);if(t.acquisitionMode==="manual"&&!t.requestID&&!t.allowAssist)return api.openSystemBrowserTask(id);publisher.clearAccessGate?.(t.officialURL);downloadWatch?.cancel(id);pendingPDFs.delete(id);const patch={lastError:"",acquisitionMode:"",assistReview:null};if(!t.requestID&&t.allowAssist){if(hasProtectedIntent(t))throw new Error("此文献已有提交记录，请先检查已发布求助，不能更改其悬赏积分。");patch.requestedPoints=MODEL.validatePoints(points??settings.points);patch.acceptSiteMinimum=settings.acceptSiteMinimum;}await enqueue(id,patch);schedulePump();},
    async pauseTask(id){
      const task=taskById(id);if(task.state==="imported")return;
      cancellations.set(id,(cancellations.get(id)||0)+1);
      downloadWatch?.cancel(id);pendingPDFs.delete(id);
      const operation=browserRuns.get(id);if(operation)edgeAcquire?.cancel?.(id);
      await update(id,{state:"paused",nextCheckAt:null,lastError:task.acquisitionMode==="manual"?"下载文件夹检查已暂停。任务保留，可重新在浏览器下载，或使用科研通兜底。":task.acquisitionMode==="browser"?"专用 Edge 自动获取已暂停，可使用默认浏览器下载。":"本地已暂停，网站上的求助保持原状态。"});
      // Do not return while a late PDF or temporary verification tab is still
      // being cleaned up. Local import and explicit retry become safe on return.
      if(operation)await operation;
      const local=localRuns.get(id);if(local)await local.catch(()=>{});
    },
    async addExistingRequest(url,itemTaskId){
      const parsed=MODEL.parseRequestURL(url);
      const targetNow=()=>{const target=itemTaskId?taskById(itemTaskId):null;if(target?.requestID&&target.requestID!==parsed.requestID)throw new Error("此条目已关联另一个求助，不能覆盖现有关联。");if(target&&!target.requestID&&active.has(target.id))throw new Error("此任务正在处理，请先暂停任务后再关联已有求助。");return target;};
      let target=targetNow();
      if(target?.requestID===parsed.requestID){selectedTaskId=target.id;emit();return target;}
      const remote=await adapter.getRequest(parsed.requestID);target=targetNow();
      if(target){
        const current=await linkedItem(target,remote.doi||target.doi);target=targetNow();
        if(target.requestID===parsed.requestID){selectedTaskId=target.id;emit();return target;}
        await bindRequest(target.id,{...parsed,...verifiedPoints(remote)},{doi:remote.doi||(current?itemDOI(current):target.doi),state:"waiting",lastError:""});selectedTaskId=target.id;
      }else{const r=MODEL.addTask(tasks,{...parsed,doi:remote.doi||"",title:remote.title||"已有求助",state:"waiting",requestedPoints:settings.points,...verifiedPoints(remote)});tasks=r.tasks;selectedTaskId=r.task.id;await save();}
      emit();return api.getSelectedTask();
    },
    async getBindingCandidates(id){
      const task=taskById(id);if(task.itemID||!task.requestID||!task.doi)return [];
      const search=new Zotero.Search();search.addCondition("DOI","is",task.doi);
      const ids=await search.search(),candidates=[];
      for(const itemID of ids){
        const item=await Zotero.Items.getAsync(itemID);if(!item||item.deleted||!item.isRegularItem())continue;
        const library=Zotero.Libraries.get(item.libraryID);if(!library?.editable||!library.filesEditable)continue;
        let doi;try{doi=itemDOI(item);}catch(_){continue;}if(doi!==task.doi)continue;
        candidates.push({itemID:item.id,title:item.getField("title"),doi,libraryName:library.name||"我的文库"});
      }
      return candidates;
    },
    async bindExistingTask(id,itemID){
      let task=taskById(id);
      if(!Number.isSafeInteger(itemID)||itemID<=0)throw new Error("请选择要关联的文献。");
      if(!task.requestID||task.itemID)throw new Error("此任务不是未关联的已有求助，请刷新列表。");
      if(active.has(id))throw new Error("该求助正在检查，请稍后再关联。");
      const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);active.add(id);
      let boundID=id;
      try{
        const remote=await adapter.getRequest(task.requestID);
        if(stopped||cancellations.get(id)!==ticket){const e=new Error("关联已取消");e.name="AbortError";throw e;}
        task=taskById(id);
        const item=await Zotero.Items.getAsync(itemID),library=item&&Zotero.Libraries.get(item.libraryID);
        if(!item||item.deleted||!item.isRegularItem()||!library?.editable||!library.filesEditable)throw new Error("所选文献不存在或文库不可写。");
        const doi=itemDOI(item),remoteDOI=MODEL.normalizeDOI(remote.doi);
        if(!doi||!remoteDOI||doi!==remoteDOI||(task.doi&&task.doi!==remoteDOI))throw new Error("所选文献与求助 DOI 不一致，未关联。");
        const existing=tasks.find(t=>t.id!==id&&t.itemID===item.id&&t.libraryID===item.libraryID);
        if(existing&&(active.has(existing.id)||["submitting","submission_unknown"].includes(existing.state)||hasProtectedIntent(existing)&&!existing.requestID))throw new Error("所选文献仍有处理中或待核实任务，请先处理该任务。");
        if(existing?.requestID&&existing.requestID!==task.requestID)throw new Error("所选文献已关联其他求助，不能覆盖。");
        if(stopped||cancellations.get(id)!==ticket){const e=new Error("关联已取消");e.name="AbortError";throw e;}
        const patch={libraryID:item.libraryID,itemID:item.id,itemKey:item.key,doi,title:item.getField("title"),officialURL:item.getField("url"),acquisitionMode:"",state:"ready_to_check",assistReview:null,lastError:"",nextCheckAt:null};
        downloadWatch?.cancel(id);pendingPDFs.delete(id);
        if(existing){
          // Merge the standalone tracker into the explicitly selected item task.
          tasks=tasks.filter(t=>t.id!==id);boundID=existing.id;
          downloadWatch?.cancel(boundID);pendingPDFs.delete(boundID);
          await update(boundID,{...patch,requestID:task.requestID,requestURL:task.requestURL,requestedPoints:task.requestedPoints,pointsVerified:task.pointsVerified,...verifiedPoints(remote)});
        }else await update(id,{...patch,...verifiedPoints(remote)});
        selectedTaskId=boundID;
      }finally{active.delete(id);emit();}
      await api.checkTask(boundID);
      return taskById(boundID);
    },
    async openExternalTask(id){
      if(stopped)throw new Error("插件已停止。");
      const task=taskById(id);
      if(task.state==="imported")return api.openTask(id);
      if(task.requestID||task.requestURL)throw new Error("此文献已关联科研通求助，请使用“立即检查”或“下载到文库”；浏览器获取用于尚未求助的出版社论文。");
      if(browserHandoffs.has(id))throw new Error("正在切换到默认浏览器，请稍候。");
      if(browserRuns.has(id)&&task.state!=="paused"){await api.focusExternalTask(id);return{started:true};}
      if(active.has(id))throw new Error("此任务仍在停止或处理，请稍后再打开浏览器。");
      if(tasks.some(other=>other.id!==id&&other.itemID===task.itemID&&other.libraryID===task.libraryID&&active.has(other.id)))throw new Error("同一文献的另一个任务仍在处理，请等待完成或先暂停。");
      if(!task.itemID)throw new Error("请先关联 Zotero 文献，再使用浏览器自动获取。");
      if(task.submissionReview||["submitting","submission_unknown"].includes(task.state))throw new Error("请先核对已提交的求助，再切换获取方式。");
      if(!edgeAcquire)throw new Error("浏览器连接模块未加载，请重新启用全文助手。");
      const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);active.add(id);
      try{
        const item=await linkedItem(task,"");if(stopped||cancellations.get(id)!==ticket){const error=new Error("浏览器获取已取消。");error.name="AbortError";throw error;}
        const doi=itemDOI(item),title=item.getField("title"),officialURL=item.getField("url")||"";
        let url;try{url=new URL((doi===task.doi&&task.publisherURL)||officialURL||(doi?"https://doi.org/"+doi:""));}catch(_){throw new Error("此条目没有可用的论文网页地址。");}
        if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw new Error("此条目没有可用的论文网页地址。");
        await update(id,{doi,title,officialURL,state:"browser_waiting",acquisitionMode:"browser",lastError:"正在打开专用 Edge 自动获取窗口。网站允许访问后会查找 PDF；若验证反复出现，可切换到默认浏览器手动下载。",nextCheckAt:null});
        abortIf(id,ticket);
        const operation=Promise.resolve().then(()=>runBrowserTask(id,ticket));browserRuns.set(id,operation);
        operation.catch(error=>Zotero.logError(new Error(safeError(error))));
        return{started:true};
      }catch(error){active.delete(id);throw error;}
    },
    async focusExternalTask(id){
      taskById(id);if(!browserRuns.has(id))throw new Error("专用 Edge 自动获取已停止，请点击“重试专用 Edge 获取”，或使用默认浏览器手动下载。");
      if(await edgeAcquire?.focus?.(id)===false)throw new Error("专用 Edge 页面尚未就绪或已关闭；稍后再查看，或暂停后使用默认浏览器手动下载。");
    },
    openSystemBrowserTask(id){
      if(browserHandoffs.has(id))return browserHandoffs.get(id);
      const operation=Promise.resolve().then(async()=>{
        if(stopped)throw new Error("插件已停止。");
        let task=taskById(id);
        if(task.state==="imported")return{opened:false,alreadyImported:true};
        if(task.requestID||task.requestURL||task.submissionReview||["submitting","submission_unknown"].includes(task.state))throw new Error("此任务已有科研通求助记录，请使用求助网页或下载到文库。");
        if(!task.itemID)throw new Error("请先关联 Zotero 文献，再打开论文网页。");
        if(active.has(id)&&!browserRuns.has(id))throw new Error("此任务仍在处理，请先暂停，待处理结束后再打开默认浏览器。");
        if(browserRuns.has(id)){
          const pausing=api.pauseTask(id),pauseTicket=cancellations.get(id);await pausing;
          if(cancellations.get(id)!==pauseTicket){const error=new Error("浏览器切换已取消。");error.name="AbortError";throw error;}
        }
        if(stopped)throw new Error("插件已停止。");
        task=taskById(id);
        if(task.state==="imported")return{opened:false,alreadyImported:true};
        const ticket=(cancellations.get(id)||0)+1;cancellations.set(id,ticket);active.add(id);
        const check=()=>{if(stopped||cancellations.get(id)!==ticket){const error=new Error("浏览器切换已取消。");error.name="AbortError";throw error;}};
        try{
          const item=await linkedItem(task,"");check();
          const doi=itemDOI(item),title=item.getField("title"),officialURL=item.getField("url")||"";
          let url;try{url=new URL((doi===task.doi&&task.publisherURL)||officialURL||(doi?"https://doi.org/"+doi:""));}catch(_){throw new Error("此条目没有可用的论文网页地址。");}
          if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw new Error("此条目没有可用的论文网页地址。");
          if(!settings.downloadDirectories.length)throw new Error("请先在全文助手设置中添加或自动检测下载文件夹。");
          pendingPDFs.delete(id);downloadWatch.cancel(id);
          await update(id,{doi,title,officialURL,state:"manual_waiting",acquisitionMode:"manual",lastError:"请在日常浏览器完成机构登录或验证，并点击 PDF 下载。正在检查设置中的下载文件夹；确认匹配后会自动入库，科研通兜底仍可使用。",nextCheckAt:null});check();
          if(!await downloadWatch.start(id,[...settings.downloadDirectories],{doi,title},{isCancelled:()=>stopped||cancellations.get(id)!==ticket||taskById(id).state!=="manual_waiting"})){check();throw new Error("下载文件夹检查未能启动，请重试。");}check();
          // Use the operating system's normal URL handler, with no debugging
          // flags or profile access. Do not destroy the host shared by other tasks.
          await Zotero.launchURL(url.href);
          return{opened:true,watching:true};
        }catch(error){downloadWatch.cancel(id);if(error.name!=="AbortError"&&!stopped&&cancellations.get(id)===ticket)await update(id,{state:"error",nextCheckAt:null,lastError:safeError(error)});throw error;}
        finally{active.delete(id);emit();}
      }).finally(()=>browserHandoffs.delete(id));
      browserHandoffs.set(id,operation);return operation;
    },
    importLocalPDF(id){return startLocalImport(id,{forceReview:!!taskById(id).requestID});},
    confirmDownloadedPDF(id){
      const pending=pendingPDFs.get(id);if(!pending)throw new Error("没有待确认的 PDF，请重新选择文件。");
      return startLocalImport(id,{file:pending.path,expected:pending.paper,confirmed:true,assistReview:pending.assistReview||null,sourceReview:pending.sourceReview||null});
    },
    async previewDownloadedPDF(id){const pending=pendingPDFs.get(id);if(!pending)throw new Error("没有待预览的 PDF，请重新选择文件。");await Zotero.launchFile(pending.path);},
    async dismissDownloadedPDF(id){pendingPDFs.delete(id);await api.pauseTask(id);},
    async saveCredentialsAndLogin({username,password}){const saved=await credentials.getSummary();if(!password&&(!saved.saved||saved.username!==username))throw new Error("首次绑定或更换账号时需要输入密码，也可以直接选择网页登录。");if(saved.username!==username)await api.logout();if(password)await credentials.save({username,password});const s=await credentials.getSummary();account.username=s.username;account.hasSavedPassword=s.saved;emit();return api.openLogin();},
    async forgetCredentials(){await credentials.remove();account.hasSavedPassword=false;account.username="";emit();},
    async refreshCheckIn({force=false}={}){
      if(stopped||account.status!=="authenticated")return checkInSnapshot();
      const epoch=accountEpoch,accountID=account.accountID,day=localDay();
      if(checkInRun?.epoch===epoch)return checkInRun.promise;
      const previous=checkInRecords.find(record=>record.accountID===accountID);
      const cooldown=previous?.state==="error"?15*60000:2*60000;
      if(!force&&previous?.day===day&&Date.now()-Date.parse(previous.attemptedAt||previous.checkedAt)<cooldown)return checkInSnapshot();
      const run={epoch,promise:null};checkInRun=run;
      run.promise=Promise.resolve().then(async()=>{
        emit();
        try{
          const result=await adapter.getCheckInStatus({isCancelled:()=>stopped||accountEpoch!==epoch});accountCurrent(epoch);
          if(result.accountID!==accountID)throw new Error("账号已改变，请重新检查登录状态。");
          if(day!==localDay()||result.day!==day)throw new Error("查询跨过日期边界，请重新刷新签到状态。");
          const record=normalizedCheckIn({...result,accountID,day,state:"loaded",checkedAt:now(),attemptedAt:now(),message:""});
          if(!record)throw new Error("签到状态暂时无法核实，请打开科研通网页查看。");
          await saveCheckIn(record);accountCurrent(epoch);
          if(record.signed===true&&record.rewardVerified)checkInWatchUntil=0;
          return {...record};
        }catch(error){
          if(error.name!=="AbortError"&&epoch===accountEpoch&&!stopped){
            const cached=previous?.day===day?previous:{};
            await saveCheckIn({...emptyCheckIn(),...cached,accountID,day,state:"error",attemptedAt:now(),message:safeError(error)});
          }
          throw error;
        }finally{if(checkInRun===run)checkInRun=null;emit();}
      });return run.promise;
    },
    async preferencesOpened(){
      if(stopped||!settings.checkInReminder)return checkInSnapshot();
      if(account.status!=="authenticated"&&session.getStatus().hasCookies)await api.refreshAccount();
      return api.refreshCheckIn();
    },
    async openCheckIn(){
      checkInWatchUntil=Date.now()+10*60000;
      return api.openSite(ORIGIN+"/",null,"checkin");
    },
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
    async refreshMessages(){if(account.status!=="authenticated")throw new Error("请先绑定科研通账号。");const epoch=accountEpoch;messagesStatus={...messagesStatus,state:"loading",message:"正在读取站内消息",lastAttemptAt:now()};emit();try{const result=await adapter.listMessages();accountCurrent(epoch);messages=result;for(const task of tasks.filter(task=>task.state==="imported"&&task.assistReceipt?.adoption==="accepted"&&task.assistReceipt.messages==="done"&&task.assistReceipt.accountID===account.accountID)){accountCurrent(epoch);if(messages.some(message=>!message.read&&message.kind==="assist_upload"&&message.fileID===task.assistReceipt.fileID))await update(task.id,{assistReceipt:{...task.assistReceipt,messages:"pending",readAt:null,attempts:0,nextCheckAt:null,lastError:"收到这份已采纳文件的新上传通知，将继续标记对应消息已读。"}});}accountCurrent(epoch);messagesStatus={...messagesStatus,state:"loaded",message:messages.length?"":"暂无站内消息",lastCheckedAt:now()};emit();return messages;}catch(e){if(epoch===accountEpoch&&!stopped){messagesStatus={...messagesStatus,state:"error",message:safeError(e)};emit();}throw e;}},
    async openMessage(id){const m=messages.find(m=>m.id===id);if(!m?.url)throw new Error("此消息没有可打开的链接。");return api.openSite(m.url,null);},
    async openLogin(){return api.openSite(ORIGIN+"/site/login",null,"login");},
    async openRequest(id){const t=taskById(id);if(t.requestURL)return api.openSite(t.requestURL,id,"request");return api.openTask(id);},
    async openSubmissionReview(id){const review=taskById(id).submissionReview;if(!review)throw new Error("没有待核对的已发布求助。");return api.openSite(MODEL.parseRequestURL(review.requestURL).requestURL,null,"request");},
    async inspectDOI(value){
      const task=tasks.find(task=>task.id===value);
      if(!task)return adapter.inspectDOI(MODEL.normalizeDOI(value));
      const epoch=accountEpoch,item=task.itemID?await linkedItem(task,""):null;
      const expectedDOI=item?itemDOI(item):task.doi,expectedTitle=item?item.getField("title"):task.title;
      const result=await adapter.inspectDOI(expectedDOI);accountCurrent(epoch);
      const current=taskById(task.id),currentItem=current.itemID?await linkedItem(current,""):null;accountCurrent(epoch);
      if(current.itemID!==task.itemID||current.itemKey!==task.itemKey||current.libraryID!==task.libraryID||(currentItem&&(itemDOI(currentItem)!==expectedDOI||currentItem.getField("title")!==expectedTitle)))throw new Error("核对期间条目信息已改变，请重新核对网站文献信息。");
      await update(task.id,{doiCheck:{expectedDOI,receivedDOI:result.receivedDOI,expectedTitle,receivedTitle:result.title,reason:result.reason,checkedAt:now()}});
      return result;
    },
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
    detachBrowser(win){if(siteWindow===win){const checkIn=win.FulltextSiteMode==="checkin";siteWindow=null;siteBrowser=null;activePageTaskId=null;if(checkIn)api.refreshCheckIn({force:true}).catch(error=>Zotero.logError(new Error(safeError(error))));}},
    async fillSavedLogin(){if(account.hasSavedPassword&&siteBrowser)return session.fillSavedLogin(siteBrowser);return null;},
    async inspectActivePage(){if(!siteBrowser)throw new Error("网页尚未打开。");const result=await session.inspect(siteBrowser);await api.refreshAccount();if(siteWindow?.FulltextSiteMode==="checkin")await api.refreshCheckIn({force:true});if(activePageTaskId&&result.requestKey===taskById(activePageTaskId).requestID)await api.checkTask(activePageTaskId);return result;},
    async logout(){accountEpoch++;loginPromise=null;checkInWatchUntil=0;if(siteWindow&&!siteWindow.closed)siteWindow.close();siteWindow=null;siteBrowser=null;account={...account,accountID:null,displayName:"",status:"signed_out",message:"已退出科研通。已保存的账号密码可用于下次登录。"};messages=[];messagesStatus={state:"idle",message:"登录后显示站内消息",lastCheckedAt:null};emit();await pauseAccountTasks();await session.clearSession();},
    async clearSession(){return api.logout();},
    async stop(){
      stopped=true;updater?.destroy();clearInterval(timer);clearInterval(downloadTimer);clearInterval(checkInTimer);checkInWatchUntil=0;
      for(const id of [...browserRuns.keys(),...localRuns.keys()])cancellations.set(id,(cancellations.get(id)||0)+1);
      tasks=tasks.map(t=>!t.assistReview&&!t.sourceReview&&(browserStates.has(t.state)||["manual_waiting","manual_review"].includes(t.state))?MODEL.updateTask(t,{state:"paused",nextCheckAt:null,lastError:"下载检查已暂停；重启后可点击浏览器下载重新开始。"}):t);
      pendingPDFs.clear();
      downloadCandidates.clear();
      for(const id of menuIDs)Zotero.MenuManager.unregisterMenu(id);
      if(siteWindow&&!siteWindow.closed)siteWindow.close();publisherWindow?.destroy();
      try{await save();await intentChain;}
      finally{
        try{await edgeHost?.destroy();}
        finally{
          await Promise.allSettled([...taskRuns.values(),...browserRuns.values(),...browserHandoffs.values(),...localRuns.values(),...completionRuns.values(),downloadWatch?.stop()]);
          try{await saveChain;await accessSaveChain;await checkInSaveChain;await sourceUsage?.flush();}
          finally{try{await publisherSession?.destroy();}finally{try{await session?.destroy();}finally{listeners.clear();}}}
        }
      }
    }
  };
  return api;
}
scope.FulltextApp={create};
})(globalThis);
