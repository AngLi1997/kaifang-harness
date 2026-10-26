#!/usr/bin/env python3
"""Run bounded, read-only WeKnora knowledge-base queries."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 4_000_000
MAX_SEARCH_RESULTS = 8
MAX_CONTENT_CHARS = 2_500


class QueryError(Exception):
    """A safe, user-facing configuration or API failure."""


def load_file_env() -> dict[str, str]:
    path = Path.home() / ".dsh" / "weknora.env"
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise QueryError(f"无法读取凭据文件 {path}: {error.strerror or 'I/O error'}") from None

    if os.name != "nt" and mode & 0o077:
        raise QueryError(f"凭据文件权限过宽，请运行 chmod 600 {path}")

    values: dict[str, str] = {}
    for line_number, line in enumerate(content.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise QueryError(f"凭据文件第 {line_number} 行不是 NAME=value 格式")
        name, value = stripped.split("=", 1)
        name = name.strip()
        value = value.strip()
        if value.startswith(("'", '"')) and value.endswith(value[0]) and len(value) >= 2:
            value = value[1:-1]
        if name in {"WEKNORA_BASE_URL", "WEKNORA_API_KEY", "WEKNORA_TENANT_ID"}:
            values[name] = value
    return values


def configuration() -> tuple[str, str, str | None]:
    file_values = load_file_env()
    base_url = os.environ.get("WEKNORA_BASE_URL") or file_values.get("WEKNORA_BASE_URL", "")
    api_key = os.environ.get("WEKNORA_API_KEY") or file_values.get("WEKNORA_API_KEY", "")
    tenant_id = os.environ.get("WEKNORA_TENANT_ID") or file_values.get("WEKNORA_TENANT_ID")
    if not base_url:
        raise QueryError("缺少 WEKNORA_BASE_URL；请在进程环境或仓库外的凭据文件中配置")
    if not api_key:
        raise QueryError("缺少 WEKNORA_API_KEY；请在进程环境或仓库外的凭据文件中配置")

    parsed = urlsplit(base_url.rstrip("/"))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise QueryError("WEKNORA_BASE_URL 必须是有效的 HTTP(S) 地址，不能包含用户名、密码、查询参数或片段")
    path = parsed.path.rstrip("/")
    if path and path != "/api/v1":
        raise QueryError("WEKNORA_BASE_URL 只能是服务根地址或以 /api/v1 结尾")
    api_path = "/api/v1"
    api_root = urlunsplit((parsed.scheme, parsed.netloc, api_path, "", ""))
    return api_root, api_key, tenant_id


def request_json(method: str, path: str, payload: dict[str, object] | None = None) -> object:
    api_root, api_key, tenant_id = configuration()
    headers = {"Accept": "application/json", "X-API-Key": api_key}
    if tenant_id:
        headers["X-Tenant-ID"] = tenant_id
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(f"{api_root}/{path}", data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raw = error.read(16_384)
        message = ""
        try:
            decoded = json.loads(raw)
            if isinstance(decoded, dict):
                detail = decoded.get("error")
                if isinstance(detail, dict):
                    message = str(detail.get("message", ""))
                elif isinstance(detail, str):
                    message = detail
                if not message:
                    message = str(decoded.get("message", ""))
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        suffix = f": {message[:300]}" if message else ""
        raise QueryError(f"WeKnora HTTP {error.code}{suffix}") from None
    except (TimeoutError, URLError) as error:
        reason = getattr(error, "reason", error)
        raise QueryError(f"连接 WeKnora 失败: {reason}") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise QueryError("WeKnora 响应超过 4 MB，已停止读取")
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise QueryError("WeKnora 返回了无效 JSON") from None


def response_data(value: object) -> object:
    if not isinstance(value, dict):
        raise QueryError("WeKnora 响应不是 JSON 对象")
    if value.get("success") is False:
        error = value.get("error")
        if isinstance(error, dict):
            message = str(error.get("message", "请求失败"))
        else:
            message = "请求失败"
        raise QueryError(f"WeKnora 请求失败: {message[:300]}")
    return value.get("data", value)


def list_knowledge_bases() -> None:
    rows: list[object] = []
    page = 1
    while page <= 20:
        data = response_data(request_json("GET", f"knowledge-bases?{urlencode({'page': page, 'page_size': 100})}"))
        if isinstance(data, list):
            rows.extend(data)
            break
        if not isinstance(data, dict):
            raise QueryError("WeKnora 知识库列表格式无效")
        items = data.get("items", data.get("list", []))
        if not isinstance(items, list):
            raise QueryError("WeKnora 知识库列表格式无效")
        rows.extend(items)
        total = data.get("total")
        if not isinstance(total, int) or len(rows) >= total or len(items) < 100:
            break
        page += 1
    output = []
    for item in rows:
        if isinstance(item, dict):
            output.append({key: item.get(key) for key in ("id", "name", "description", "knowledge_count") if item.get(key) is not None})
    print(json.dumps(output, ensure_ascii=False, indent=2))


def search(query: str, knowledge_base_ids: list[str]) -> None:
    normalized_ids = list(dict.fromkeys(item.strip() for item in knowledge_base_ids if item.strip()))
    if not normalized_ids:
        raise QueryError("请至少通过 --kb 指定一个知识库 ID")
    data = response_data(request_json("POST", "knowledge-search", {"query": query, "knowledge_base_ids": normalized_ids}))
    if isinstance(data, dict):
        results = data.get("results", data.get("items", []))
    else:
        results = data
    if not isinstance(results, list):
        raise QueryError("WeKnora 检索结果格式无效")

    output = []
    for item in results[:MAX_SEARCH_RESULTS]:
        if not isinstance(item, dict):
            continue
        content = item.get("content", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        output.append({
            "knowledge_base_id": item.get("knowledge_base_id"),
            "knowledge_base_name": item.get("knowledge_base_name"),
            "knowledge_id": item.get("knowledge_id"),
            "title": item.get("knowledge_title") or item.get("title"),
            "score": item.get("score"),
            "chunk_index": item.get("chunk_index"),
            "content": content[:MAX_CONTENT_CHARS],
            "truncated": len(content) > MAX_CONTENT_CHARS,
        })
    print(json.dumps(output, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="只读查询 WeKnora 知识库")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="列出当前凭据可见的知识库")
    search_parser = commands.add_parser("search", help="检索明确指定的知识库")
    search_parser.add_argument("--kb", action="append", required=True, help="知识库 ID；可重复指定")
    search_parser.add_argument("--query", required=True, help="自然语言查询")
    args = parser.parse_args()
    try:
        if args.command == "list":
            list_knowledge_bases()
        elif args.command == "search":
            search(args.query, args.kb)
        return 0
    except QueryError as error:
        print(f"weknora-query: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
