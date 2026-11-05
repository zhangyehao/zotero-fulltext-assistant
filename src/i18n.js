/* Local, deterministic UI translations. No network service or runtime translator. */
(function (scope) {
  "use strict";
  const rows = [
    ["全文助手","全文助手","Full Text Assistant"],
    ["任务","任務","Tasks"],
    ["下载设置","下載設定","Download settings"],
    ["科研通账号","科研通帳號","AbleSci account"],
    ["消息","訊息","Messages"],
    ["全文助手页面","全文助手頁面","Full Text Assistant pages"],
    ["全文助手尚未初始化。请重启 Zotero 后再试。","全文助手尚未初始化。請重啟 Zotero 後再試。","Full Text Assistant has not initialized. Restart Zotero and try again."],
    ["批量获取可访问的全文，科研通作为最后一步求助。","批量取得可訪問的全文，科研通作為最後一步求助。","Retrieve accessible full text in batches, with AbleSci requests as a final fallback."],
    ["在文库多选文献，右击“全文助手 → 批量获取全文”。","在文庫多選文獻，右擊“全文助手 → 批量取得全文”。","Select items in your library, then right-click “Full Text Assistant → Get full text in batch”."],
    ["可继续从文库追加，排队按加入顺序处理。","可繼續從文庫追加，排隊按加入順序處理。","Keep adding items from your library. Queued items run in the order added."],
    ["任务记录与检查","任務記錄與檢查","Task history and checks"],
    ["任务和已获取记录保存在本机，重启后仍可查看。列表随任务进度自动更新；Zotero 运行时按设置间隔检查等待应助的任务，关闭 Zotero 后停止检查。","任務和已取得記錄儲存在本機，重啟後仍可查看。列表隨任務進度自動更新；Zotero 運行時按設定間隔檢查等待應助的任務，關閉 Zotero 後停止檢查。","Tasks and retrieved records are stored locally and remain available after restarting. The list updates as tasks progress. While Zotero is running, pending AbleSci requests are checked at the configured interval; checks stop when Zotero closes."],
    ["任务结果筛选","任務結果篩選","Filter task results"],
    ["进行中","進行中","In progress"],
    ["需网页登录","需網頁登入","Web login needed"],
    ["待兜底","待兜底","Needs fallback"],
    ["已获取","已取得","Retrieved"],
    ["未完成","未完成","Unfinished"],
    ["全部历史","全部歷史","Completed history"],
    ["进行中 {count}","進行中 {count}","In progress {count}"],
    ["需网页登录 {count}","需網頁登入 {count}","Web login needed {count}"],
    ["待兜底 {count}","待兜底 {count}","Needs fallback {count}"],
    ["已获取 {count}","已取得 {count}","Retrieved {count}"],
    ["未完成 {count}","未完成 {count}","Unfinished {count}"],
    ["全部历史 {count}","全部歷史 {count}","Completed history {count}"],
    ["当前批次 · {date} · 仅统计最近一次批量获取所涉及的任务。","當前批次 · {date} · 僅統計最近一次批量取得所涉及的任務。","Current batch · {date} · Only tasks included in the most recent batch are counted."],
    ["尚未记录当前批次。旧任务仍保留在“未完成”和“全部历史”中；从文库再次批量获取后可查看本批次分类。","尚未記錄當前批次。舊任務仍保留在“未完成”和“全部歷史”中；從文庫再次批量取得後可查看本批次分類。","No current batch has been recorded. Older tasks remain in “Unfinished” and “Completed history”. Start a batch from your library to see its categories here."],
    ["全部历史 · 跨批次的已获取记录，按完成时间从新到旧排列。","全部歷史 · 跨批次的已取得記錄，按完成時間從新到舊排列。","Completed history · Retrieved items from every batch, newest completion first."],
    ["未完成 · 跨批次保留所有未完成任务，包括已入库但采纳或对应消息尚未完成的任务。","未完成 · 跨批次保留所有未完成任務，包括已入庫但採納或對應訊息尚未完成的任務。","Unfinished · All unfinished tasks across batches, including saved PDFs with acceptance or related message handling still pending."],
    ["从文库发起一次批量获取后，这里会显示当前批次的任务。","從文庫發起一次批量取得後，這裡會顯示當前批次的任務。","Start a batch from your library to show the current batch here."],
    ["当前没有未完成任务。跨批次的已获取记录可在“全部历史”中查看。","當前沒有未完成任務。跨批次的已取得記錄可在“全部歷史”中查看。","No unfinished tasks. Open “Completed history” to view retrieved items from all batches."],
    ["当前筛选没有任务。","當前篩選沒有任務。","No tasks match this filter."],
    ["还没有任务。在文库多选文献，右击“全文助手 → 批量获取全文”开始批量获取。","還沒有任務。在文庫多選文獻，右擊“全文助手 → 批量取得全文”開始批量取得。","No tasks yet. Select items in your library and right-click “Full Text Assistant → Get full text in batch”."],
    ["最近一次批量获取","最近一次批量取得","Most recent batch"],
    ["本次选择已处理，结果见任务列表。","本次選擇已處理，結果見任務列表。","This selection has been processed. See the task list for results."],
    ["显示 {count}/{total} 项","顯示 {count}/{total} 項","Showing {count}/{total} items"],
    ["正在获取 {count} 项","正在取得 {count} 項","Retrieving {count}"],
    ["排队 {count} 项","排隊 {count} 項","Queued {count}"],
    ["等待应助 {count} 项","等待應助 {count} 項","Awaiting responses {count}"],
    ["等待浏览器下载 {count} 项","等待瀏覽器下載 {count} 項","Awaiting browser downloads {count}"],
    ["排队中","排隊中","Queued"],
    ["排队中 · 第 {position} 位","排隊中 · 第 {position} 位","Queued · Position {position}"],
    ["查找全文","查找全文","Finding full text"],
    ["正在获取","正在取得","Retrieving"],
    ["未找到全文","未找到全文","Full text not found"],
    ["检查账号","檢查帳號","Checking account"],
    ["正在求助","正在求助","Submitting request"],
    ["提交待核实","提交待核實","Submission needs verification"],
    ["需要登录","需要登入","Login needed"],
    ["待检查","待檢查","Awaiting check"],
    ["等待应助","等待應助","Awaiting response"],
    ["文件可下载","檔案可下載","File available"],
    ["正在下载","正在下載","Downloading"],
    ["校验文件","校驗檔案","Validating file"],
    ["需要核对","需要核對","Review needed"],
    ["已暂停","已暫停","Paused"],
    ["需要处理","需要處理","Action needed"],
    ["需要验证","需要驗證","Verification needed"],
    ["求助已关闭","求助已關閉","Request closed"],
    ["等待恢复","等待恢復","Awaiting resume"],
    ["等待浏览器下载","等待瀏覽器下載","Awaiting browser download"],
    ["待核对 PDF","待核對 PDF","PDF needs review"],
    ["待处理","待處理","Pending"],
    ["待关联文献","待關聯文獻","Link an item first"],
    ["已获取 · 待采纳","已取得 · 待採納","Retrieved · Acceptance pending"],
    ["已获取 · 采纳待核实","已取得 · 採納待核實","Retrieved · Acceptance unverified"],
    ["已采纳 · 待已读","已採納 · 待已讀","Accepted · Message pending"],
    ["已采纳 · 对应消息已读","已採納 · 對應訊息已讀","Accepted · Related message read"],
    ["选择当前列表可求助项","選擇當前列表可求助項","Select eligible items in this list"],
    ["为所选文献发起科研通求助","為所選文獻發起科研通求助","Request selected items on AbleSci"],
    ["为所选 {count} 篇发起科研通求助（每篇 {points} 积分）","為所選 {count} 篇發起科研通求助（每篇 {points} 積分）","Request {count} selected items on AbleSci ({points} points each)"],
    ["为所选 {count} 篇发起科研通求助（请填写有效积分）","為所選 {count} 篇發起科研通求助（請填寫有效積分）","Request {count} selected items on AbleSci (enter valid points)"],
    ["为所选文献发起科研通求助（每篇 {points} 积分）","為所選文獻發起科研通求助（每篇 {points} 積分）","Request selected items on AbleSci ({points} points each)"],
    ["为所选文献发起科研通求助（请填写有效积分）","為所選文獻發起科研通求助（請填寫有效積分）","Request selected items on AbleSci (enter valid points)"],
    ["未选择文献","未選擇文獻","No items selected"],
    ["已选 {count} 篇","已選 {count} 篇","{count} items selected"],
    ["本次悬赏合计 {points} 积分","本次懸賞合計 {points} 積分","Total reward: {points} points"],
    ["请填写 1–10000 的整数积分","請填寫 1–10000 的整數積分","Enter a whole number of points from 1 to 10000"],
    ["仅选择有 DOI、尚未获取全文且没有关联求助的任务。切换筛选会清除选择；本次求助和未发布任务的重试按按钮所示的当前默认积分，已有求助保持发布时积分。","僅選擇有 DOI、尚未取得全文且沒有關聯求助的任務。切換篩選會清除選擇；本次求助和未發布任務的重試按按鈕所示的當前預設積分，已有求助保持發布時積分。","Select tasks that have a DOI, no saved full text, and no linked request. Changing filters clears the selection. New requests and retries of unpublished tasks use the current points shown on the button; existing requests retain their published reward."],
    ["科研通求助（{points} 积分）","科研通求助（{points} 積分）","Request on AbleSci ({points} points)"],
    ["科研通求助（请填写有效积分）","科研通求助（請填寫有效積分）","Request on AbleSci (enter valid points)"],
    ["{points} 积分","{points} 積分","{points} points"],
    ["请填写有效积分","請填寫有效積分","Enter valid points"],
    ["悬赏 {points} 积分","懸賞 {points} 積分","Reward: {points} points"],
    ["按 {budget}重试","按 {budget}重試","Retry with {budget}"],
    ["补全 DOI 后可求助","補全 DOI 後可求助","Add a DOI to request assistance"],
    ["请先在原文献条目补全 DOI","請先在原文獻條目補全 DOI","Add the DOI to the original library item first"],
    ["选择文献：{title}","選擇文獻：{title}","Select item: {title}"],
    ["未命名文献","未命名文獻","Untitled item"],
    ["关联已有求助","關聯已有求助","Link an existing request"],
    ["自己的科研通求助详情页链接","自己的科研通求助詳情頁連結","URL of your AbleSci request details"],
    ["关联文献","關聯文獻","Link a library item"],
    ["只跟踪，不关联文献","只跟蹤，不關聯文獻","Track only, without linking an item"],
    ["只跟踪不会保存附件到文库；需要入库时，请明确选择对应文献。可选文献来自上方尚未关联求助的任务。","只跟蹤不會儲存附件到文庫；需要入庫時，請明確選擇對應文獻。可選文獻來自上方尚未關聯求助的任務。","Tracking alone does not save attachments to your library. To save a file, explicitly select its library item. The choices are tasks above without an existing request link."],
    ["添加","添加","Add"],
    ["选择保存全文的文献","選擇儲存全文的文獻","Choose the item to receive the full text"],
    ["请选择文献（不自动关联）","請選擇文獻（不自動關聯）","Choose an item (no automatic link)"],
    ["请核对标题和 DOI。只有确认关联后，全文才能保存到这篇文献。","請核對標題和 DOI。只有確認關聯後，全文才能儲存到這篇文獻。","Check the title and DOI. Full text can be saved to this item only after you confirm the link."],
    ["没有找到 DOI 相同且可写入附件的文献。请先在 Zotero 文库添加对应文献并补全 DOI，再重新打开关联选择。","沒有找到 DOI 相同且可寫入附件的文獻。請先在 Zotero 文庫添加對應文獻並補全 DOI，再重新打開關聯選擇。","No item with the same DOI and permission to save attachments was found. Add the matching item and DOI in Zotero, then reopen this selection."],
    ["确认关联","確認關聯","Confirm link"],
    ["取消","取消","Cancel"],
    ["请选择要保存全文的文献并确认关联。","請選擇要儲存全文的文獻並確認關聯。","Choose the item to receive the full text, then confirm the link."],
    ["文献已关联，下载进度见任务列表。","文獻已關聯，下載進度見任務列表。","Item linked. See the task list for download progress."],
    ["文献已关联，可点击“下载到文库”。","文獻已關聯，可點選“下載到文庫”。","Item linked. You can now click “Download to library”."],
    ["已将已有求助关联到所选文献，未发布新求助。","已將已有求助關聯到所選文獻，未發布新求助。","The existing request was linked to the selected item. No new request was published."],
    ["已添加求助跟踪，未关联文献，也未发布新求助。","已添加求助跟蹤，未關聯文獻，也未發布新求助。","Request tracking added without linking an item or publishing a new request."],
    ["应助文件已就绪，但此任务仅跟踪求助，尚未关联 Zotero 文献。请先关联文献，才能下载到文库。","應助檔案已就緒，但此任務僅跟蹤求助，尚未關聯 Zotero 文獻。請先關聯文獻，才能下載到文庫。","A response file is ready, but this task only tracks the request and has no linked Zotero item. Link an item before downloading to the library."],
    ["立即检查","立即檢查","Check now"],
    ["下载到文库","下載到文庫","Download to library"],
    ["下载结果已更新。","下載結果已更新。","Download results updated."],
    ["打开全文","打開全文","Open full text"],
    ["打开网页","打開網頁","Open page"],
    ["查看已有求助","查看已有求助","View existing request"],
    ["核实采纳状态","核實採納狀態","Verify acceptance"],
    ["重试采纳与已读","重試採納與已讀","Retry acceptance and message handling"],
    ["采纳与对应消息的处理结果已更新，请查看任务状态。","採納與對應訊息的處理結果已更新，請查看任務狀態。","Acceptance and related message handling updated. Check the task status."],
    ["核验并补采纳","核驗並補採納","Verify and accept prior file"],
    ["已核验原文件，采纳与对应消息已读均已完成。","已核驗原檔案，採納與對應訊息已讀均已完成。","The original file was verified and accepted; its related message is marked read."],
    ["核验结果已更新，请查看任务提示。","核驗結果已更新，請查看任務提示。","Verification results updated. Check the task note."],
    ["PDF 已入库；仍需采纳这份应助文件并标记对应上传消息已读。","PDF 已入庫；仍需採納這份應助檔案並標記對應上傳訊息已讀。","The PDF is saved. This response file still needs acceptance and its upload message marked read."],
    ["PDF 已入库；采纳结果尚未核实，请先核实网站状态。","PDF 已入庫；採納結果尚未核實，請先核實網站狀態。","The PDF is saved. Acceptance has not been verified; check the website state first."],
    ["应助文件已采纳；仍需将这份文件对应的上传消息标记已读。","應助檔案已採納；仍需將這份檔案對應的上傳訊息標記已讀。","The response file is accepted. Its related upload message still needs to be marked read."],
    ["旧版记录可核验后补采纳：仅当网站文件与已保存 PDF 完全一致且论文身份匹配时，才采纳并处理对应消息。","舊版記錄可核驗後補採納：僅當網站檔案與已儲存 PDF 完全一致且論文身份匹配時，才採納並處理對應訊息。","A prior record can be accepted after verification. The website file must exactly match the saved PDF and the article identity before acceptance and related message handling."],
    ["浏览器下载并自动入库","瀏覽器下載並自動入庫","Download in browser and auto-import"],
    ["选择已下载的PDF","選擇已下載的PDF","Choose a downloaded PDF"],
    ["导入本地 PDF","導入本地 PDF","Import local PDF"],
    ["已取消选择文件。","已取消選擇檔案。","File selection cancelled."],
    ["请先预览所选 PDF，核对后再确认导入。","請先預覽所選 PDF，核對後再確認導入。","Preview the selected PDF, verify it, then confirm import."],
    ["本地 PDF 处理结果已更新。","本地 PDF 處理結果已更新。","Local PDF results updated."],
    ["待核对文件：{filename}","待核對檔案：{filename}","File to review: {filename}"],
    ["待关联文献：{title}","待關聯文獻：{title}","Item to link: {title}"],
    ["确认后将入库并采纳这份应助文件，结算该求助的原悬赏（{points} 积分）；随后只将对应上传消息标记已读。","確認後將入庫並採納這份應助檔案，結算該求助的原懸賞（{points} 積分）；隨後只將對應上傳訊息標記已讀。","Confirmation imports and accepts this response file, settling the original reward ({points} points), then marks only its related upload message read."],
    ["确认后将入库并采纳这份应助文件，结算该求助的原悬赏；随后只将对应上传消息标记已读。","確認後將入庫並採納這份應助檔案，結算該求助的原懸賞；隨後只將對應上傳訊息標記已讀。","Confirmation imports and accepts this response file, settling the original reward, then marks only its related upload message read."],
    ["预览待核对 PDF","預覽待核對 PDF","Preview PDF for review"],
    ["请核对 PDF 的标题、作者和 DOI，再决定是否导入。","請核對 PDF 的標題、作者和 DOI，再決定是否導入。","Check the PDF title, authors, and DOI before deciding whether to import it."],
    ["确认对应论文并入库、采纳","確認對應論文並入庫、採納","Confirm article, import and accept"],
    ["我已核对，是这篇论文","我已核對，是這篇論文","I checked: this is the correct article"],
    ["核验与入库结果已更新，采纳及对应消息状态见任务列表。","核驗與入庫結果已更新，採納及對應訊息狀態見任務列表。","Verification and import results updated. See the task list for acceptance and related message status."],
    ["PDF 已保存到原文献。","PDF 已儲存到原文獻。","The PDF was saved to the original item."],
    ["取消这次导入","取消這次導入","Cancel this import"],
    ["已取消这次应助文件导入，任务保留；未确认的文件不会因此采纳。","已取消這次應助檔案導入，任務保留；未確認的檔案不會因此採納。","Response file import cancelled. The task remains, and this unconfirmed file will not be accepted."],
    ["已取消，任务保留。可重新选择文件，或点击“浏览器下载并自动入库”重新开始检查。","已取消，任務保留。可重新選擇檔案，或點選“瀏覽器下載並自動入庫”重新開始檢查。","Cancelled; the task remains. Choose another file or click “Download in browser and auto-import” to restart checks."],
    ["暂停监控","暫停監控","Pause monitoring"],
    ["已暂停下载文件夹检查；可重新点击“浏览器下载并自动入库”恢复。","已暫停下載資料夾檢查；可重新點選“瀏覽器下載並自動入庫”恢復。","Download folder checks paused. Click “Download in browser and auto-import” again to resume."],
    ["重试","重試","Retry"],
    ["任务已恢复。","任務已恢復。","Task resumed."],
    ["暂停","暫停","Pause"],
    ["已暂停本地检查，网站上的求助仍然保留。","已暫停本地檢查，網站上的求助仍然保留。","Local checks paused. The request remains on the website."],
    ["任务已暂停。","任務已暫停。","Task paused."],
    ["出版社网页","出版社網頁","Publisher page"],
    ["开放获取","開放取得","Open access"],
    ["已有附件","已有附件","Existing attachment"],
    ["科研通","科研通","AbleSci"],
    ["本地 PDF","本地 PDF","Local PDF"],
    ["Edge 浏览器","Edge 瀏覽器","Edge browser"],
    ["浏览器下载","瀏覽器下載","Browser download"],
    ["免积分高速","免積分高速","Free high-speed route"],
    ["普通线路","普通線路","Standard route"],
    ["完成 {date}","完成 {date}","Completed {date}"],
    ["完成日期未记录","完成日期未記錄","Completion date not recorded"],
    ["来源：{source}","來源：{source}","Source: {source}"],
    ["未记录","未記錄","Not recorded"],
    ["求助 {id}","求助 {id}","Request {id}"],
    ["最近检查 {date}","最近檢查 {date}","Last checked {date}"],
    ["已开始检查下载文件夹。请在默认浏览器完成验证并点击 PDF 下载，保存到配置文件夹；明确匹配的新 PDF 会自动添加到原文献。","已開始檢查下載資料夾。請在預設瀏覽器完成驗證並點選 PDF 下載，儲存到配置資料夾；明確匹配的新 PDF 會自動添加到原文獻。","Download folder checks started. Complete verification in your default browser, download the PDF, and save it to a configured folder. A clearly matching new PDF will be added to the original item automatically."],
    ["无法自动确认所选 PDF 的论文身份。请先预览并核对标题、作者和 DOI，再明确确认。","無法自動確認所選 PDF 的論文身份。請先預覽並核對標題、作者和 DOI，再明確確認。","The selected PDF could not be identified automatically. Preview it, check the title, authors, and DOI, then explicitly confirm."],
    ["请通过默认浏览器下载全文，或发起科研通求助。","請通過預設瀏覽器下載全文，或發起科研通求助。","Download the full text in your default browser, or request it on AbleSci."],
    ["PDF 已保存到原文献，无需再次下载。可在“已获取”中打开全文。","PDF 已儲存到原文獻，無需再次下載。可在“已取得”中打開全文。","The PDF is already saved to the original item. Open it from “Retrieved”; no new download is needed."],
    ["已打开默认浏览器，但下载文件夹检查尚未启动。请先添加下载文件夹，或点击“选择已下载的PDF”导入。","已打開預設瀏覽器，但下載資料夾檢查尚未啟動。請先添加下載資料夾，或點選“選擇已下載的PDF”導入。","The default browser opened, but folder checks have not started. Add a download folder, or use “Choose a downloaded PDF” to import a file."],
    ["已在默认浏览器打开论文，并开始检查下载文件夹。请自行完成网站验证、点击 PDF 下载并保存到配置文件夹；明确匹配的新 PDF 会自动入库，插件不会代你操作浏览器。","已在預設瀏覽器打開論文，並開始檢查下載資料夾。請自行完成網站驗證、點選 PDF 下載並儲存到配置資料夾；明確匹配的新 PDF 會自動入庫，插件不會代你操作瀏覽器。","The article opened in your default browser and folder checks started. Complete verification, download the PDF, and save it to a configured folder. A clearly matching new PDF will be imported automatically. The plugin does not control your browser."],
    ["按你的下载习惯设置","按你的下載習慣設定","Configure your download workflow"],
    ["界面语言","界面語言","Interface language"],
    ["切换后立即保存并生效；其他未保存的设置、账号和链接输入会保留。","切換後立即儲存並生效；其他未儲存的設定、帳號和連結輸入會保留。","Language changes are saved and applied immediately. Other unsaved settings, account details, and link input are preserved."],
    ["界面语言已保存；其他未保存的输入保持不变。","界面語言已儲存；其他未儲存的輸入保持不變。","Interface language saved. Other unsaved input is preserved."],
    ["浏览器下载文件夹","瀏覽器下載資料夾","Browser download folders"],
    ["在默认浏览器下载 PDF 并保存到这些文件夹，明确匹配的全文会自动入库。","在預設瀏覽器下載 PDF 並儲存到這些資料夾，明確匹配的全文會自動入庫。","Save browser-downloaded PDFs to these folders. Clearly matching full text is imported automatically."],
    ["添加下载文件夹","添加下載資料夾","Add download folder"],
    ["自动检测下载目录","自動檢測下載目錄","Detect download folders"],
    ["尚未配置下载文件夹，请添加浏览器保存 PDF 的位置。","尚未配置下載資料夾，請添加瀏覽器儲存 PDF 的位置。","No download folder is configured. Add the location where your browser saves PDFs."],
    ["下载文件夹路径","下載資料夾路徑","Download folder path"],
    ["移除","移除","Remove"],
    ["下载文件夹配置未改变。","下載資料夾配置未改變。","Download folder settings were unchanged."],
    ["已移除该下载文件夹。文件夹内的文件保持不变。","已移除該下載資料夾。資料夾內的檔案保持不變。","Download folder removed from the list. Its files are unchanged."],
    ["已取消添加下载文件夹。","已取消添加下載資料夾。","Adding a download folder was cancelled."],
    ["该下载文件夹已在列表中。","該下載資料夾已在列表中。","This download folder is already listed."],
    ["已添加下载文件夹。请将浏览器下载的 PDF 保存到列表中的任一文件夹。","已添加下載資料夾。請將瀏覽器下載的 PDF 儲存到列表中的任一資料夾。","Download folder added. Save browser-downloaded PDFs to any listed folder."],
    ["发现并添加了 {count} 个新下载目录。","發現並添加了 {count} 個新下載目錄。","Found and added {count} new download folders."],
    ["未发现新的下载目录，现有配置保持不变。","未發現新的下載目錄，現有配置保持不變。","No new download folders found. Existing settings are unchanged."],
    ["已暂停 {count} 个等待下载的任务；请点击各任务的“浏览器下载并自动入库”，按新目录重新开始检查。","已暫停 {count} 個等待下載的任務；請點選各任務的“瀏覽器下載並自動入庫”，按新目錄重新開始檢查。","Paused {count} tasks awaiting downloads. Click “Download in browser and auto-import” for each task to restart checks with the new folders."],
    ["下载与文件核验规则","下載與檔案核驗規則","Download and file verification rules"],
    ["“浏览器下载并自动入库”使用平常的默认浏览器。请自行完成网站登录或验证并点击 PDF 下载，保存到上方任一文件夹；插件只检查列出的文件夹，不递归扫描子目录，将明确匹配原文献的新 PDF 自动入库，不代你操作浏览器。每次打开后最多等待 30 分钟，重启 Zotero 后需重新开始。","“瀏覽器下載並自動入庫”使用平常的預設瀏覽器。請自行完成網站登入或驗證並點選 PDF 下載，儲存到上方任一資料夾；插件只檢查列出的資料夾，不遞歸掃描子目錄，將明確匹配原文獻的新 PDF 自動入庫，不代你操作瀏覽器。每次打開後最多等待 30 分鐘，重啟 Zotero 後需重新開始。","“Download in browser and auto-import” uses your usual default browser. Complete login or verification and download the PDF to a listed folder. The plugin checks only these folders, without scanning subfolders, and imports new PDFs that clearly match the original article. It does not control your browser. Each session waits up to 30 minutes and must be restarted after Zotero restarts."],
    ["未能自动匹配时，可点击“选择已下载的PDF”。所选文件身份仍不确定时，需要先预览核对并明确确认；不匹配的文件会停止导入。未获取全文的任务始终可改用科研通求助，已有求助可直接查看。","未能自動匹配時，可點選“選擇已下載的PDF”。所選檔案身份仍不確定時，需要先預覽核對並明確確認；不匹配的檔案會停止導入。未取得全文的任務始終可改用科研通求助，已有求助可直接查看。","If automatic matching fails, use “Choose a downloaded PDF”. An unidentified file requires preview, review, and explicit confirmation; mismatched files are rejected. Tasks without full text can still use AbleSci, and existing requests remain accessible."],
    ["科研通求助与下载","科研通求助與下載","AbleSci requests and downloads"],
    ["每篇求助悬赏积分","每篇求助懸賞積分","Reward points per request"],
    ["科研通应助检查间隔（秒）","科研通應助檢查間隔（秒）","AbleSci response check interval (seconds)"],
    ["收到应助文件后，自动下载并添加到原文献","收到應助檔案後，自動下載並添加到原文獻","Automatically download response files and add them to the original item"],
    ["已核验的应助文件入库后，自动采纳并结算原悬赏；随后只将该文件对应的上传消息标记已读，不会将所有消息标为已读。无法确认论文身份时，先预览并由你明确确认。","已核驗的應助檔案入庫後，自動採納並結算原懸賞；隨後只將該檔案對應的上傳訊息標記已讀，不會將所有訊息標為已讀。無法確認論文身份時，先預覽並由你明確確認。","After a verified response file is saved, it is accepted and the original reward is settled. Only the upload message for that file is marked read. If article identity is uncertain, preview the file and explicitly confirm first."],
    ["默认悬赏 10 积分。输入后求助按钮会立即显示当前金额；点击时先保存并按按钮所示金额发起。网站最低要求超过设置值时暂停，不自动加价；修改设置不会改变已发布的求助。","預設懸賞 10 積分。輸入後求助按鈕會立即顯示當前金額；點選時先儲存並按按鈕所示金額發起。網站最低要求超過設定值時暫停，不自動加價；修改設定不會改變已發布的求助。","The default reward is 10 points. Request buttons immediately show the entered amount; clicking saves it and submits at that amount. If the website minimum exceeds your setting, submission pauses without raising the reward. Changing settings does not change published requests."],
    ["科研通下载优先使用账号当前的免积分高速权益，否则使用普通免费线路；不自动购买高速下载。","科研通下載優先使用帳號當前的免積分高速權益，否則使用普通免費線路；不自動購買高速下載。","AbleSci downloads use the account’s current free high-speed entitlement when available, otherwise the standard free route. High-speed downloads are never purchased automatically."],
    ["保存设置","儲存設定","Save settings"],
    ["设置已保存","設定已儲存","Settings saved"],
    ["设置已保存；已发布的求助未改变。","設定已儲存；已發布的求助未改變。","Settings saved. Published requests were unchanged."],
    ["有未保存的更改","有未儲存的更改","Unsaved changes"],
    ["下载设置，有未保存的更改","下載設定，有未儲存的更改","Download settings, unsaved changes"],
    ["求助积分已保存；其他设置仍有未保存的更改","求助積分已儲存；其他設定仍有未儲存的更改","Request points saved; other settings have unsaved changes"],
    ["悬赏积分必须是 1–10000 的整数。","懸賞積分必須是 1–10000 的整數。","Reward points must be a whole number from 1 to 10000."],
    ["悬赏积分已变化，请核对更新后的按钮金额再操作。","懸賞積分已變化，請核對更新後的按鈕金額再操作。","Reward points changed. Check the updated button amount before continuing."],
    ["检查间隔必须是 60–3600 秒的整数。","檢查間隔必須是 60–3600 秒的整數。","The check interval must be a whole number from 60 to 3600 seconds."],
    ["已转入科研通求助流程，进度见任务列表。","已轉入科研通求助流程，進度見任務列表。","Moved to the AbleSci request workflow. See the task list for progress."],
    ["已将 {count} 篇转入科研通求助流程。","已將 {count} 篇轉入科研通求助流程。","Moved {count} items to the AbleSci request workflow."],
    ["没有新增求助任务。","沒有新增求助任務。","No new request tasks were added."],
    ["已跳过 {count} 项，请查看当前任务状态。","已跳過 {count} 項，請查看當前任務狀態。","Skipped {count} items. Check their current task status."],
    ["进度见任务列表。","進度見任務列表。","See the task list for progress."],
    ["已登录","已登入","Signed in"],
    ["未登录","未登入","Signed out"],
    ["登录已过期","登入已過期","Login expired"],
    ["正在登录","正在登入","Signing in"],
    ["登录失败","登入失敗","Login failed"],
    ["待验证","待驗證","Unverified"],
    ["当前绑定：{account}","當前綁定：{account}","Linked account: {account}"],
    ["账号","帳號","Account"],
    ["密码","密碼","Password"],
    ["邮箱或用户名","郵箱或用戶名","Email or username"],
    ["输入密码","輸入密碼","Enter password"],
    ["已保存密码；留空使用已保存的密码","已儲存密碼；留空使用已儲存的密碼","Password saved; leave blank to reuse it"],
    ["保存并打开登录","儲存並打開登入","Save and open login"],
    ["网页登录","網頁登入","Log in on website"],
    ["退出登录","登出","Sign out"],
    ["登录后可发起求助、查看应助进度并下载文件。","登入後可發起求助、查看應助進度並下載檔案。","Sign in to submit requests, track responses, and download files."],
    ["密码保存在本机 Zotero 登录管理器中。保存后会打开科研通网页并填入账号密码，请在网页完成登录和验证。","密碼儲存在本機 Zotero 登入管理器中。儲存後會打開科研通網頁並填入帳號密碼，請在網頁完成登入和驗證。","Your password is stored in Zotero’s local login manager. Saving opens the AbleSci page and fills your credentials. Complete login and verification on that page."],
    ["请填写科研通账号。","請填寫科研通帳號。","Enter your AbleSci account."],
    ["请填写密码，或使用网页登录。","請填寫密碼，或使用網頁登入。","Enter a password, or log in on the website."],
    ["账号已保存，请在打开的科研通网页完成登录。","帳號已儲存，請在打開的科研通網頁完成登入。","Account saved. Complete login on the AbleSci page that opened."],
    ["请在科研通网页完成登录或验证。","請在科研通網頁完成登入或驗證。","Complete login or verification on the AbleSci page."],
    ["已退出插件中的科研通登录。","已退出插件中的科研通登入。","Signed out of AbleSci in the plugin."],
    ["登录未完成，请检查账号密码或使用网页登录完成验证。","登入未完成，請檢查帳號密碼或使用網頁登入完成驗證。","Login was not completed. Check your credentials or complete verification using website login."],
    ["机构登录：保存或恢复未完成，请在机构登录窗口重新登录。","機構登入：儲存或恢復未完成，請在機構登入窗口重新登入。","Institutional login could not be saved or restored. Sign in again in the institutional login window."],
    ["机构登录：正在读取登录保存状态…","機構登入：正在讀取登入儲存狀態…","Institutional login: reading saved session status…"],
    ["机构登录：已在本机加密保存（{date}）。网站会话过期后需重新登录。","機構登入：已在本機加密儲存（{date}）。網站會話過期後需重新登入。","Institutional login: encrypted locally ({date}). Sign in again when the website session expires."],
    ["机构登录：已在本机加密保存。网站会话过期后需重新登录。","機構登入：已在本機加密儲存。網站會話過期後需重新登入。","Institutional login: encrypted locally. Sign in again when the website session expires."],
    ["机构登录：已启用保存。网站会话过期后需重新登录。","機構登入：已啟用儲存。網站會話過期後需重新登入。","Institutional login: saving enabled. Sign in again when the website session expires."],
    ["机构登录：尚未保存。可在专用窗口保留“记住此窗口的机构登录”并完成登录。","機構登入：尚未儲存。可在專用窗口保留“記住此窗口的機構登入”並完成登入。","Institutional login: not saved yet. Keep “Remember institutional login in this window” enabled and complete login in the dedicated window."],
    ["尚未刷新","尚未刷新","Not refreshed yet"],
    ["刷新消息","刷新訊息","Refresh messages"],
    ["登录后可查看科研通应助提醒。","登入後可查看科研通應助提醒。","Sign in to view AbleSci response notifications."],
    ["暂无消息。","暫無訊息。","No messages."],
    ["尚未读取科研通消息。","尚未讀取科研通訊息。","AbleSci messages have not been loaded yet."],
    ["最近刷新 {date}","最近刷新 {date}","Last refreshed {date}"],
    ["正在刷新消息…","正在刷新訊息…","Refreshing messages…"],
    ["消息刷新未完成，请稍后再试。","訊息刷新未完成，請稍後再試。","Messages could not be refreshed. Try again later."],
    ["科研通消息","科研通訊息","AbleSci message"],
    ["查看","查看","View"],
    ["消息已刷新。","訊息已刷新。","Messages refreshed."],
    ["正在处理…","正在處理…","Working…"],
    ["已更新。","已更新。","Updated."],
    ["操作未完成，请稍后再试。","操作未完成，請稍後再試。","The action was not completed. Try again later."],
    ["请填写自己的科研通求助详情页链接。","請填寫自己的科研通求助詳情頁連結。","Enter the details URL of your own AbleSci request."],
    ["科研通 · 全文助手内置窗口","科研通 · 全文助手內置窗口","AbleSci · Full Text Assistant window"],
    ["正在打开…","正在打開…","Opening…"],
    ["完成登录","完成登入","Finish login"],
    ["在科研通网页完成登录或验证码。登录成功后会自动绑定，重启 Zotero 后保留会话。","在科研通網頁完成登入或驗證碼。登入成功後會自動綁定，重啟 Zotero 後保留會話。","Complete login or CAPTCHA on the AbleSci page. Successful login links the account automatically and preserves the session after Zotero restarts."],
    ["已绑定科研通账号，登录状态已保存。","已綁定科研通帳號，登入狀態已儲存。","AbleSci account linked; login session saved."],
    ["尚未登录成功，请在下方网页完成登录。","尚未登入成功，請在下方網頁完成登入。","Not signed in yet. Complete login on the page below."],
    ["刷新任务状态","刷新任務狀態","Refresh task status"],
    ["已填入保存的账号密码。请在网页完成验证码并点击登录。","已填入儲存的帳號密碼。請在網頁完成驗證碼並點選登入。","Saved credentials filled in. Complete the CAPTCHA and click login on the page."],
    ["任务状态已更新，可在 Zotero 设置 → 全文助手中查看。","任務狀態已更新，可在 Zotero 設定 → 全文助手中查看。","Task status updated. View it in Zotero Settings → Full Text Assistant."],
    ["出版社与机构登录","出版社與機構登入","Publisher and institutional login"],
    ["出版社与机构登录 · 全文助手","出版社與機構登入 · 全文助手","Publisher and institutional login · Full Text Assistant"],
    ["{title} · 全文助手","{title} · 全文助手","{title} · Full Text Assistant"],
    ["后退","後退","Back"],
    ["前进","前進","Forward"],
    ["刷新","刷新","Reload"],
    ["当前网页地址","當前網頁地址","Current page URL"],
    ["返回论文","返回論文","Back to article"],
    ["完成登录并重试此文献","完成登入並重試此文獻","Finish login and retry this item"],
    ["请在下方网页完成出版社或机构登录。认证页面和弹窗都留在此窗口；登录后点击右上方重试。","請在下方網頁完成出版社或機構登入。認證頁面和彈窗都留在此窗口；登入後點選右上方重試。","Complete publisher or institutional login below. Authentication pages and popups stay in this window. After login, click retry at the top right."],
    ["记住此窗口的机构登录（加密）","記住此窗口的機構登入（加密）","Remember institutional login in this window (encrypted)"],
    ["点击“完成登录并重试”时，仅为本窗口经过的站点保存会话，供同机构文献及重启后复用；网站仍决定登录有效期。站点：","點選“完成登入並重試”時，僅為本窗口經過的站點儲存會話，供同機構文獻及重啟後復用；網站仍決定登入有效期。站點：","Clicking “Finish login and retry” saves sessions only for sites visited in this window, for other articles from the same institution and after restart. Each website controls session expiry. Sites:"],
    ["等待网页加载","等待網頁加載","Waiting for page to load"],
    ["出版社及机构网页","出版社及機構網頁","Publisher and institutional pages"],
    ["机构登录","機構登入","Institutional login"],
    ["关闭此网页","關閉此網頁","Close this page"],
    ["网页窗口已关闭。","網頁窗口已關閉。","The page window was closed."],
    ["出版社浏览器初始化超时，请关闭后重试。","出版社瀏覽器初始化超時，請關閉後重試。","Publisher browser initialization timed out. Close it and try again."],
    ["[网页地址]","[網頁地址]","[Page URL]"],
    ["网站正在进行真人验证。可点击“浏览器下载并自动入库”，在日常浏览器完成验证并点击 PDF 下载；文件保存到配置的下载文件夹后，明确匹配的新 PDF 会自动入库。插件不会代你操作验证码或下载按钮。","網站正在進行真人驗證。可點選“瀏覽器下載並自動入庫”，在日常瀏覽器完成驗證並點選 PDF 下載；檔案儲存到配置的下載資料夾後，明確匹配的新 PDF 會自動入庫。插件不會代你操作驗證碼或下載按鈕。","The website requires human verification. Click “Download in browser and auto-import”, complete verification in your usual browser, and download the PDF to a configured folder. A clearly matching new PDF will be imported automatically. The plugin does not operate CAPTCHA or download buttons."],
    ["网站正在进行真人验证。请在默认浏览器完成验证并自行下载 PDF，再添加到对应 Zotero 文献。","網站正在進行真人驗證。請在預設瀏覽器完成驗證並自行下載 PDF，再添加到對應 Zotero 文獻。","The website requires human verification. Complete it in your default browser, download the PDF, and add it to the matching Zotero item."],
    ["在默认浏览器打开","在預設瀏覽器打開","Open in default browser"],
    ["PDF 已保存到原文献，无需再次下载。请在全文助手的“已获取”中打开全文。","PDF 已儲存到原文獻，無需再次下載。請在全文助手的“已取得”中打開全文。","The PDF is already saved to the original item. Open it from “Retrieved” in Full Text Assistant; no new download is needed."],
    ["已打开默认浏览器，但下载文件夹检查尚未启动。请到全文助手设置添加下载文件夹，或下载后点击“导入本地 PDF”。","已打開預設瀏覽器，但下載資料夾檢查尚未啟動。請到全文助手設定添加下載資料夾，或下載後點選“導入本地 PDF”。","The default browser opened, but folder checks have not started. Add a download folder in Full Text Assistant settings, or download the file and click “Import local PDF”."],
    ["已打开默认浏览器，并开始检查下载文件夹。请自行完成验证、点击 PDF 下载并保存到配置文件夹；明确匹配的新 PDF 会自动入库。也可点击“导入本地 PDF”，身份不确定时需预览核对后确认。","已打開預設瀏覽器，並開始檢查下載資料夾。請自行完成驗證、點選 PDF 下載並儲存到配置資料夾；明確匹配的新 PDF 會自動入庫。也可點選“導入本地 PDF”，身份不確定時需預覽核對後確認。","The default browser opened and folder checks started. Complete verification, download the PDF, and save it to a configured folder. Clearly matching new PDFs are imported automatically. You can also use “Import local PDF”; uncertain files require preview and confirmation."],
    ["已在默认浏览器打开论文。请自行下载 PDF；此页面未关联文献，请回到对应 Zotero 条目添加附件。","已在預設瀏覽器打開論文。請自行下載 PDF；此頁面未關聯文獻，請回到對應 Zotero 條目添加附件。","The article opened in your default browser. Download the PDF yourself. This page is not linked to an item, so add the attachment to the corresponding Zotero item."],
    ["所选 PDF 需要核对。请到全文助手任务列表预览文件，核对后明确确认导入。","所選 PDF 需要核對。請到全文助手任務列表預覽檔案，核對後明確確認導入。","The selected PDF needs review. Preview it in the Full Text Assistant task list, verify it, then explicitly confirm import."],
    ["PDF 已导入原文献，请在全文助手任务列表查看结果。","PDF 已導入原文獻，請在全文助手任務列表查看結果。","The PDF was imported to the original item. See the Full Text Assistant task list for results."],
    ["已重新开始获取此文献，请在全文助手任务列表查看结果。","已重新開始取得此文獻，請在全文助手任務列表查看結果。","Retrieval restarted for this item. See the Full Text Assistant task list for results."],
    ["复制标题","複製標題","Copy title"],
    ["复制 DOI","複製 DOI","Copy DOI"],
    ["已复制","已複製","Copied"],
    ["复制失败，请重试。","複製失敗，請重試。","Copy failed. Try again."],
    ["检查已下载文件","檢查已下載檔案","Check downloaded files"],
    ["下载检查详情","下載檢查詳情","Download check details"],
    ["下载检查结果已更新，请查看任务中的检查详情。","下載檢查結果已更新，請查看任務中的檢查詳情。","Download checks updated. Open the task’s check details for results."],
    ["已检查 {scanned} 个 PDF；身份待核对 {unknown} 个，不匹配 {mismatch} 个。","已檢查 {scanned} 個 PDF；身份待核對 {unknown} 個，不匹配 {mismatch} 個。","Checked {scanned} PDFs: {unknown} need identity review, {mismatch} do not match."],
    ["预览并核对","預覽並核對","Preview and review"],
    ["这是通过机构获取","這是通過機構取得","Retrieved through my institution"],
    ["已确认机构访问方式。","已確認機構訪問方式。","Institutional access confirmed."],
    ["此论文已确认机构访问。","此論文已確認機構訪問。","Institutional access is confirmed for this article."],
    ["同一站点曾有成功记录，仅供参考；当前论文的访问权限仍需验证。","同一站點曾有成功記錄，僅供參考；當前論文的訪問權限仍需驗證。","A previous retrieval succeeded on this site. This is only a reference; access to the current article still needs verification."],
    ["此论文曾通过浏览器获取全文；尚未确认机构权限。","此論文曾通過瀏覽器取得全文；尚未確認機構權限。","This article was retrieved through a browser. Institutional access has not been confirmed."],
    ["页面提供机构登录入口；这不代表当前账号拥有此论文权限。","頁面提供機構登入入口；這不代表當前帳號擁有此論文權限。","The page offers institutional login. This does not confirm that the current account can access this article."],
    ["页面可能提供机构访问方式，当前论文的权限仍需验证。","頁面可能提供機構訪問方式，當前論文的權限仍需驗證。","The page may offer institutional access. Access to this article still needs verification."],
    ["页面提示登录；登录成功仍不代表此论文可下载。","頁面提示登入；登入成功仍不代表此論文可下載。","The page asks you to sign in. Successful login does not by itself confirm that this article can be downloaded."],
    ["页面提示访问受限，可在浏览器核对机构访问方式。","頁面提示訪問受限，可在瀏覽器核對機構訪問方式。","The page indicates restricted access. Check institutional access options in your browser."],
    ["页面要求真人验证，请在日常浏览器自行完成。","頁面要求真人驗證，請在日常瀏覽器自行完成。","The page requires human verification. Complete it in your usual browser."],
    ["自动查找未找到可用全文，可在浏览器继续核对。","自動查找未找到可用全文，可在瀏覽器繼續核對。","Automatic retrieval found no usable full text. Continue checking in your browser."],
    ["撤销机构确认","撤銷機構確認","Undo institutional confirmation"],
    ["已撤销此论文的机构访问确认。","已撤銷此論文的機構訪問確認。","Institutional access confirmation removed for this article."]
  ];
  const textMemory = new WeakMap(), attributeMemory = new WeakMap();
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const normalizeLanguage = value => ["zh-CN", "zh-TW", "en"].includes(value) ? value : "zh-CN";
  const fill = (value, params) => String(value).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, key) => own(params || {}, key) ? String(params[key]) : whole);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let backendRef, exact = new Map(), patterns = [];
  function rebuild() {
    const backend = scope.FulltextI18nBackendData;
    if (exact.size && backendRef === backend) return;
    backendRef = backend;exact = new Map();patterns = [];
    for (const row of [...rows, ...(Array.isArray(backend) ? backend : [])]) {
      if (!Array.isArray(row) || row.length < 3 || row.some(value => typeof value !== "string")) continue;
      exact.set(row[0], row);
    }
    for (const row of exact.values()) {
      const names = [], pieces = [];let cursor = 0;
      for (const match of row[0].matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
        const numeric = /^(?:count|total|points|position|scanned|unknown|mismatch|mismatched|seconds|minutes|hours|min|max|minimum|maximum|added|paused|accepted|skipped|attempts|size)$/i.test(match[1]);
        pieces.push(escape(row[0].slice(cursor, match.index)), numeric ? "([0-9]+(?:\\.[0-9]+)?)" : "((?:(?! · )[\\s\\S])+?)");names.push(match[1]);cursor = match.index + match[0].length;
      }
      if (!names.length) continue;
      pieces.push(escape(row[0].slice(cursor)));
      patterns.push({ row, names, expression: new RegExp("^" + pieces.join("") + "$"), fixedLength: row[0].replace(/\{[^}]+\}/g, "").length });
    }
    patterns.sort((a, b) => b.fixedLength - a.fixedLength);
  }
  function translate(value, language = "zh-CN", parameters) {
    const source = fill(value == null ? "" : String(value), parameters), locale = normalizeLanguage(language);
    if (locale === "zh-CN" || !source) return source;
    rebuild();
    const index = locale === "zh-TW" ? 1 : 2;
    function convert(text, depth = 0) {
      if (depth > 8 || !text) return text;
      const row = exact.get(text);if (row) return row[index];
      const trimmed = text.trim();
      if (trimmed !== text) return text.slice(0, text.indexOf(trimmed)) + convert(trimmed, depth + 1) + text.slice(text.indexOf(trimmed) + trimmed.length);
      for (const pattern of patterns) {
        const match = pattern.expression.exec(text);if (!match) continue;
        const values = Object.create(null);
        pattern.names.forEach((name, position) => { values[name] = ["source", "budget", "label"].includes(name) ? convert(match[position + 1], depth + 1) : match[position + 1]; });
        return fill(pattern.row[index], values);
      }
      // Composed plugin messages contain independently translated sentences or
      // metadata parts. Captured titles, filenames, account names and IDs stay raw.
      if (text.includes(" · ")) return text.split(" · ").map(part => convert(part, depth + 1)).join(" · ");
      const sentences = text.match(/[^。！？]+[。！？]?/g);
      if (sentences?.length > 1) return sentences.map(part => convert(part, depth + 1)).join(locale === "en" ? " " : "");
      return text;
    }
    return convert(source);
  }
  function apply(root, language = "zh-CN") {
    const locale = normalizeLanguage(language);
    if (!root) return;
    function visit(node) {
      if (node.nodeType === 3) {
        const current = node.nodeValue || "", prior = textMemory.get(node);
        const source = prior && current === prior.output ? prior.source : current;
        const output = translate(source, locale);
        textMemory.set(node, { source, output });
        if (current !== output) node.nodeValue = output;
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      const name = String(node.localName || "").toLowerCase();
      if (["script", "style", "browser", "iframe", "textarea"].includes(name) || node.getAttribute?.("data-i18n-skip") === "true") return;
      if (node.nodeType === 1) {
        const memory = attributeMemory.get(node) || Object.create(null);
        for (const attribute of ["title", "aria-label", "placeholder"]) {
          if (!node.hasAttribute(attribute)) continue;
          const current = node.getAttribute(attribute), prior = memory[attribute];
          const source = prior && current === prior.output ? prior.source : current;
          const output = translate(source, locale);memory[attribute] = { source, output };
          if (current !== output) node.setAttribute(attribute, output);
        }
        attributeMemory.set(node, memory);
      }
      for (const child of node.childNodes || []) visit(child);
    }
    visit(root);
    if (root.setAttribute && root.getAttribute("lang") !== locale) root.setAttribute("lang", locale);
  }
  scope.FulltextI18n = Object.freeze({ normalizeLanguage, translate, apply, uiCatalog: Object.freeze(rows.map(row => Object.freeze(row))) });
})(typeof globalThis !== "undefined" ? globalThis : this);
