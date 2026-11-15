# 部署与维护交接

公开仓库使用通用配置模板，不包含作者的 Cloudflare 账户 ID、D1 ID、Access AUD、登录邮箱或任何密钥。

## 前端构建

    npm run build
    npm run check
    npm run preview

前端源文件为 src/ui.html；src/ui.js 是 Worker 导入的生成模块。预览仅使用固定演示数据，不读取生产数据。

## 运行时绑定

- DB：D1 数据库。
- TEAM_DOMAIN：自己的 Cloudflare Access 团队域名。
- ACCESS_AUD：自己的 Access 应用 Audience。
- ALLOWED_EMAILS：允许访问的精确邮箱，逗号分隔。
- SELF：指向同一个 Worker 的服务绑定，用于单源采集扇出。
- INTERNAL_KEY：通过 Cloudflare Secret 设置的随机内部密钥。未设置或为空时，`/internal/collect` 会拒绝请求；密钥已设置时，比较方式与原来相同。

## 在自己的账户部署

1. 建立自己的 Worker、D1 和 Access 应用。Access 保护正式入口，只允许自己的登录身份。
2. 把 wrangler.example.jsonc 复制为 wrangler.jsonc，填入自己的非密钥配置；实际配置文件已被 Git 忽略。
3. 新数据库执行 schema.sql 和 sources.sql；schema.sql 已含来源诊断字段。已有数据库先检查 PRAGMA table_info(sources)，仅补缺失列，不清理历史数据。
4. 为 INTERNAL_KEY 设置一次足够长的随机 Secret；保留已运行实例的原密钥。
5. 生成 UI 后，在已确认绑定完整的前提下执行自己的部署流程。
6. 验证未登录不能访问首页及接口，精确邮箱可登录，原文、收藏、已读和采集可用。

## 更新现有实例

- 先读取最新线上模块，再合并前端，避免旧版本覆盖之后的后端修复。
- 保留 DB、SELF、Access 设置、定时任务和原 INTERNAL_KEY。
- 更新只需替换对应模块，不运行首次部署流程，不清空数据库。
- 所有 POST API 保留 x-newsdesk: 1；原文保持真实 a 链接，异步保存已读不拦截导航。

## GitHub OAuth 登录

配置模板默认使用现有 Access 登录模式。后续启用 GitHub 模式时，将 `AUTH_MODE` 设为 `github`。设置 `GITHUB_AUTH_ORIGIN` 为资讯台的 HTTPS 来源（无末尾斜杠），`GITHUB_CLIENT_ID` 为 OAuth App 的客户端 ID，`ALLOWED_GITHUB_IDS` 填入从官方 GitHub 用户资料核对过的 `jjh-python667` 数值 ID。该变量只接受一个 ID。OAuth App 的回调地址为 `<GITHUB_AUTH_ORIGIN>/auth/github/callback`。

运行时密钥名称为 `GITHUB_CLIENT_SECRET` 和 `SESSION_SECRET`。后者应由密码学随机数生成，至少 32 字节。GitHub 模式验证数值 ID 后签发 8 小时的签名 Cookie，每次访问重新检查当前白名单。GitHub access token 仅用于获取一次用户资料。流程不需要新增数据库表。

如果入口仍受 Cloudflare Access 保护，浏览器会先经过现有 Access 门禁，再由 Worker 检查 GitHub 会话。后续如要调整门禁，需另行核对入口及 OAuth 回调的可达性。定时采集和内部采集服务绑定沿用原路径。

## 已知范围

个人实例每 30 分钟采集。每源每轮最多 30 条，最多并发 5 个来源；25 秒请求超时，临时错误最多重试 2 次。36氪可能向 Workers 返回人机验证 HTML，来源会明确报告异常并保留历史文章。

前端本地回归使用模拟接口，不代表真实云端 Access、D1 和真机性能已完成二次验收。
