# 部署与维护交接

公开仓库使用通用配置模板，不包含作者的 Cloudflare 账户 ID、D1 ID、Access AUD、GitHub client secret、会话密钥或登录邮箱。

## 前端构建

    npm run build
    npm run check
    npm run preview

前端源文件为 src/ui.html；src/ui.js 是 Worker 导入的生成模块。预览仅使用固定演示数据，不读取生产数据。

## 运行时绑定

- DB：D1 数据库。已有库补跑 `migrations/0001_oauth_states.sql`。新库执行 `schema.sql` 时已经包含 `oauth_states`。
- GITHUB_CLIENT_ID：GitHub OAuth App 的 Client ID，普通变量。
- ALLOWED_GITHUB_LOGINS：允许登录的 GitHub 用户名，逗号分隔，普通变量。比较时忽略大小写。
- GITHUB_CLIENT_SECRET：OAuth App 的 client secret，Cloudflare Secret。
- SESSION_SECRET：会话签名密钥，Cloudflare Secret，至少 16 个字符。
- TEAM_DOMAIN、ACCESS_AUD：两个都是非空字符串时才走 Cloudflare Access。新账号不用 Access 时留空。只设置其中一个不算启用 Access。
- ALLOWED_EMAILS：只在 Access 模式下检查邮箱，逗号分隔。
- SELF：指向同一个 Worker 的服务绑定，用于单源采集扇出。
- INTERNAL_KEY：通过 Cloudflare Secret 设置的随机内部密钥。未设置或为空时，`/internal/collect` 会拒绝请求；密钥已设置时，比较方式与原来相同。`/internal/collect` 和定时任务都不走 GitHub 登录。

## 在自己的账户部署

1. 建立自己的 Worker 和 D1。不用 Access 时，按 README 的「部署到自己的账户」建 GitHub OAuth App，回调填 `https://newsdesk.gongjiangcai.workers.dev/auth/github/callback`。仍要用 Access 时，再建 Access 应用，并同时设置 `TEAM_DOMAIN` 和 `ACCESS_AUD`。
2. 把 wrangler.example.jsonc 复制为 wrangler.jsonc，填入自己的非密钥配置；实际配置文件已被 Git 忽略。`GITHUB_CLIENT_ID` 可以放在 vars 里。
3. 新数据库执行 schema.sql 和 sources.sql；schema.sql 已含来源诊断字段和 `oauth_states`。已有数据库先检查 PRAGMA table_info(sources)，仅补缺失列，不清理历史数据。GitHub 登录再执行 migrations/0001_oauth_states.sql，不要对远程清库。
4. 设置 Secret：`INTERNAL_KEY`、`GITHUB_CLIENT_SECRET`、`SESSION_SECRET`。保留已运行实例的原 `INTERNAL_KEY`。不要把这三个值写进仓库。
5. 生成 UI 后，在已确认绑定完整的前提下执行自己的部署流程。先核对，再部署。
6. 验证未登录的页面是「用 GitHub 登录」，`/api/` 返回 401；名单内的 GitHub 账号可以登录；名单外的账号被拒绝。原文、收藏、已读和采集可用。若走 Access，则改为验证精确邮箱。

## 更新现有实例

- 先读取最新线上模块，再合并前端，避免旧版本覆盖之后的后端修复。
- 保留 DB、SELF、定时任务和原 INTERNAL_KEY。不用 Access 时不要留下 `TEAM_DOMAIN` 和 `ACCESS_AUD`。仍用 Access 时保留这两项和 `ALLOWED_EMAILS`。
- GitHub 模式补上 `GITHUB_CLIENT_ID`、`ALLOWED_GITHUB_LOGINS`、`GITHUB_CLIENT_SECRET`、`SESSION_SECRET` 和 `oauth_states` 表。
- 更新只需替换对应模块，不运行首次部署流程，不清空数据库。
- 所有 POST API 保留 x-newsdesk: 1；原文保持真实 a 链接，异步保存已读不拦截导航。

## 已知范围

个人实例每 30 分钟采集。每源每轮最多 30 条，最多并发 5 个来源；25 秒请求超时，临时错误最多重试 2 次。36氪可能向 Workers 返回人机验证 HTML，来源会明确报告异常并保留历史文章。

前端本地回归使用模拟接口，不代表真实云端 Access、D1 和真机性能已完成二次验收。
