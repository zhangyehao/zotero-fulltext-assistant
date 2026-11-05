# 浏览器验证循环与连接中断：研究及修复记录

更新日期：2026-11-05，对应 0.4.1。本文记录官方源码、用户对照反馈与实际修复，完整版本测试结果见版本验收记录。浏览器启动参数与 endpoint 重连策略保持原状；未隐藏自动化标识或操作真实验证码。

## 当前证据能够说明什么

v0.4 的专用 Edge 使用 `--remote-debugging-port=0` 和独立 `--user-data-dir`。它属于可被插件控制的自动获取浏览器，不能称为与用户日常 Edge 完全相同的浏览器环境。手动完成网页验证之后能否继续，仍取决于网站是否接受该浏览器会话。

Chromium 官方源码提供了明确的两步链路：

1. `content/child/runtime_features.cc` 的 `SetRuntimeFeaturesFromCommandLine` 逻辑检测远程调试端口；当 `port == 0` 时执行 `WebRuntimeFeatures::EnableAutomationControlled(true)`。相邻注释原文：

   > Set EnableAutomationControlled if the caller passes --remote-debugging-port=0 on the command line.

2. `third_party/blink/renderer/core/frame/navigator.cc` 中 `Navigator::webdriver()` 在 `AutomationControlledEnabled()` 为真时返回 `true`。

来源：

