# 维护者发布与更新指南

本指南从 0.8.0 起用于公开 GitHub Release。旧私有草稿政策与验收过程保存在 [历史归档](publishing-history-v0.7.x.md)，不再作为当前发行指引。发布前需有对应版本的测试、实际 XPI 验收与明确的公开发行授权；自动工作流只准备候选草稿，不会因推送标签自动公开发布。

每次升级先读 [后续更新注意事项与踩坑记录](UPDATING.md)，特别是数据兼容、Release 标签关联、候选资产替换与公开版本不可覆盖的约束。仅更新仓库文档不需要重新发布现有安装包。

## 稳定标识与支持范围

| 项目 | 值 |
| --- | --- |
| 仓库 | `zhangyehao/zotero-fulltext-assistant` |
| 插件 ID | `fulltext-assistant@local.invalid`，沿用旧版本，不能改成另一个插件 |
| 当前版本 | `0.8.0`；后续版本必须同步 manifest、package 和锁文件 |
| Zotero 安装范围 | `10.0.7`–`10.0.*` |
| 原生实测环境 | Windows / Zotero 10.0.7 |
| 更新地址 | `https://github.com/zhangyehao/zotero-fulltext-assistant/releases/latest/download/updates.json` |

插件 ID 中的 `.invalid` 是既有身份标识，并非网络地址；实际 `update_url` 必须是上表可匿名访问的 HTTPS 地址。更新源不包含个人访问令牌。0.7.x 的安装包仍保存旧占位地址，用户需要手动安装一次 0.8.0 或更新版本，之后再验证 Zotero 更新发现流程。

兼容上限不能仅为扩大插件目录覆盖而提高。macOS、Linux、其他 Zotero 主版本及 10.1+ 需要各自验证，再修改支持说明和构建检查。

## 发行资产

