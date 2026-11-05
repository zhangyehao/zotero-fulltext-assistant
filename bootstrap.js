var { classes: Cc, interfaces: Ci } = Components;
var chromeHandle;
var fulltextApp;

async function startup(data) {
  const aom = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = aom.registerChrome(Services.io.newURI(data.rootURI + "manifest.json"), [
    ["content", "fulltext-assistant", "./"]
  ]);
  for (const file of ["src/i18n-backend-data.js", "src/i18n.js", "src/task-model.js", "src/access-history.js", "src/credentials.js", "src/session.js", "src/ablesci.js", "src/publisher-session.js", "src/publisher.js", "src/publisher-window.js", "src/edge-host.js", "src/edge-acquire.js", "src/pdf-identity.js", "src/download-folders.js", "src/download-watch.js", "src/app.js"]) {
    Services.scriptloader.loadSubScript(data.rootURI + file, globalThis);
  }
  try {
    fulltextApp = FulltextApp.create({ Zotero, Services, IOUtils, PathUtils, rootURI: data.rootURI, pluginID: data.id, version: data.version });
    Zotero.FulltextAssistant = fulltextApp;
    await fulltextApp.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

async function shutdown() {
  try { if (fulltextApp) await fulltextApp.stop(); }
  finally {
    if (Zotero.FulltextAssistant === fulltextApp) delete Zotero.FulltextAssistant;
    fulltextApp = null;
    if (chromeHandle) chromeHandle.destruct();
    chromeHandle = null;
  }
}

function install() {}
function uninstall() {}
function onMainWindowLoad() {}
function onMainWindowUnload() {}
