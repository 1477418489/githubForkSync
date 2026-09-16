# GitHub Fork Sync

部署在 **Cloudflare Workers + D1** 上的 GitHub Fork 自动同步工具。部署时创建数据库并执行迁移，之后通过中文页面管理 Token、仓库、同步间隔和管理密码。

- 支持 1–20 个 Fork，每个仓库同步默认分支或指定的一个分支。
- 使用 GitHub 官方 `merge-upstream` API，保留 Fork 自有提交；遇到冲突停止该仓库的同步，不强制推送。
- 页面支持配置检查、手动同步、暂停自动同步，保留最近 20 条运行记录并显示预计下次自动同步时间。
- 配置、登录会话和运行结果保存在 D1；GitHub Token 加密保存，读取配置时不会回显。
- TypeScript + Workers 原生 API，前端为 HTML/CSS/JavaScript，无运行时 npm 依赖。

这是 **Workers 项目**，需要 D1 和 Cron，不能作为纯 Cloudflare Pages 静态站点部署。

## 部署到 Cloudflare

推荐直接使用 Cloudflare 原生的 [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) 关联 GitHub。它会在代码提交后自动检查、迁移数据库并发布 Worker；首次设置码会明确显示在部署日志中，不需要 GitHub Actions 工作流。

### 直接从 GitHub 首次部署

