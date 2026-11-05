"use strict";
window.addEventListener("load",async()=>{
  const {app,url,mode}=window.arguments[0].wrappedJSObject;
  const localize=()=>app.localize?.(document.documentElement);
  const languageObserver=window.MutationObserver?new window.MutationObserver(localize):null;
  languageObserver?.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["title","aria-label","placeholder"]});
  const unsubscribeLanguage=app.subscribe?.(localize);localize();
  window.FulltextSiteMode=mode||"request";
  const status=document.getElementById("ft-status"),button=document.getElementById("ft-read");
  let browser,timer,filled=false,checking=false,lastCheck=0,closed=false;
  window.addEventListener("unload",()=>{closed=true;if(timer)window.clearInterval(timer);languageObserver?.disconnect();unsubscribeLanguage?.();app.detachBrowser(window);},{once:true});
  button.disabled=true;
  try{browser=await app.attachBrowser(window,document.getElementById("ft-browser-holder"),url);}catch(e){status.textContent=e.message;return;}
  if(closed)return;button.disabled=false;
  async function checkAccount(explicit=false){
    if(checking||closed)return;checking=true;lastCheck=Date.now();
    try{const result=await app.refreshAccount();if(result.authenticated){status.textContent="已绑定科研通账号，登录状态已保存。";if(window.FulltextSiteMode==="login")window.close();}else if(explicit)status.textContent="尚未登录成功，请在下方网页完成登录。";}
    catch(e){if(explicit)status.textContent=e.message;}finally{checking=false;}
  }
  const tick=async()=>{
    if(closed)return;
    const current=browser.currentURI?.spec||url;document.getElementById("ft-address").textContent=current;
    button.textContent=window.FulltextSiteMode==="login"?"完成登录":"刷新任务状态";
    if(window.FulltextSiteMode!=="login")return;
    if(current.startsWith("https://www.ablesci.com/site/login")&&!filled){
      try{const result=await app.fillSavedLogin();if(result?.filled){filled=true;status.textContent="已填入保存的账号密码。请在网页完成验证码并点击登录。";}}catch(_){}
    }
    if(current.startsWith("https://www.ablesci.com/")&&!current.includes("/site/login")&&Date.now()-lastCheck>5000)await checkAccount();
  };
  timer=window.setInterval(()=>tick().catch(()=>{}),1200);await tick();
  button.addEventListener("click",async()=>{button.disabled=true;try{if(window.FulltextSiteMode==="login")await checkAccount(true);else{await app.inspectActivePage();status.textContent="任务状态已更新，可在 Zotero 设置 → 全文助手中查看。";}}catch(e){status.textContent=e.message;}finally{if(!closed)button.disabled=false;}});
},{once:true});
