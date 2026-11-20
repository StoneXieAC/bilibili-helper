# Codex 开发指南

本仓库是 B 站视频下载助手，面向 Edge 和 Chrome。改动前阅读 [manifest.json](manifest.json) 和涉及组件的[开发指南](docs/DEVELOPER.md)。

## 组件边界

- `content/page-agent.js` 在 MAIN world 解析页面和接口数据，选择可用片源并管理每个任务的 CDN 传输。
- `content/content.js` 在 ISOLATED world 管理悬浮面板、下载队列、Worker 调度和文件保存流程。
- `popup/` 负责预览、历史和面板入口，通过现有扩展消息与内容脚本交互。
- `background.js` 负责浏览器原生保存、下载状态和受限的封面资源读取。
- `shared/` 维护文件名、设置迁移、主题和国际化。媒体合成封装和 Worker 放在 `lib/`。

## 通用约束

- 沿用原生 JavaScript、CSS 和文件现有风格，复用现有消息、设置和样式接口。
- 跨组件改动同步核对消息两端、脚本加载顺序、浏览器差异和旧设置迁移。
- 清晰度和片源以 B 站接口及当前账号权限为准。禁止绕过登录、会员、付费、地区及内容保护限制。
- 维持现有权限范围、消息来源及下载归属校验。下载记录及设置保存在本地，诊断导出须脱敏。
- 新增运行文件时核对 manifest、popup 引用及Chromium 打包清单。更新公开行为时同步修订功能文档。

## 验证与参考

- 按改动范围运行关联回归。调试、跨浏览器验证和打包步骤见[开发与验证](docs/开发与验证.md)。
- 用户操作见[功能说明](docs/功能说明.md)，发版和审查笔记见[版本记录](docs/history/README.md)。
