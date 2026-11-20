# B 站视频下载助手开发指南

扩展使用 Manifest V3，运行入口、权限和资源以 [manifest.json](../manifest.json) 及 Chromium 打包脚本为准。浏览器调试、回归和发包见[开发与验证](开发与验证.md)，用户操作见[功能说明](功能说明.md)。

## 组件职责

| 组件 | 职责与调用方式 |
| --- | --- |
| [页面代理](../content/page-agent.js) | 在 MAIN world、`document_start` 运行。解析视频、分 P、列表、合集、空间投稿和官方剧集，读取 B 站接口，按真实可用档位选流，在页面的 Cookie / Referer 环境发起媒体 CDN 请求。管理每个任务的暂停、Range 续传、取消和进度，向内容脚本返回媒体 Blob。 |
| [内容脚本](../content/content.js) | 在 ISOLATED world、`document_end` 运行。管理悬浮面板、列表分页与选择、下载队列、任务状态、下载历史、设置和诊断。通过页面代理获取媒体，调度合成 Worker，再协调保存。样式放在同目录的 CSS 或共享样式中。 |
| [工具栏弹窗](../popup/popup.html) | 经 `tabs.sendMessage` 发送 `BILI_DL_OPEN_PANEL`，Chrome 在面板展开后关闭弹窗。弹窗也提供下载历史和页面刷新入口。 |
| [扩展后台](../background.js) | 使用 `runtime.onMessage` 提供浏览器原生保存、下载查询与取消、打开下载记录、封面保存、历史串行写入及下载期间的防休眠管理。媒体 CDN 拉流由页面代理处理。 |
| [共享模块](../shared/) | 通过 `globalThis` 上的现有接口提供文件名模板、设置迁移、主题和翻译。跨入口复用规则时放在这里，调用方各自负责界面和任务状态。 |
| [媒体合成](../lib/) | `m4s-mux.js` 包装媒体检查和封装，`m4s-mux-worker.js` 接收任务、报告进度并支持取消，`mp4-remux.iife.js` 是随扩展分发的第三方合成库。 |

## 消息和任务生命周期

页面侧使用 `window.postMessage`。收发两端核对当前窗口和约定的 `source` 值。页面能访问此通道，扩展特权操作仍须在运行时消息入口验证权限。

| 方向 | 消息 |
| --- | --- |
| 内容脚本 → 页面代理（`bili-dl-panel`） | `PARSE_URL`、`RESOLVE_VIDEO`、`RESOLVE_LIST`、`SPACE_COLLECTIONS`、`LOAD_LIST_PAGE`、`CHECK_PGC_ACCESS`、`GET_QUALITIES`、`GET_ESTIMATE`、`START_DOWNLOAD` |
| 页面代理 → 内容脚本（`bili-dl-agent`） | `OK`（`data`）或 `ERR`（`error`）回传请求 `id`，另有 `LOG` 和 `PROGRESS` 事件 |
| 任务控制 | 内容脚本通过 `agentSignal` 发送 `PAUSE_DOWNLOAD`、`RESUME_DOWNLOAD` 或 `CANCEL_DOWNLOAD`，按 `jobId` 定位，无请求回复 |
| 合成调度 | 页面代理发送 `MERGE_REQUEST` 或 `MERGE_CANCEL`，内容脚本以 `MERGE_RESULT` 回传 Blob 或错误。三种消息都按 `jobId` 匹配 |

