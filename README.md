# GitHub Fork Sync

部署在 **Cloudflare Workers + D1** 上的 GitHub Fork 自动同步工具。部署时创建数据库并执行迁移，之后通过中文页面管理 Token、仓库、同步间隔和管理密码。

- 支持 1–20 个 Fork，每个仓库同步默认分支或指定的一个分支。
- 使用 GitHub 官方 `merge-upstream` API，保留 Fork 自有提交；遇到冲突停止该仓库的同步，不强制推送。
- 页面支持配置检查、手动同步、暂停自动同步，以及查看最近一次运行结果。
- 配置、登录会话和运行结果保存在 D1；GitHub Token 加密保存，读取配置时不会回显。
- TypeScript + Workers 原生 API，前端为 HTML/CSS/JavaScript，无运行时 npm 依赖。

这是 **Workers 项目**，需要 D1 和 Cron，不能作为纯 Cloudflare Pages 静态站点部署。

## 部署并完成首次设置

需要 Node.js 24+、Cloudflare 账号，以及目标 Fork 的 GitHub 写权限。

```sh
npm install
npx wrangler login
npm run deploy
```

`npm run deploy` 会先运行类型检查、测试和打包检查，然后：

1. 按 [wrangler.jsonc](./wrangler.jsonc) 中的 `database_name` 查找或创建 D1 数据库。
2. 将数据库 ID 回填到配置文件，执行 [migrations/](./migrations/) 中未应用的迁移。
3. 发布 Worker，并生成缺少的 `ENCRYPTION_KEY` 和 `SETUP_TOKEN` Workers Secret。
4. 在本地交互终端显示首次设置码，以及 Worker 的访问地址。

打开 Worker 地址，输入首次设置码，创建 **12–128 个字符的管理密码**。随后在「设置」中填写 GitHub Token 和 Fork 列表，选择同步间隔，勾选「启用自动同步」并保存。先运行「检查配置」，再按需执行「同步全部」。

首次创建管理员后，默认没有 Token 或仓库，自动同步处于暂停状态。首次设置接口只允许成功一次；公开访问者必须持有部署时生成的设置码才能创建管理员。

如果终端中的设置码丢失，或首次部署通过 CI 完成，在本地交互终端运行：

```sh
npm run setup:token
```

它会替换未初始化服务的设置码。**已创建管理员后，此命令会拒绝执行，不能用来重置密码。** 设置码不会写入 CI 日志、重定向输出或本地凭据文件。GitHub Token 和管理密码后续均通过网页设置。

开发依赖版本固定在 `package.json`；首次安装后请将生成的 `package-lock.json` 一并提交。部署回填的 D1 数据库 ID 是资源标识，不是凭据，也可以提交到仓库。

## 数据和敏感信息存在哪里

| 内容 | 存储位置 | 保存方式 |
| --- | --- | --- |
| GitHub Token | D1 `app_settings` | AES-256-GCM 加密，每次保存使用随机 IV |
| 管理密码 | D1 `app_settings` | 随机盐 + PBKDF2-SHA256，100,000 次迭代，只存哈希 |
| 仓库、分支、同步间隔和开关 | D1 `app_settings` | 管理接口登录后才能读写 |
| 登录会话 | D1 `sessions` | 只存会话 Token 的 SHA-256 摘要和有效期 |
| 最近一次运行结果、同步锁 | D1 `sync_state` | 用于刷新结果和避免重叠执行 |
| 登录/设置尝试计数 | D1 `auth_attempts` | 按 IP 的哈希值和时间窗口记录 |
| 加密根密钥 | Workers Secret `ENCRYPTION_KEY` | 部署脚本随机生成，不存入 D1 |
| 首次设置码 | Workers Secret `SETUP_TOKEN` | 部署脚本随机生成，管理员创建后失去用途 |

生产凭据不会写入源码、`wrangler.jsonc`、`.env` 或 GitHub Actions 业务配置。部署脚本通过标准输入上传 Secret，不将其放入命令参数。根密钥不打印；首次设置码只在本地交互终端显示。

