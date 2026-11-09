# 全文来源与 API 配置（0.9.0）

在 Zotero 设置的“全文助手 → 设置”中集中配置。来源设置和 API 密钥分别保存；密钥只由本机 Zotero 登录管理器保存，不会回显到设置页或写入任务历史。

## 获取顺序与成功标准

1. 批量预检：已经有可用本地 PDF 的文献直接跳过，不创建新任务。
2. Zotero 开放获取解析器：优先使用它提供的开放 PDF 或页面地址。
3. 启用的 OpenAlex、PMC / Europe PMC、CORE、Semantic Scholar 以及自定义 DOI 来源：并行进行有时限的发现，再按候选顺序下载。优先直接 PDF 与可核实的托管内容。
4. 前面的候选未成功时，尝试条目网页、DOI 跳转及 Zotero 内有效的出版社/机构会话。
5. 自动获取仍未成功，保留默认浏览器下载与科研通兜底。普通“批量获取全文”不自动发布科研通求助；只有明确授权的兜底任务可以进入求助流程。

所有新来源和出版社自动下载都经过文件格式、完整性和本机 PDF 身份核对。DOI 或可靠标题冲突的文件被拒绝；证据不足时只保留一个待确认 PDF，支持重启后预览和明确确认，不直接转为付积分求助。API 返回链接、HTTP 200 或下载到 `%PDF` 文件均不单独构成“已获取”；附件保存成功才算完成。

“来源检查详情”保留本次来源诊断，区分未配置 key、来源限流、超时、版本筛除、文件不匹配、人工验证和下载失败。它不保存密钥、响应正文或 Cookie。

## 各来源的实际能力

| 来源 | 插件如何使用 | 限制与配置 |
| --- | --- | --- |
| Zotero OA | 调用 Zotero 自带的开放获取解析器，再核对候选文件 | 接口和覆盖范围由 Zotero 提供；不是一套额外的付费订阅 |
| OpenAlex | 查询开放位置；单独启用后使用 `has_content.pdf` / `content_urls.pdf` 指明的缓存 PDF | 缓存内容需要 key 和明确的下载额度授权；元数据命中不等于缓存 PDF 存在 |
| PMC / Europe PMC | DOI/PMCID 转换、Europe PMC 开放全文位置、PMC 当前公开 Article Datasets 元数据所指向的 PDF | 仅处理服务实际提供的文件，不拼猜 PDF 地址；有些记录只有 XML 或网页 |
| CORE | 查询 DOI 对应记录并检查返回的下载地址；必要时使用已配置 key | 允许先尝试匿名查询；访问限制、配额和许可由 CORE 决定，不能承诺匿名一定可用或 key 解锁全部论文 |
| Semantic Scholar | Graph API 的 `openAccessPdf` 作为候选链接 | 主要是外部 PDF 地址，不是统一 PDF 镜像；匿名请求会限速，配置 key 也不授予出版社订阅 |
| 自定义 DOI 网址 | 把 DOI 填入用户指定模板，匿名读取 PDF 或页面中的 PDF 元数据、iframe/embed/object 和下载链接 | 默认关闭、模板为空；网站失效、登录或真人验证仍会使此路径失败 |

OpenAlex 与 Zotero OA 可能返回相同开放位置，不把重复来源当成新增覆盖。未接入出版社专用的订阅/TDM API。

## 版本偏好

- 默认“允许作者接受稿”：接受已识别的正式出版版与作者接受稿，排除明确的预印本。
- “优先出版版”：只保留已识别的正式出版版，以及来源未说明版本的候选。
- “允许预印本”：也允许明确的预印本。

未知版本不会被推断成正式版，完成记录显示“版本未核实”。无论是哪种版本，都需核对目标论文身份。当前选择控制明确标注版本的候选筛选，不是对文件出版版本的绝对保证。

## OpenAlex 下载额度

配置 key 后仍须另行启用“允许使用 OpenAlex 内容下载额度”。默认关闭，本机每日上限默认 100 次，范围 1–1000。

计数按 UTC 日期和 key 哈希保存在本机，下载前先原子预留一次；失败、取消和超时也计入，防止重试重复消耗而不记账。跳转到实际文件不另预留一次。重启继续读取；计数文件损坏或无法写入时停止缓存内容下载，其他来源仍可尝试。

**本机上限不等于账户免费额度或余额。** 同一个 key 可被其他应用使用，OpenAlex 的实际收费、免费额度及配额以其账户和官方政策为准。插件不承诺启用后绝不会消耗账户付费余额。没有必要为了安装插件先购买 CORE 或 Semantic Scholar 服务。

## 自定义模板

示例：

```text
https://repository.example.org/article/{doi};https://another.example.org/find?doi={doi}
```

最多 8 个，分号或换行分隔。DOI 按 URL 参数编码替换，模板的路径或查询参数必须包含 `{doi}`，只允许公开 HTTPS 地址；只放在 `#` 片段中的占位符无效。禁止凭据、密钥参数、本地/私有地址及把 DOI 放入主机名。填写模板后还需启用该来源并保存。

没有内置或默认启用镜像站列表，也不会声称用户填写的域名全部在线。自定义请求不带科研通、机构或浏览器 Cookie，不注入 API key，不执行页面脚本，不自动处理真人验证。下载和每次跳转均重新检查 URL 与 DNS；这不是对第三方网站安全、服务持续性或访问权的保证。

## 官方依据与接口变动

接口核对日期：2026-11-09。后续维护应重新核实，而不是继续使用本文日期的配额数字或旧接口。

- [OpenAlex 认证](https://developers.openalex.org/guides/authentication) 与 [内容下载](https://developers.openalex.org/guides/content)。密钥通过限定端点的认证头发送，不放进 URL。
- [PMC 旧 OA Web Service](https://pmc.ncbi.nlm.nih.gov/tools/oa-service/) 已于 2026-08-25 停用；本版使用 [当前公开数据集说明](https://pmc-oa-opendata.s3.amazonaws.com/README.txt)。
- [Europe PMC Web Services](https://www.ebi.ac.uk/europepmc/webservices/rest/)。
- [CORE API](https://core.ac.uk/services/api) 与 [接口文档](https://core.ac.uk/documentation/api)。
- [Semantic Scholar API 产品页](https://www.semanticscholar.org/product/api) 与 [Graph 文档](https://api.semanticscholar.org/api-docs/graph)。

真实与模拟验收范围见 [0.9.0 验收记录](verification-v0.9.0.md)。