- `agentCall` 生成的 `id` 用于匹配单次调用。常规请求默认 20 秒超时，长任务可传 `0` 关闭此等待上限。任务 `jobId` 用于关联传输控制、进度、合成和进度卡。修改消息时同步改动收发两端。
- 内容脚本以 `BILI_DL_ADD_HISTORY` 将成功记录交给后台串行追加；Popup 以 `BILI_DL_CLEAR_HISTORY` 清空当前隐私环境的历史。后台验证 B 站发送方或 Popup 来源。普通历史沿用 `biliDlHistory`，新增无痕历史使用 `biliDlHistoryPrivate`，避免 Chromium 分离后台同时改写共享存储。旧记录无法自动区分是否来自无痕，仍保留在原键中。历史写入失败不能中断媒体保存。
- `START_DOWNLOAD` 成功返回媒体 Blob、文件名和任务标识。DASH 合成在需要时可附带已下载的音轨，供同一任务保存 M4A。按任务区分媒体请求、合成和磁盘保存的失败，避免把失败标为完成。
- Chromium 单视频和批量任务都由内容脚本在受信任点击中取得目录句柄，再发起下载并写入文件。批量封面经后台白名单读取，以文档隔离的 `requestId` 关联 `BILI_DL_DOWNLOAD_COVER` 与 `BILI_DL_CANCEL_COVER`；后台对整个读取设置 30 秒上限，内容脚本取消时中断等待并通知后台终止请求，35 秒兜底避免后台无响应锁住队列。每项文件写入提交后才释放该任务的并发名额，同目录写入串行分配并提交文件名。后台的浏览器下载及状态消息仍用于原生保存流程。
- 区分同一 BV 的分 P、视频页合集、`/list/`、UP 主空间及官方剧集。列表选择和队列需要保留条目标识与分 P；任务入队时固定当前来源、选择、文件名模板和批量并发数（1–5，默认 3）。批量 `batchIndex` 按本次选中任务排列从 1 固定，命名追加 `_pN`，重试与清晰度调整均须保留；它与实际分 P 的 `part` 不同。未完成任务检查点按队列串行写入。处理取消、失败、重试和站内切页时，释放任务状态及资源。

## 下载防休眠

- Chromium 使用 `power` 权限和 `chrome.power.requestKeepAwake('system')`。
- `shared/download-power.js` 在内容脚本前加载，按任务和队列状态管理 `BILI_DL_POWER` runtime port。后台校验 B 站发送方，聚合连接需求和原生保存任务。
- 后台每 20 秒询问连接状态并续用电源接口；页面断开释放对应需求，后台断开后活动页面重连。全部暂停时仅合成和保存任务继续保护。
- 原生下载通过创建计数、下载 ID、完成事件及启动查询管理，恢复时核对扩展归属和无痕环境。API 故障只写诊断，不中断下载。

## 依赖与代码风格

- 运行脚本沿用原生 JavaScript、现有 IIFE 和两空格缩进等局部风格。复用现有函数和消息封装。CSS 沿用组件选择器范围及共享主题变量，避免污染 B 站页面。局部调整随组件修改，共用样式见 [design-system.css](../shared/design-system.css) 和 [ambient-themes.css](../shared/ambient-themes.css)。
- `filename.js` 在 `download-settings.js` 前加载，供后者规范化模板、兼容旧文件名偏好。保留旧存储键的迁移路径。Popup 的设置入口复用面板交互。
- 面板与 popup 均先加载 `theme-manager.js`，再依次加载 `i18n-languages.js`、`i18n.js`、`i18n-extra.js`、`i18n-ja-ko.js`，最后加载对应入口脚本。页面和弹窗文案使用 `BiliDlI18n` 的翻译键，扩展名称及描述使用 [_locales](../_locales/) 中的 `extName` / `extDesc`，默认语言为 `zh_CN`。
- Blob Worker 按 `mp4-remux.iife.js`、`m4s-mux.js`、`m4s-mux-worker.js` 的顺序拼接已打包脚本。保留 Worker 取消、媒体完整性检查和大任务互斥。Worker 不可用时，符合条件的小任务走页面外链脚本的兼容路径。维护第三方库时核对 [mp4-remux 上游](https://github.com/mscststs/mp4-remux) 的 MIT 许可及 [test 依赖锁文件](../test/package-lock.json)，同步更新本地副本并验证 Worker 和实际合成。
- 新增运行资源时核对 [manifest](../manifest.json) 的注入顺序、权限和页面可访问资源、[popup HTML](../popup/popup.html) 的引用，以及 [Chromium 打包脚本](../scripts/pack.py) 的 `INCLUDE` 清单。

## 权限与隐私

- 清晰度和片源以 B 站返回及当前账号访问权限为准。保留官方剧集的媒体可用性检查，禁止绕过登录、试看、会员、付费、地区和内容保护限制。
- 后台保留下载消息的发送方校验、媒体 Blob 同源与文件名检查、下载归属检查及无痕环境校验。封面使用地址白名单。
- 下载记录、设置与缓存保存在本地。诊断导出保持脱敏，避免泄露媒体链接、账号信息和敏感参数。公开帮助文档使用面向用户的操作说明。