浏览器使用有效期为 **8 小时**的 HttpOnly / SameSite=Strict Cookie，HTTPS 下附带 Secure。应用不把凭据保存到 localStorage/sessionStorage。更改管理密码后，所有旧会话失效，需要重新登录；登录和首次设置每个 IP 每 15 分钟最多尝试 10 次。

**不要删除或随意更换 `ENCRYPTION_KEY`。** 换掉密钥后，已有 GitHub Token 无法解密，需要在页面重新保存 Token。已有管理员但 Secret 缺失时，部署脚本会停止，要求检查账号、Worker 名称和数据库绑定或恢复原密钥，不会自动用新密钥替代。

保存 Token 后输入框清空，留空表示保留原值；勾选「移除已保存的 Token」会同时暂停自动同步。页面使用配置版本号检测多个标签页同时编辑的冲突。

## GitHub Token 和仓库设置

推荐创建 [Fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)：

1. Resource owner 选择 Fork 所属的用户或组织。
2. Repository access 选择需要同步的 Fork。
3. Repository permissions 开启 **Contents: Read and write**。
4. 如果上游修改涉及 `.github/workflows/`，且 GitHub 提示权限不足，再开启 **Workflows: Read and write**。

也可以使用 Classic PAT：公共仓库使用 `public_repo`，私有仓库使用 `repo`；工作流文件按需加 `workflow`。组织 SSO/审批、分支保护和仓库规则仍由 GitHub 执行。

页面填写 **Fork 自身的 `owner/repo`**，例如 `your-name/your-fork`，不填上游地址或完整 URL。留空分支使用 Fork 的默认分支；显式分支必须已经存在。每个仓库只能出现一次。

上游由 GitHub Fork 关系确定，合入的上游分支由 `merge-upstream` API 决定。不提供任意上游分支映射、所有分支/标签同步或自动发现全部 Fork。

「检查配置」只读取 GitHub 仓库信息，确认其可访问、是 Fork、未归档且未禁用；**不验证写权限、目标分支存在性或合并冲突**。这些由真正同步时的 GitHub 响应确认。

## 定时执行和免费额度

Cloudflare Cron 每 15 分钟唤醒一次 Worker。应用读取 D1 中的配置，按选择的 **15 / 30 / 60 / 180 / 360 / 720 / 1440 分钟**间隔决定是否执行，默认间隔为 60 分钟。修改间隔或暂停任务只需在页面保存，无需重新部署。

间隔按上一次自动任务的 Cron 计划时间计算，避免几秒调度抖动导致额外跳过一轮；失败也会推迟下一次自动尝试，手动运行不重置自动任务间隔。首次启用后会在后续符合条件的 Cron 执行时开始，不保证整点或固定北京时间。Cron 有传播和调度延迟，不能当作精确计时器。

自动任务不依赖页面保持打开。手动同步时请等待结果；客户端断开后不保证请求继续执行，可以刷新最近记录或检查 GitHub 仓库确认结果。D1 中的同步锁覆盖手动任务和 Cron；异常中断后最多保留 10 分钟。

