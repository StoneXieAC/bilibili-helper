# 第三方组件

## mp4-remux 0.2.1

- 上游：[mscststs/mp4-remux](https://github.com/mscststs/mp4-remux)
- npm 来源与完整性记录：`test/package-lock.json`
- Copyright (c) 2023 mscststs
- 许可：MIT，完整原文见 [lib/mp4-remux.LICENSE](lib/mp4-remux.LICENSE)。
- 分发文件：`lib/mp4-remux.iife.js`。
- 本地修改：流式合成时串行更新解析器、等待输出背压、处理不等长音视频尾部、传播错误、避免复制合并后的 mdat，并校验所需轨道信息。此文件与上游 npm 文件不同；验证生产合成应加载仓库内的实际副本。

本说明仅描述第三方组件，不为本项目其余代码、图标或商店素材授予新的许可。维护者需在对外许可前确认这些内容的来源和授权。
