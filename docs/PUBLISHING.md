# 构建、私有发布与社区收录

仓库：`zhangyehao/zotero-fulltext-assistant`，当前版本 **0.2.1**。仓库保持 **private**，未提交社区市场收录。0.2.1 修复暂停任务“立即检查”无响应和只跟踪求助任务标题刷新。已完成的实站验证与尚待验收环节见 [README](../README.md#已完成的实站验证)；构建或创建 Release 不会扩大实际验证范围。收录机制于 **2026-11-04** 根据下方项目仓库 README 与源文件核对，提交前应再次检查其贡献要求。

## 当前私有开发流程

1. 更新并核对 `manifest.json`、`package.json` 和锁文件中的版本；稳定保留插件 ID，不要为每次版本变更 ID。
2. 本地运行 `npm ci --ignore-scripts`、`npm test`、`python build.py --output dist`。构建会输出 XPI、源码包与 SHA-256。
3. 把审查过的修改推送至 `main`，查看 **CI** 工作流。该工作流只生成 Actions 构建产物，不创建 GitHub Release。
4. 需要发布候选版本时，在已验证的提交创建 `v<manifest version>` 标签并推送。**Prepare release draft** 会再次测试和构建，创建带 XPI 与源码包的 **draft prerelease**。
5. 在 GitHub Release 草稿检查附件和说明，写清真实验证范围及当前限制，再决定是否发布。仓库保持私有时，已发布的 Release 仍只对有仓库访问权的人可用。

标签例子仅用于说明，执行前应使用真实待发布版本：

```sh
git tag v0.2.1
git push origin v0.2.1
```

标签工作流会拒绝标签、清单和 package 版本不一致的构建。工作流不更改仓库可见性、不提交外部收录、不部署更新源。重复使用已存在的 Release 标签会由 GitHub CLI 拒绝创建，应检查原草稿，避免覆盖已审查的发布内容。

仓库当前没有配置公众可用的自动更新源。私有仓库的 Release 和 raw 文件需要授权；普通 Zotero 安装不能凭一个私有 GitHub URL 匿名获得它们，第三方市场的公共采集器也不能读取此仓库。不要在 XPI 或更新 URL 中存放个人访问令牌。继续私有测试时，向有访问权的协作者提供 XPI，使用手动安装更新。

## 进入公众发行前需要完成的工作

当前已实测 Windows / Zotero 10.0.7 上的 PLOS PDF 导入与去重、科研通登录跨重启恢复、20 条站内消息读取且未读数不变、已有应助 PDF 免费下载与正确关联。Nature `10.1038/nn.4346` 也已在专用窗口完成 CSTCloud 登录后取得 4472300 字节真实 PDF，文件校验、正确父条目关联和去重全部通过。新求助的元数据/最低积分/创建前检查已实测，但最终创建请求被测试拦截，没有发送或扣分。

0.2.1 XPI 已在隔离配置中实际加载，并由 `jar:file:` 加载路径确认使用安装包。重启 Zotero 后科研通认证恢复，原生验收 25/25 通过，涵盖停用/启用、菜单与设置入口唯一、任务/设置/认证恢复和机构窗口 9 项检查（包括销毁关闭）；停用/启用前后认证均为有效。Nature 与 PLOS 新建测试条目在重启后再次成功下载是此前 0.2.0 的实测记录，未作为本次 0.2.1 原生验收的重跑项目。

正式配置中，已通过插件管理器依次完成 0.1.0 → 0.2.0 → 0.2.1 升级；原生插件管理器和设置页均显示 0.2.1，插件启用状态有效，已安装 XPI 的 SHA-256 与验收候选一致。科研通保持已登录，站内信刷新入口正常。对已有、未关联文献的求助任务实际执行“暂停 → 立即检查”，持久化状态和界面从“已暂停”恢复为“文件可下载”，检查时间同步更新；未创建新求助、产生收费或导入文库。首次使用仍由用户在自己的 Zotero 中登录，网站决定会话有效期，不能承诺永久登录。

公众发行说明应保留这些具体范围，明确 **真实新求助的最终创建 POST 未执行**，发布后等待新应助的完整链路尚待验收。出版社与机构登录专用窗口让常规跨域与弹出页保留内部，并提供“完成登录并重试此文献”；CSTCloud/Nature 这一例端到端已验证，其他机构与出版社仍需分别验证。

0.2.1 本地完整测试集共 126 项及设置页 DOM 检查通过，其中应用层 49 项、科研通适配 35 项。0.2.1 实际安装包的 25/25 原生验收已通过。GitHub Actions 会对推送版本执行同套测试与构建，具体结果见仓库 Actions。发布说明还应保留默认 10 积分可调、仅失败项兜底、临时网络错误退避重试、单一求助不能绑定两篇文献等行为说明。新增支持范围和兼容版本应另行验证；测试夹具通过不能代替真实网站结果。

准备公众发行时，再明确选择把本仓库公开，或建立只分发安装包的公共仓库/网站。当前文档不会自动执行任何公开操作。公开下载地址必须能匿名取得 XPI，版本与安装包内清单一致；提供 README、许可证、兼容范围、问题反馈入口和清晰的限制说明。

Zotero 自身的自动更新与第三方市场收录是两项独立工作。公开后如需自动更新，应按照 [Zotero 官方插件开发文档](https://www.zotero.org/support/dev/zotero_7_for_developers) 配置有效的 `update_url` 与更新清单，保持原插件 ID，并实际验证旧版升级到新版。当前 `.invalid` 占位地址不能用于自动更新。

## syt2 的 Zotero Addons 市场

[syt2/zotero-addons](https://github.com/syt2/zotero-addons) 是第三方插件市场客户端。其 **addon-scraper** 数据源来自 [syt2/zotero-addons-scraper](https://github.com/syt2/zotero-addons-scraper)，新插件条目应在后者贡献，而不是直接修改市场客户端。

当前贡献机制为：fork scraper 仓库，在 `addons` 目录新增以 `{owner}@{repo}` 命名的文件，再提交 PR。此插件未来对应文件名为：

```text
addons/zhangyehao@zotero-fulltext-assistant
```

文件可为空；如需分类，可写最多两个有效标签。本插件可考虑：

```json
{"tags": ["attachment", "integration"]}
```

这不是插件完整元数据文件；名称、描述、版本和兼容范围由采集器从仓库发行版与 XPI 中读取。不要根据旧示例自行填入未验证的 `repo`、`desc`、`mirrors` 字段。

合并后，scraper 的工作流采集发行版并向 `publish` 分支及其最新 Release 输出插件索引。市场显示还取决于采集成功、有效 XPI、兼容范围及客户端选用的数据源。只有私有仓库或仅有未发布草稿时，不应宣称已经可以被公众市场安装。

参考：[scraper README](https://github.com/syt2/zotero-addons-scraper/blob/master/README.md)、[addons 目录](https://github.com/syt2/zotero-addons-scraper/tree/master/addons)。本次没有创建收录文件到外部仓库，也没有提交 PR。

## Zotero 中文社区插件索引

维护仓库为 [zotero-chinese/zotero-plugins](https://github.com/zotero-chinese/zotero-plugins)，网站入口为 [Zotero 中文社区插件合集](https://zotero-chinese.com/plugins)。其当前 README 已恢复新插件投稿，可提交 Issue 说明仓库、用途和发行下载地址，或在 `src/plugins.ts` 中按仓库名排序新增条目后发 PR。

当前源数据形式如下，**不是直接编辑生成的 `plugins.json`**：

```ts
{
  repo: 'zhangyehao/zotero-fulltext-assistant',
  releases: [],
  tags: ['attachment', 'integration'],
  discoverReleases: true,
}
```

`discoverReleases: true` 用于发现最近发行版中的最新正式版。需要保留旧 Zotero 版本时，在 `releases` 中维护已验证的历史标签与附件选择器；不能凭想当然填写兼容版本。

该仓库还会定时从 syt2 清单同步源数据并创建 PR，但同步不是自动审核合并。当前 README 描述了逐步恢复独立采集的 `shadow` / `primary` 流程：`shadow` 会生成候选数据和差异报告，对外索引仍可能沿用外部 scraper；网站何时切换独立数据源另行控制。因此，源条目合并、采集成功和网站实际展示应分别核实。

参考：[中文 README](https://github.com/zotero-chinese/zotero-plugins/blob/main/README-zh.md)、[源清单 src/plugins.ts](https://github.com/zotero-chinese/zotero-plugins/blob/main/src/plugins.ts)。当前仓库仍为私有，本文准备将来的收录路径，不表示已被任何市场收录。