按 [D1 官方价格说明](https://developers.cloudflare.com/d1/platform/pricing/)，Free 计划包含：

| 配额 | 免费额度 |
| --- | --- |
| 读取行数 | 每天 500 万行 |
| 写入行数 | 每天 10 万行 |
| 总存储 | 5 GB |

正常个人使用只保存少量配置和一份最近报告，适合先使用免费计划。实际仍受 D1、Workers 的请求/CPU/子请求限制，以及 GitHub API 限额约束；使用付费计划时按该账号的计费规则处理，不能保证所有使用量均免费。

每个仓库最多发出两次 GitHub 请求，20 个仓库最多 40 次，另有少量 D1 操作。Free 限额以 [Workers 官方限制](https://developers.cloudflare.com/workers/platform/limits/) 为准。

## 更新部署与 GitHub Actions

后续更新代码只需：

```sh
npm run deploy
```

脚本复用数据库、只执行未应用的迁移，并保留已有密钥与页面配置。迁移失败就停止发布。若部署中途失败，可修复原因后重新运行；已经创建的数据库会按名称复用。

本项目只自动处理 `wrangler.jsonc` 的默认环境。要部署独立的第二套服务，使用独立目录并修改 Worker `name`、D1 `database_name`，将该新服务的 `database_id` 设为全零占位值。不要让两个不同密钥的 Worker 共用同一个配置数据库。

项目自带 Push/PR 检查和手动部署工作流。首次建议在本地完成部署与网页初始化，后续在 GitHub 仓库的 Settings → Secrets and variables → Actions 中设置：

| GitHub Actions Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 限定账号的发布 Token，需要 Workers Scripts 编辑、D1 编辑及相关账号读取权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

使用 Cloudflare 的 Edit Cloudflare Workers 模板创建 Token 时，补充 **Account → D1 → Edit** 权限。进入 Actions → **Deploy to Cloudflare** → Run workflow。工作流运行检查、数据库迁移和部署，不会打印首次设置码。

若在 CI 首次部署，之后在本地同一配置下登录 Cloudflare，运行 `npm run deploy` 复用数据库并回填 ID，再运行 `npm run setup:token` 完成网页初始化。

上述 Cloudflare API Token 是可选的 CI 发布凭据。业务 GitHub PAT 保存在 D1，不使用 GitHub Actions 自带的 `GITHUB_TOKEN` 同步其他 Fork。

如果从仅使用 Secrets 的旧版本升级，需要在首次页面设置中重新填写业务 Token 和仓库。旧 `GITHUB_TOKEN`、`ADMIN_TOKEN`、`SYNC_REPOS` Secret 不再读取；新服务验证正常后可从 Cloudflare 控制台删除它们。

## 本地开发与检查

仅使用测试凭据运行本地页面。PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

Bash 使用 `cp .dev.vars.example .dev.vars`。打开 `http://localhost:8787`，使用示例文件中的 `SETUP_TOKEN` 创建本地管理员。

`npm run dev` 先迁移本地 SQLite 数据库，再启动 Wrangler。数据保存在已忽略的 `.wrangler/` 中，独立于线上 D1；本地不会自动读取线上 Secret。示例密钥只用于本地，不能复制到生产。不要把生产 PAT 填进本地开发数据库；若需要访问 GitHub，使用仅授权测试 Fork 的独立 Token，并留意手动同步会真实写入该测试 Fork。

本地不自动按 Cron 计时，可主动模拟一次定时触发：

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*&format=json"
```

该开发接口不会经过管理登录；本地启用了自动同步并保存有效测试 Token 时，会执行真实同步。

```sh
npm test           # Node.js 内置测试 + SQLite，虚构凭据、模拟 GitHub/部署命令，无需安装依赖
npm run typecheck  # TypeScript 严格检查，需要先安装开发依赖
npm run check:ui   # 前端 JavaScript 语法检查
npm run check:scripts
npm run build      # Wrangler dry run，不发布
npm run check      # 运行全部检查
```

测试覆盖初始迁移、页面配置持久化、凭据加密、初始化竞争、会话失效、并发配置修改、定时频率与同步锁、GitHub 错误分类，以及部署中断/Secret 保留/CI 隐私。测试不替代实际账号权限和线上运行验证。

## HTTP API

路径相对于 Worker URL。管理接口使用登录 Cookie，不再支持旧的 Bearer ADMIN_TOKEN；跨站 Origin 被拒绝，所有 API 响应禁止缓存。

| 方法 | 路径 | 认证 | 行为 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | 进程存活检查，不验证 D1 或 GitHub |
| GET | `/api/status` | 无 | 检查部署状态，仅返回 `initialized` |
| POST | `/api/setup` | 首次设置码 | JSON：`{setupToken, password}`；创建唯一管理员并登录 |
| POST | `/api/login` | 管理密码 | JSON：`{password}`；设置会话 Cookie |
| POST | `/api/logout` | 当前 Cookie | 注销当前会话 |
| GET | `/api/config` | 登录 | 获取配置、Token 是否已设置、同步锁状态和最近运行报告 |
| PUT | `/api/config` | 登录 | 保存页面配置，可更新 Token 或管理密码 |
| POST | `/api/sync` | 登录 | 同步全部已保存仓库，或执行只读配置检查 |

`PUT /api/config` 必须包含 `revision`、`repositories`、`syncEnabled`、`intervalMinutes`。可选 `githubToken`：省略或空字符串保留，`null` 删除，新字符串覆盖；可选 `password` 更新密码。仓库项目格式：

```json
{ "repository": "your-name/your-fork", "branch": "main" }
```

`branch` 可省略。暂停状态允许零仓库；启用自动任务必须有 Token 和至少一个仓库。配置中只返回 `githubTokenConfigured`，不会返回 Token、密码哈希或加密密钥。请求体上限为 16 KiB，setup/login 为 2 KiB，sync 为 1 KiB；未知字段或无效配置直接报错。

`POST /api/sync` 接受空请求体或 `{"dryRun":true}`；省略 dryRun 或设置为 false 时真实同步。全部成功返回 200，部分失败/跳过返回 502，并保留完整逐仓库结果。

PowerShell 示例，管理密码从当前终端环境变量读取：

```powershell
$workerUrl = 'https://github-fork-sync.YOUR-SUBDOMAIN.workers.dev'
$loginBody = @{ password = $env:FORK_SYNC_PASSWORD } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$workerUrl/api/login" -ContentType 'application/json' -Body $loginBody -SessionVariable forkSyncSession
Invoke-RestMethod -Method Post -Uri "$workerUrl/api/sync" -WebSession $forkSyncSession -ContentType 'application/json' -Body '{"dryRun":true}'
Invoke-RestMethod -Method Post -Uri "$workerUrl/api/logout" -WebSession $forkSyncSession
```

常见状态码：401 未登录/密码错误；403 跨站调用；409 已初始化、设置版本冲突、配置未完成或同步锁占用；429 登录限流；400/413/415 请求格式错误；503 部署配置或数据库不可用。

## 运行记录与故障处理

最近一份检查或同步报告保存在 D1，刷新页面可查看，包括 Cron 结果。新的检查/同步覆盖上一份报告，不提供完整历史列表。报告区分 `synced`、`up_to_date`、`checked`、`failed`、`skipped`。

```sh
npm run logs
```

Cloudflare Observability 也可查看运行日志。每轮输出 `event: fork_sync` 和运行报告，包含仓库名称、上游和结果，不包含 Token 或密码；日志可见范围与保留时间由 Cloudflare 账号设置决定。任一仓库失败会让 Cron 调用也标记为失败。

| 情况 | 处理方式 |
| --- | --- |
| 页面提示未就绪 | 检查 D1 绑定、迁移以及 ENCRYPTION_KEY / SETUP_TOKEN，修复后重新部署 |
| GitHub 401 | 在页面更新过期或无效的 PAT |
| GitHub 403 | 检查 Contents/Workflows、组织授权与分支保护；rate_limited 时等待后再运行 |
| GitHub 404 | 检查 Fork 名称及 Token 权限；私有仓库无权限也可能返回 404 |
| GitHub 409 | 通常为合并冲突；在 GitHub 或本地解决后重试 |
| GitHub 422 | 检查目标分支存在性和 GitHub 返回的校验错误 |
| 仓库地址跳转 | 在页面更新仓库名称；客户端不会携带凭据自动跟随重定向 |
| 配置版本冲突 | 页面重新加载最新配置后再编辑保存 |
| 同步一直显示运行中 | 刷新查看；异常中断产生的锁最多保留 10 分钟 |
| 请求超时/网络中断 | 单次 GitHub 请求限时 10 秒，不自动重试不确定的写入；先检查记录或仓库再重试 |

## 项目结构

```text
src/
  index.ts          HTTP 和 Cron 入口
  auth.ts           首次设置、密码登录、会话与限流
  crypto.ts         Token 加密、密码哈希
  storage.ts        D1 配置存取
  service.ts        自动任务调度、同步锁和报告持久化
  config.ts         参数校验
  github.ts         GitHub API 客户端
  sync.ts           逐仓库同步与报告
  types.ts          类型定义
migrations/         D1 版本化迁移
scripts/deploy.mjs  自动建库、迁移、部署和首次设置码
public/             中文管理面板
test/               SQLite 集成测试和模拟 API/部署测试
.github/workflows/  CI 和手动部署
wrangler.jsonc      Worker、D1、静态资源与 Cron 配置
```

官方参考：[GitHub Fork 同步 API](https://docs.github.com/en/rest/branches/branches#sync-a-fork-branch-with-the-upstream-repository)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
