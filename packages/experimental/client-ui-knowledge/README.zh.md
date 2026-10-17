---
description: "本地知识库 Web 页面、@ 知识库菜单与引用标签。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-knowledge

[English](README.md) | 中文

## 概述

此浏览器插件在 Web 侧边栏添加“本地知识库”入口。页面列出每个本地知识库及其索引状态，用户可以新建、重命名、重新索引和删除知识库，选择文件夹、添加文件，并发起引用知识库的对话。在任意对话中输入 `@`，知识库会与文件、会话一起列出。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在插件页启用[知识库组合包](../knowledge-bundle/README.zh.md)，然后在侧边栏打开“本地知识库”。“新建知识库”要求填写名称和文件夹：“选择目录”在本机宿主上打开操作系统的选择器，其他情况打开应用内文件夹浏览器，也可以直接输入绝对路径。“文件”列出已索引文件；“添加文件”把在文件资源管理器中选择的文件复制到知识库。“在知识库中提问”在当前或最近的工作区新建对话，草稿以该知识库的标签开头。在输入框中输入 `@` 会列出匹配的知识库；选中后插入同样的标签，发送后的消息把它显示为文件夹标签，点击可打开本页面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

插件挂载生成的 `knowledge` Remote 贡献，并在其生命周期内只订阅一次目录流。页面通过注入的 `knowledgeCatalog` hook 读取目录，所有宿主操作以回调传入。`@` 来源、用户文本规则和键控的 `conversation.user.text.node` 渲染器使用宿主给出的规范引用 `@[name](dsh-knowledge:id)`；输入框中的标签使用文件夹外观。侧边栏条目的 order 为 20，位于“插件”和“自动化任务”之后。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识库服务](../knowledge/README.zh.md)
- [knowledge_search 工具](../tool-knowledge/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为页面只管理知识库，输入框只在未发送的草稿中插入可检查的引用标签。

#### KV 缓存影响

没有直接影响；消息内容由普通提交承载。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 添加的文件会读入内存并以 base64 在一个请求中发送，因此上传上限需保持在单条 Remote 消息可承载的范围内。
- “在知识库中提问”需要已有工作区；没有工作区时，工作区提示会要求用户先选择文件夹。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
