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
- INTERNAL_KEY：通过 Cloudflare Secret 设置的随机内部密钥。

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

## 已知范围

个人实例每 30 分钟采集。每源每轮最多 30 条，最多并发 5 个来源；25 秒请求超时，临时错误最多重试 2 次。36氪可能向 Workers 返回人机验证 HTML，来源会明确报告异常并保留历史文章。

前端本地回归使用模拟接口，不代表真实云端 Access、D1 和真机性能已完成二次验收。
