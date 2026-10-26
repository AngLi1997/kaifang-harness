---
name: weknora-query
description: 通过 WeKnora 查询知识库。用于列出当前凭据可见的知识库、检索明确选定的知识库，或查看检索结果中的原文片段。只读，不上传、修改或删除知识。
---

# WeKnora 知识库查询

使用配套脚本查询当前凭据有权访问的 WeKnora 知识库。该技能只开放知识库列表和检索 API；不要用其他接口写入或管理数据。

## 凭据

脚本先读取当前进程的 `WEKNORA_BASE_URL`、`WEKNORA_API_KEY` 和可选的 `WEKNORA_TENANT_ID`。DSH shell 会清除名称包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的环境变量；未能从进程环境取得凭据时，脚本会读取 `$HOME/.dsh/weknora.env`。请让用户在仓库外创建该文件，格式为每行一个 `NAME=value`，并设置为仅当前用户可读写（`chmod 600`）。不要让用户把 API Key 发到对话中，也不要读取、打印或复制凭据文件内容。

使用仅有 `retrieve` 能力且限制到目标知识库的 API Key。平台级 API Key 还需要对应的 `WEKNORA_TENANT_ID`。缺少凭据、tenant ID 或访问权限时，说明具体缺项并停止；不要尝试创建或扩大权限。

## 查询知识库

从仓库根目录运行脚本。先列出当前凭据可见的知识库，再用用户选择的 ID 检索：

```bash
python3 .agents/skills/weknora-query/scripts/weknora_query.py list
python3 .agents/skills/weknora-query/scripts/weknora_query.py search --kb <知识库ID> --query '<查询问题>'
```

可重复传入 `--kb` 搜索多个知识库。脚本要求显式指定至少一个 ID，不会默认搜索凭据下的所有知识库。WeKnora 查询使用 `POST /api/v1/knowledge-search`，返回原文片段供回答引用；优先保留结果中的知识库名、文档名、知识 ID 和相关度。若列表为空，或查询没有命中，直接说明 WeKnora 当前返回的结果，不要编造内容。

## 失败处理

- `401`：凭据无效或缺失。
- `403`：API Key 缺少 `retrieve` 权限，或被限制在其它知识库。
- `409 TENANT_REQUIRED`：平台级 Key 缺少 `WEKNORA_TENANT_ID`。
- 连接失败或 `502`：报告服务地址或 WeKnora 代理仍不可用，并保留错误状态。

不要重试会改变知识库内容的请求。查询失败时展示状态码和 WeKnora 返回的简短错误，不展示请求头或凭据。