1. 将本项目 Fork 或保存到你有管理权限的 GitHub 仓库。
2. 按下文 [创建 Workers Builds 发布凭据](#5-创建-workers-builds-发布凭据) 创建 Cloudflare Token，包含 Workers Scripts 编辑、账号读取及 **Account → D1 → Edit** 权限。
3. 在 Cloudflare 的 **Workers & Pages → Create application → Import a repository** 中授权并选择仓库，将 Worker 名称设置为 **`github-fork-sync`**。
4. 按下文 [构建配置表](#6-关联-github启用自动部署) 填写：生产分支 `main`、根目录留空、**Build command 留空**、**Deploy command 填 `npm run deploy`**，选择第 2 步创建的 Token，设置 `NODE_VERSION=24`。
5. 点击 **Save and Deploy**，等待发布成功。在该次部署日志中查找 **首次设置码（SETUP_TOKEN）**，复制标题下一行的完整 64 位设置码：

   ```text
   ========== 首次设置码（SETUP_TOKEN） ==========
   <本次生成的 64 位设置码>
   请在管理页面输入以上设置码，创建管理员密码。
   旧设置码已失效；创建管理员后，此码也会失效。
   ==============================================
   ```

6. 打开日志中的 `https://github-fork-sync.你的子域名.workers.dev`，用设置码创建管理密码，按下文 [网页初始化步骤](#3-在网页完成初始化和同步配置) 添加 GitHub Token、仓库和同步间隔。

尚未创建管理员时，每次成功执行 `npm run deploy` 都会生成并显示新设置码，旧码立即失效；使用**最近一次成功部署日志**中的码。创建管理员后，后续部署保留配置和加密密钥，不再签发设置码。

如果旧版日志只提示“请在本地终端运行 npm run setup:token”，将更新后的代码推送到已关联的分支并重新部署即可。脚本会复用 D1 和原加密密钥，重新签发并显示设置码。

也可以按下面的步骤在本地首次部署，再关联 GitHub 自动更新。

### 1. 准备账号和项目代码

需要 Cloudflare 账号、Node.js 24+、Git，以及目标 Fork 的 GitHub 写权限。第一次使用 Cloudflare Workers 时，先在控制台的 **Workers & Pages** 页面完成 `workers.dev` 子域名设置，后续通过该域名访问应用。

将本项目 Fork 或保存到你有管理权限的 GitHub 仓库，后续需要授权 Cloudflare 访问这个仓库。如果还没有本地代码，执行以下命令；将 `YOUR-GITHUB-NAME` 替换为保存本项目的 GitHub 用户名或组织名：

```sh
git clone https://github.com/YOUR-GITHUB-NAME/githubForkSync.git
cd githubForkSync
```

已经有本地代码时，直接进入项目根目录。下面的 npm 和 Git 命令均在该目录执行。

### 2. 安装依赖并完成首次发布

在本地交互终端执行，Windows 可以使用 PowerShell：

```sh
node --version
npm install
npx wrangler login
npx wrangler whoami
```

确认 Node.js 版本不低于 24。`wrangler login` 会打开浏览器，登录 Cloudflare 并授权；`wrangler whoami` 用于确认账号。若登录身份可访问多个 Cloudflare 账号，需要指定部署目标；PowerShell 示例：

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "你的 Cloudflare Account ID"
```

Account ID 可以在 Cloudflare 控制台查看；单一账号通常无需设置此环境变量。

[wrangler.jsonc](./wrangler.jsonc) 默认将 Worker 和 D1 数据库都命名为 `github-fork-sync`，数据库绑定名为 `DB`。首次部署保留全零的 `database_id` 占位值，脚本会自动创建或复用同名数据库并回填 ID。

```sh
npm run deploy
```

该命令先运行类型检查、测试和打包检查，然后：

1. 按 `database_name` 查找或创建 D1 数据库，将 ID 回填到 `wrangler.jsonc`。
2. 执行 [migrations/](./migrations/) 中未应用的数据库迁移。
3. 发布 Worker，包含管理页面、HTTP API 和 Cron 定时任务。
4. 在未初始化且缺少 `ENCRYPTION_KEY` 时生成加密密钥；未初始化的服务每次部署都会重新签发 `SETUP_TOKEN`，已有加密密钥会保留。

成功后，终端会显示 Worker 的访问地址，例如 `https://github-fork-sync.YOUR-SUBDOMAIN.workers.dev`。未初始化服务的设置码会以 **首次设置码（SETUP_TOKEN）** 为标题单独显示；Cloudflare 构建日志、其他 CI 和非交互终端也会输出该码。

### 3. 在网页完成初始化和同步配置

1. 打开终端给出的 Worker 地址，输入首次设置码，创建 **12–128 个字符的管理密码**。
2. 创建 [GitHub Fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)：Resource owner 选择 Fork 所属账号，Repository access 选择需要同步的 Fork，开启 **Contents → Read and write**。需要更新工作流文件时，还需授予 **Workflows → Read and write**；更多说明见 [GitHub Token 和仓库设置](#github-token-和仓库设置)。
3. 在应用「设置」页面填写 GitHub Token 和 Fork 自身的 `owner/repo`，例如 `your-name/your-fork`。分支留空表示使用默认分支；指定分支时，该分支必须已经存在。
4. 选择同步间隔，勾选「启用自动同步」并保存。首次创建管理员后默认没有 Token 或仓库，自动同步处于暂停状态。
5. 点击「检查配置」，再点击「同步全部」验证实际同步。配置检查只读取仓库信息，不验证写权限、目标分支存在性或合并冲突。

Cron 已随配置发布，每 15 分钟唤醒一次 Worker，再按页面保存的同步间隔决定是否执行；无需在控制台另外创建定时任务。首次设置接口只允许成功一次，创建管理员必须持有设置码。

如果设置码丢失，可以重新部署，在最新部署日志中获取新码；也可以在已绑定 D1 的项目目录、同一 Cloudflare 账号下运行：

```sh
npm run setup:token
```

它会替换未初始化服务的设置码，并在终端或 CI 输出中明确显示。**已创建管理员后，此命令会拒绝执行，不能用来重置密码。** 脚本仅在 Secret 上传成功后打印设置码。

完成初始化后，访问 Worker 地址下的 `/api/status`，应返回 `{"initialized":true}`。再登录管理页面确认仓库配置和手动同步结果；`/healthz` 只检查进程存活，不能替代这些验证。

### 4. 提交数据库绑定和依赖锁文件

首次安装生成的 `package-lock.json` 固定依赖版本；部署回填的 D1 数据库 ID 是资源标识，可以提交。将两者保存到 GitHub，供后续云端构建使用：

```sh
git add wrangler.jsonc package-lock.json
git commit -m "chore: record Cloudflare deployment configuration"
git push origin main
```

这里假设生产分支为 `main`。如果你使用其他分支，推送命令和下一步 Cloudflare 的分支设置需要保持一致。应用密钥已保存到 Workers Secrets，不在上述两个文件中。

### 5. 创建 Workers Builds 发布凭据

1. 在 Cloudflare 控制台进入 **头像 → My Profile → API Tokens → Create Token**。
2. 使用 **Edit Cloudflare Workers** 模板，将 Token 命名为 `fork-sync-builds`。
3. 在模板权限基础上补充 **Account → D1 → Edit**，将账号资源范围限定为此次部署所在的 Cloudflare 账号。
4. 创建 Token，下一步在 Workers Builds 的 **API token** 选项中选择它。

Cloudflare 默认自动创建的 Builds Token 不包含 D1 Edit，本项目创建数据库和执行迁移需要这项权限。这个 Cloudflare Token 用于发布代码；第 3 步的 GitHub Token 用于同步 Fork，在应用网页的「设置」中填写。

### 6. 关联 GitHub，启用自动部署

进入 Cloudflare 的 **Workers & Pages → github-fork-sync → Settings → Builds → Connect**。选择第 2 步已经发布的 Worker，按提示授权 Cloudflare 访问 GitHub 仓库，然后填写：

| 配置项 | 填写内容 |
| --- | --- |
| Git repository | 保存本项目的仓库，例如 `1477418489/githubForkSync` 或你自己的 Fork |
| Production branch / Git branch | `main`，或第 4 步使用的生产分支 |
| Root directory | 留空，使用仓库根目录 |
| Build command | 留空 |
| Deploy command | **`npm run deploy`** |
| API token | 选择第 5 步创建的 `fork-sync-builds` |
| Build Variables and Secrets | 添加变量 `NODE_VERSION`，值为 `24` |
| Non-production branch builds | 暂不启用；当前部署脚本只处理默认环境 |

Cloudflare 控制台中的 Worker 名称必须与 `wrangler.jsonc` 的 `name` 一致，默认均为 **`github-fork-sync`**。如果本地修改过名称，这里选择对应的 Worker。

构建环境会自动安装依赖。`npm run deploy` 已包含检查、数据库迁移和发布，因此 **Build command 留空，Deploy command 设置为 `npm run deploy`**。如果日志在完成本项目部署后又显示 `Executing user deploy command: npx wrangler deploy`，说明构建阶段已经发布了一次，而部署阶段又发布了一次；按表修正这两个字段。仓库中的 `.nvmrc` 也指定了 Node.js 24；版本覆盖方式见 [构建环境说明](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

保存连接配置后，向生产分支推送下一次代码提交，即会触发自动部署；直接在 GitHub 网页编辑文件并提交到该分支也会触发。进入 Worker 的 **Deployments → View build history** 查看构建状态和日志，构建、部署成功后新版代码才生效。已有管理密码、GitHub Token 和仓库配置会保留，后续更新无需重复网页初始化。

控制台字段和发布 Token 权限可参照 [Workers Builds 配置说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

## 数据和敏感信息存在哪里

| 内容 | 存储位置 | 保存方式 |
| --- | --- | --- |
| GitHub Token | D1 `app_settings` | AES-256-GCM 加密，每次保存使用随机 IV |
| 管理密码 | D1 `app_settings` | 随机盐 + PBKDF2-SHA256，100,000 次迭代，只存哈希 |
| 仓库、分支、同步间隔和开关 | D1 `app_settings` | 管理接口登录后才能读写 |
| 登录会话 | D1 `sessions` | 只存会话 Token 的 SHA-256 摘要和有效期 |
| 最近一次运行结果、同步锁 | D1 `sync_state` | 用于刷新结果和避免重叠执行 |
| 最近 20 条运行记录 | D1 `sync_history` | 按完成顺序保存完整报告，超出上限自动清理最旧记录 |
| 登录/设置尝试计数 | D1 `auth_attempts` | 按 IP 的哈希值和时间窗口记录 |
| 加密根密钥 | Workers Secret `ENCRYPTION_KEY` | 部署脚本随机生成，不存入 D1 |
| 首次设置码 | Workers Secret `SETUP_TOKEN` 和部署输出 | 初始化前每次部署重新生成并打印，管理员创建后失效 |

GitHub PAT、管理密码和应用密钥不会写入源码、`wrangler.jsonc`、`.env` 或 Workers Builds 构建配置。部署脚本通过标准输入上传 Secret，不将其放入命令参数。加密根密钥不打印；首次设置码会显示在部署输出中，包括 Cloudflare 构建日志、其他 CI 日志和重定向输出。

能够查看部署日志的人，在初始化前也能使用该设置码创建管理员；分享日志前应去掉设置码。完成管理员创建后，该码失效，不能用来登录或重置密码。

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

同步概览显示**预计下次同步时间**，按浏览器所在时区展示。服务根据上一次自动任务的计划时间、当前同步间隔和读取配置时刻之后的 15 分钟 Cron 触发点估算；首次启用时显示下一个触发点。保存新间隔或刷新页面会重新计算，暂停同步或配置不完整时不安排下次时间。该时间是估算值，实际执行可能受到 Cron 调度延迟和正在运行的同步任务影响。

自动任务不依赖页面保持打开。手动同步时请等待结果；客户端断开后不保证请求继续执行，可以刷新最近记录或检查 GitHub 仓库确认结果。D1 中的同步锁覆盖手动任务和 Cron；异常中断后最多保留 10 分钟。

按 [D1 官方价格说明](https://developers.cloudflare.com/d1/platform/pricing/)，Free 计划包含：

| 配额 | 免费额度 |
| --- | --- |
| 读取行数 | 每天 500 万行 |
| 写入行数 | 每天 10 万行 |
| 总存储 | 5 GB |

正常个人使用只保存少量配置和最近 20 条报告，适合先使用免费计划。实际仍受 D1、Workers 的请求/CPU/子请求限制，以及 GitHub API 限额约束；使用付费计划时按该账号的计费规则处理，不能保证所有使用量均免费。

每个仓库最多发出两次 GitHub 请求，20 个仓库最多 40 次，另有少量 D1 操作。Free 限额以 [Workers 官方限制](https://developers.cloudflare.com/workers/platform/limits/) 为准。

## 更新部署与其他 CI

已关联 Workers Builds 时，向配置的生产分支推送代码即可自动更新。未关联 GitHub 或需要本地手动发布时，运行：

```sh
npm run deploy
```

依赖或锁文件发生变化时，先运行 `npm ci` 安装锁定的依赖。部署脚本复用数据库、只执行未应用的迁移，并保留已有密钥与页面配置。迁移失败就停止发布。若部署中途失败，可修复原因后重新运行；已经创建的数据库会按名称复用。

运行记录功能通过 [0002_sync_history.sql](./migrations/0002_sync_history.sql) 增加历史表。`npm run deploy` 会自动执行该迁移，将旧版本已有的最近一条报告带入历史列表；此前已被覆盖的记录无法恢复。

本项目只自动处理 `wrangler.jsonc` 的默认环境。要部署独立的第二套服务，使用独立目录并修改 Worker `name`、D1 `database_name`，将该新服务的 `database_id` 设为全零占位值。不要让两个不同密钥的 Worker 共用同一个配置数据库。

当前仓库**未提供 GitHub Actions 工作流**。使用上面的 Workers Builds 流程不需要配置 Actions。若自行接入 GitHub Actions 或其他 CI，需要准备 Node.js 24+、安装项目依赖并执行 `npm run deploy`，同时提供以下发布凭据：

| CI 环境变量 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 限定账号的发布 Token，需要 Workers Scripts 编辑、D1 编辑及相关账号读取权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

使用 Cloudflare 的 Edit Cloudflare Workers 模板创建 Token 时，补充 **Account → D1 → Edit** 权限。自行配置 GitHub Actions 时，将上述凭据保存为仓库 Actions Secrets 并传给部署步骤。

如果首次部署通过 Workers Builds 或其他 CI 完成，直接从该次部署日志中的 **首次设置码（SETUP_TOKEN）** 区域取码即可。Cloudflare 不支持回读已有 Secret 的明文，因此服务未初始化时，重新部署或运行 `npm run setup:token` 会重发新码；已有管理员时保留现有配置，不再签发设置码。

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

测试覆盖数据库迁移、页面配置持久化、凭据加密、初始化竞争、会话失效、并发配置修改、定时频率与同步锁、历史记录保留和事务回滚、下次同步时间估算、GitHub 错误分类，以及部署中断、加密密钥保留、设置码重发和非交互 CI 的设置码输出。测试不替代实际账号权限和线上运行验证。

## HTTP API

路径相对于 Worker URL。管理接口使用登录 Cookie，不再支持旧的 Bearer ADMIN_TOKEN；跨站 Origin 被拒绝，所有 API 响应禁止缓存。

| 方法 | 路径 | 认证 | 行为 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | 进程存活检查，不验证 D1 或 GitHub |
| GET | `/api/status` | 无 | 检查部署状态，仅返回 `initialized` |
| POST | `/api/setup` | 首次设置码 | JSON：`{setupToken, password}`；创建唯一管理员并登录 |
| POST | `/api/login` | 管理密码 | JSON：`{password}`；设置会话 Cookie |
| POST | `/api/logout` | 当前 Cookie | 注销当前会话 |
| GET | `/api/config` | 登录 | 获取配置、Token 是否已设置、同步锁状态、最近 20 条报告和预计下次同步时间 |
| PUT | `/api/config` | 登录 | 保存页面配置，可更新 Token 或管理密码 |
| POST | `/api/sync` | 登录 | 同步全部已保存仓库，或执行只读配置检查 |

`GET /api/config` 和保存配置成功后的响应包含以下运行信息：

| 字段 | 含义 |
| --- | --- |
| `lastRun` | 最近一次完整报告；尚无记录时为 `null`，保留原有接口字段 |
| `recentRuns` | 最近 20 条完整报告，按完成顺序倒序排列；尚无记录时为 `[]` |
| `historyLimit` | 当前历史记录上限，固定为 `20` |
| `nextSyncAt` | 预计下次自动同步时间，使用 UTC ISO 8601 字符串；暂停或配置不完整时为 `null` |
| `running` | 是否存在尚未过期的同步锁 |

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

最近 **20 条**已完成的配置检查、手动同步和自动同步报告保存在 D1，按完成顺序倒序展示。每条记录包含执行时间、运行方式、结果汇总和各仓库的结果，点击记录可展开详情；失败报告也会保留。超出 20 条时自动删除最旧记录，刷新或重新部署后仍可查看。

页面上方继续显示最近一次结果，历史列表包含该次运行。自动同步处于暂停状态、尚未到执行间隔或已有同步锁时，跳过的 Cron 唤醒不产生历史记录。报告区分 `synced`、`up_to_date`、`checked`、`failed`、`skipped`；刷新按钮同时更新记录和预计下次同步时间。

```sh
npm run logs
```

Cloudflare Observability 也可查看运行日志。每轮输出 `event: fork_sync` 和运行报告，包含仓库名称、上游和结果，不包含 Token 或密码；日志可见范围与保留时间由 Cloudflare 账号设置决定。任一仓库失败会让 Cron 调用也标记为失败。

| 情况 | 处理方式 |
| --- | --- |
| 云端构建提示 Node.js 版本或 TypeScript 语法不支持 | 检查 Builds 的 `NODE_VERSION=24` 和仓库根目录的 `.nvmrc`，修正后重新构建 |
| 部署时 D1 操作被拒绝 | 确认 Builds 使用的是带 Account → D1 → Edit 权限的发布 Token，并且限定账号与数据库所在账号一致 |
| Builds 提示 Worker 名称不匹配 | 将控制台选择的 Worker 与 `wrangler.jsonc` 的 `name` 对齐，默认是 `github-fork-sync` |
| GitHub 提交后没有自动部署 | 检查 Settings → Builds 中关联的仓库、生产分支，以及 Cloudflare GitHub 应用的仓库访问授权 |
| 部署成功但没有看到首次设置码 | 未初始化服务使用更新后的脚本重新部署，查找最新日志中的“首次设置码（SETUP_TOKEN）”；已创建管理员时不会再生成设置码 |
| 构建结束后又执行一次 `npx wrangler deploy` | 将 Build command 留空，Deploy command 设为 `npm run deploy`，避免重复发布 |
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
wrangler.jsonc      Worker、D1、静态资源与 Cron 配置
```

官方参考：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[构建配置和发布权限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[GitHub Fork 同步 API](https://docs.github.com/en/rest/branches/branches#sync-a-fork-branch-with-the-upstream-repository)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
