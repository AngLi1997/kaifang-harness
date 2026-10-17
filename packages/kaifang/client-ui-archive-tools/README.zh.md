---
description: "侧边栏档案工具目录，支持点击引用和在输入框中 @ 选取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-kaifang-client-ui-archive-tools

[English](README.md) | 中文

## 概述

打开左侧边栏**插件**下方的**档案工具**查看档案工具目录。本地工具分为**图像处理**和**文档处理**两组，其后是在线工具。点击卡片会回到当前显示的对话，并在草稿中引用该工具；也可以在输入框中键入 `@`，从**档案工具**分组中选取工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 默认挂载本插件。目录列出 OCR 文字识别、图片转双层 PDF、AI 修档案、文档润色和 Demo 测试。点击卡片会把该工具的引用标签追加到当前对话草稿末尾，并把键盘焦点还给输入框。没有显示中的对话时，点击会新建对话，其草稿包含该工具的 `@<tool id>` 提及。草稿正在提交时，点击不修改草稿，并在输入框中显示提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件以共享 id `kaifang-archive-tools` 注册一个 `main` 面板和一个 `sidebar.panellist` 条目，因此侧边栏自带的面板按钮会选中目录。插件还在文件与会话引用之前注册 `@` 触发源 `kaifang-archive-tools`。其静态词表会装饰键入的 `@<tool id>` 文本，编解码器把每个引用标签作为该提及发送。点击卡片时，插件找到主视图保留的会话，通过该会话的输入框插入引用标签，选中对话面板，并在下一动画帧聚焦输入框。卸载时移除触发源、两个插槽条目和待执行的聚焦。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [输入触发器](../../client/ui-input-trigger/README.zh.md) — `@` 触发源、引用标签与编解码器。
- [Web 客户端](../../../docs/subsystems/web-client.zh.md) — 插件组合与主面板选择。

<a id="model-experience"></a>
## 模型体验

无；本插件只在未发送草稿中放入可审阅的 `@<tool id>` 提及，由用户提交的消息携带。

#### KV Cache 影响

无；插件自身不添加请求内容。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **尚无工具实现** — 目录只通过 `@<tool id>` 提及引用工具；没有 Host 包提供 OCR、PDF 转换、档案修复、文案润色或在线演示，因此模型收到的提及没有对应工具。

<a id="dev-note"></a>
### 开发备注

无。
