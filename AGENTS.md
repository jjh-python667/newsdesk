# 项目约定

- 前端偏好见 FRONTEND-PREFERENCES.md 与 .cursor/rules/frontend-motion.mdc，编辑前请阅读。
- 用户是新手，手动操作需要说明按钮位置、输入内容和成功标志。
- 前端源文件为 src/ui.html；修改后运行 node scripts/build-ui.cjs，并用 --check 核对生成模块。
- 保留 x-newsdesk 请求头及真实原文链接的默认跳转行为。
- 采集、数据库、内部密钥和 Access 配置按 HANDOFF.md 保留。
- 此次修改先交用户核对，再部署。未经后续部署指示，不执行发布脚本。