在干净、版本一致的源树中运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
python build.py --output dist
python scripts/release.py verify-local --directory dist
```

构建生成五份基础资产：

| 文件 | 核对内容 |
| --- | --- |
| `zotero-fulltext-assistant-<version>.xpi` | 安装包内的版本、插件 ID、更新地址和兼容范围。 |
| `zotero-fulltext-assistant-<version>-source.zip` | 当前版本源码、测试、文档和构建脚本，不含个人配置或依赖目录。 |
| `updates.json` | 同一个插件 ID；版本固定的 XPI 地址；`sha256:` 校验值；兼容范围。 |
| `SHA256SUMS` | XPI、源码 ZIP 和更新清单的完整文件哈希。 |
| `release-manifest.json` | 仓库、版本、标签、安装包名、更新地址、资产大小及哈希。 |

构建按固定文件顺序、ZIP 时间及文本换行生成可复现归档。文档和截图变化会改变源码 ZIP；业务代码或生产资产变化会改变 XPI。对外安装包必须是实际验收过的相同文件，不能只凭版本号相同认定相同。

正式源码包可包含公开验收文档和去隐私的截图，不放入 Cookie、密码、浏览器配置、Zotero 数据库、私人任务 JSON、受限 PDF、个人目录或调试日志。仓库历史、已存在 Release 资产与新文档均需检查；只检查当前工作树不够。

## 候选草稿与验收

1. 同步版本、更新说明和公开文档，运行本地检查与构建。使用候选 XPI 在隔离配置进行实际加载和必要原生检查，明确模拟接口与真实网站动作的范围。
2. 检查新用户安装、已有数据升级、任务/附件关联保留、登录恢复、目录检查与待核对流程。真实发布、采纳和积分消费必须有用户授权；不得为了凑测试数执行真实收费操作。
3. 将审查后的文件提交并推送。远端发布脚本要求工作树无未提交或未跟踪文件，标签必须对应当前 `HEAD`。推送后检查该提交的 CI；在这个精确提交上创建 `v<version>` 标签，不移动或覆盖已发布标签。
4. 推送标签会触发 **Prepare release candidate**，重新测试和构建，再创建或补齐草稿。也可从同一干净提交手动执行：

```sh
python scripts/release.py prepare --tag v0.8.0 --directory dist
python scripts/release.py verify --tag v0.8.0 --directory dist
```

`prepare` 只处理草稿并逐字节核对远端资产。相同资产可重复核实；内容不同会拒绝覆盖。确有需要且仍是未发布草稿时，才显式使用 `--replace-draft-assets`。不要对已公开版本更换文件来掩盖版本内容变化。

5. 为草稿补充完整版本说明，列出功能、已验证支持范围、测试证据和剩余限制。0.7.2 或更早的测试数量保留原版本归属，不能移写成当前版本重新执行。截图只能展示空白或合成演示数据。
6. 核对本地实际验收 XPI 的 SHA-256 与草稿 XPI 一致。补改代码后重新验收；只变更说明和源码文档时也重新生成并核对完整资产清单，避免草稿源码与标签不一致。

不要把“测试通过”“草稿已准备”“仓库已公开”“正式 Release 已发布”“插件目录已收录”混写为一个结果；每一项都应单独核实。

## 公开正式 Release

公开发行前，仓库必须公开，源码、截图与历史资产已经过隐私审查，且已获得公开发行授权。仓库可见性变化不会由构建脚本自动执行。

核对草稿、版本说明和用户可见文件后，以实际 Zotero 验收过的 XPI 哈希执行：

```sh
python scripts/release.py publish --tag v0.8.0 --directory dist --expected-sha256 <64位已验收XPI的SHA256>
```

`publish` 再次核对本地与远端资产，拒绝私有仓库，把已核对草稿发布为稳定版并设为 latest。Actions 中的 **Publish reviewed stable release** 是独立手动入口，同样需要标签与明确的验收哈希；推送标签本身只准备草稿。

发行说明可依据 [0.8.0 说明](release-v0.8.0.md) 编写，附上当前版本的实际验证结果。不要把测试中拦截的提交写成真实科研通发布，也不要把人工下载、合成 PDF、免费下载线路测试写成验证码兼容或收费结算实测。

## 发布后核实更新

1. 在无 GitHub 登录、无访问令牌的请求中取得正式 Release 的 XPI、`updates.json` 和校验文件，确认不是登录页或错误页。
2. 检查 `releases/latest/download/updates.json` 解析出的插件 ID、版本、XPI 版本固定地址、SHA-256 和 Zotero 兼容范围；下载 XPI 比较实际字节。
3. 在隔离 Zotero 配置中检查更新发现与安装。测试时明确旧安装包版本和更新地址；若为验证公开更新源而临时设置测试地址，必须记录这一条件，不能称作旧 0.7.x 原包自动发现了更新。
4. 升级后检查版本与启用状态，并确认原有任务、附件关联、配置和登录数据按验收范围保留。只有观察到实际结果，才能声称公开更新已验证。
5. 核实最新稳定版入口指向目标版本；预发布、草稿或手动改变 latest 标识都可能影响稳定更新源。若发现已发布缺陷，发布更高版本修复，不静默替换已经分发的 XPI。

Zotero 的更新清单格式以 [官方开发文档](https://www.zotero.org/support/dev/zotero_7_for_developers#update_rdf_updates_json) 为准。自动检查的时机由 Zotero 控制，用户可从插件管理器检查更新。

## 第三方目录申请

截至 2026 年 11 月 6 日，[Zotero 官方插件页](https://www.zotero.org/support/plugins) 说明已不再维护旧插件清单，官方新目录仍在规划中。因此，公开 Release 不等于进入官方插件市场。以下为社区项目，各自审核与采集结果需单独核实。

### syt2 Zotero Addons

[syt2/zotero-addons](https://github.com/syt2/zotero-addons) 是第三方市场客户端。条目应贡献到数据源 [syt2/zotero-addons-scraper](https://github.com/syt2/zotero-addons-scraper)，当前规则是在 `addons` 中增加以 `{owner}@{repo}` 命名的文件：

```text
addons/zhangyehao@zotero-fulltext-assistant
```

条目可为空；分类最多两个有效标签。按当前目录分类，本插件可使用：

```json
{"tags": ["attachment", "integration"]}
```

这不是完整插件元数据；采集器从公开仓库 Release 与 XPI 中解析相关内容。提交前重新检查 [贡献规则](https://github.com/syt2/zotero-addons-scraper/blob/master/README.md)，确认仓库和正式 XPI 可匿名访问，再按权限提交 PR 或与维护者沟通。

PR 提交、维护者合并、采集成功、市场客户端显示是独立步骤。记录申请链接与后续结果，未完成时写“已申请，待审核/采集”，不要写“已收录”。

### Zotero 中文社区插件索引

维护仓库为 [zotero-chinese/zotero-plugins](https://github.com/zotero-chinese/zotero-plugins)，用户入口为 [Zotero 中文社区插件合集](https://zotero-chinese.com/plugins)。当前 README 接受新插件 Issue / PR，并要求可用的正式发行版；若 PR 权限受限，可优先提交 Issue，提供仓库、用途、兼容范围、Release、截图与隐私说明。

有权限编辑源清单时，在 `src/plugins.ts` 按其规则加入：

```ts
{
  repo: 'zhangyehao/zotero-fulltext-assistant',
  releases: [],
  tags: ['attachment', 'integration'],
  discoverReleases: true,
}
```

不要手改生成的 `plugins.json`，也不要宣称支持未验证的 Zotero 版本。`discoverReleases` 发现正式发行版并不代表网站立即显示；源条目审核、后台采集和网站更新分别核实。规则来源为 [中文 README](https://github.com/zotero-chinese/zotero-plugins/blob/main/README-zh.md) 与 [源清单](https://github.com/zotero-chinese/zotero-plugins/blob/main/src/plugins.ts)，申请前再次核对当前要求。