- [Chromium：runtime_features.cc](https://raw.githubusercontent.com/chromium/chromium/main/content/child/runtime_features.cc)
- [Chromium：navigator.cc](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/frame/navigator.cc)

因此，“未加 `--enable-automation`”不能用来证明这个启动方式没有自动化标识。这里核对的是 Chromium 官方 main 分支源码；没有在用户当前 Edge 中执行读取 `navigator.webdriver` 的脚本，也没有把上游代码检查当作当前 Edge 二进制的现场测量。上述可变 main URL 的行号会随更新变化，应按函数及条件查找。

微软文档把 Edge DevTools Protocol 的远程调试接口用于检查和控制浏览器，说明了远程调试端口以及独立用户资料目录的启动方式。它没有承诺启用调试后的浏览器能通过所有网站的人机验证。

- [Microsoft：Microsoft Edge DevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)

Cloudflare 的支持范围文档明确将自动化浏览器列为不能可靠支持生产验证的环境。该说明能支持“自动获取窗口可能持续验证”的产品限制，不能单独证明某篇论文此次循环的唯一原因。

- [Cloudflare：Supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)
- [Cloudflare：Challenge solve issues](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/)

不应通过隐藏自动化标识、改指纹、改 UA、自动点击验证码或绕过验证来处理这一限制。本轮没有进行这些操作。

## v0.4 的断连记录与缺少的证据

修复前 `src/edge-host.js` 的 `send()` 在 `socket` 为空时统一抛出 `EdgeConnectionError`，文案为“专用 Edge 尚未连接，请先打开论文。”。`disconnect()` 会清空 socket、会话映射并拒绝待决命令，因此已经建立过连接、随后断开的任务也会收到这个“尚未连接”文案。当前修改保留异常类型，统一提示“专用 Edge 连接已断开，自动获取已停止。请重试，或在默认浏览器中手动下载 PDF 后导入。”。

原生 WebSocket `onStop()` 没有保留关闭状态码及详细原因。单凭任务中的这条文案，无法判断是用户关闭窗口、浏览器退出、插件生命周期切换，还是通道失败；也不能归因于 Cloudflare。

正式任务记录：两条任务分别在 `2026-11-05T05:16:46Z` 与 `2026-11-05T05:17:33Z` 进入错误状态；随后查看窗口清单时，仅剩普通 Edge，专用 Edge 已关闭。这能证明后一次观察时专用窗口不在，不能反推关闭的精确时间或原因。

用户随后确认，日常使用的 Edge 可以通过相关网页验证。这是用户提供的有效对照反馈；代理此前的普通 Edge 对照没有完成，本轮也未操作真实浏览器。日常 Edge 与独立自动获取窗口还可能在登录状态、资料目录等方面不同，因此该反馈支持提供日常浏览器交接入口，但不能把验证差异唯一归因于某一个启动参数。

获取模块的模拟测试另外复现了两个问题：验证提示暂时消失会触发重复候选下载；原文页 loader 变化也会触发重试。0.4.1 已增加跨相关页面的验证等待锁，且不会用文字消失或 loader 变化当作完成证据。此逻辑问题与 host 断连提示分别修复和验证。

## 已实施的 host 最小修复

- 已统一断连时的 `EdgeConnectionError` 提示，保留异常类型，并提供两种明确动作：重试自动获取，或在默认浏览器中手动下载后导入。无连接时的命令发送、页面列表、挂接和聚焦使用相同提示。用户关闭窗口后的轮询仍然不会自动重新启动浏览器。
- `socket.send()` 同步抛错时，已改为调用统一的 `disconnect()`：关闭旧通道，清空 socket 和会话缓存，拒绝全部待决命令。模拟测试验证了两个原有待决命令与本次发送同时失败、后续查询不自动重连，以及显式 `open()` 后可以重新建立连接且不复用旧会话缓存。

## 未扩展处理的边界

- 另外存在一个待验证的重连边界：旧 endpoint 握手失败后，host 会删除 `DevToolsActivePort` 再启动同一资料目录。如果原进程仍存活、失败只是短暂连接问题，新启动可能交给原进程，而被删的端口文件未必重建。这是代码可达的潜在风险，尚未做原生复现，不能用于解释上述两条正式任务错误。
- UI 已区分“专用 Edge 自动获取”和“默认浏览器手动下载”，不承诺人工点击后必然通过网站验证。普通浏览器交接与设置页测试单独覆盖。

## 无扩展的默认浏览器交接方案

Zotero 官方 `zotero.js` 的 `launchURL()` 对 HTTP(S) URL 使用系统默认协议处理器：`handler.preferredAction = Components.interfaces.nsIHandlerInfo.useSystemDefault`，随后调用 `launchWithURI`。这提供了打开用户默认浏览器的现成入口，不需要自己启动带调试参数的 Edge。

- [Zotero：zotero.js 中的 launchURL](https://raw.githubusercontent.com/zotero/zotero/main/chrome/content/zotero/xpcom/zotero.js)

“默认浏览器手动下载”按钮执行以下交接：先暂停该任务，等待该任务的自动获取退出，再调用 `Zotero.launchURL()` 打开已校验的 HTTP(S) 论文地址。多个任务可能共用自动获取 host，因此切换一个任务时不应销毁整个 host。原生测试的默认浏览器调用在 API 边界被记录，不把这个检查描述为真实站点下载成功。

用户在普通浏览器自行登录、验证并保存 PDF，再使用已有的本地 PDF 选择/导入功能，将文件关联到原 Zotero 条目。这条路线不安装扩展，也不读取或复制普通浏览器的 Cookie、资料目录或历史记录。

在既不安装扩展、也不控制普通浏览器的前提下，插件没有可依赖的浏览器下载完成事件和原论文身份信息。仅扫描公共下载目录不足以可靠地把新 PDF 关联给某个任务；若以后增加目录监听，仍需明确的范围及关联确认，不能把它表述为已经实现的无误自动导入。

此交接不会自动转为科研通求助。用户是否求助、采用多少积分，应继续通过已有的明确操作决定。

## 验证状态

- 已读当前 `edge-host.js`、相关 host/acquire/app 测试与官方上游源码。
- 本轮运行 `node --test tests/edge-host.test.cjs`，结果为 **18/18 通过**。包含此前的启动/退出竞争回归、当前的可操作断连提示，以及新增的同步发送失败和显式恢复场景。
- 测试使用模拟 WebSocket/文件系统，证明 host 状态处理和恢复行为，不证明真实网站会接受自动获取浏览器。本轮没有改动启动参数，没有增加隐藏自动化的设置，没有新增真实浏览器测量。
- 用户已确认日常 Edge 可通过相关验证；当前文件据实记录该反馈，不将其描述为代理完成的端到端测试。
- 获取模块、交接与界面的结果见 0.4.1 验收记录。真实 OUP 在专用 Edge 中通过验证仍未得到证实，普通浏览器手动下载不应被表述为专用 Edge 自动成功。
