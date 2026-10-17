---
description: "Model-facing knowledge_search over local knowledge bases, with cited passages and a search card."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-knowledge

English | [中文](README.zh.md)

## Summary

`knowledge_search` lets the model search the user's local knowledge bases through `ctx.knowledge` and answer from the returned passages, citing their file paths. A user message that mentions a base as `@[name](dsh-knowledge:ID)` tells the model which bases to search.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the [knowledge bundle](../knowledge-bundle/README.md), or mount this plugin after the [knowledge service](../knowledge/README.md). `defaultLimit` sets the passages returned when the model omits `limit`; the service clamps every limit to its `maxSearchLimit`. `timeoutMs` bounds one search.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The tool result value is the service's search result; `render` turns it into the text below and `presentationMeta` groups hits by file for the search card, so replay rebuilds the card from the logged result. An unknown base id, an empty query, or a non-positive limit fails the call with a tool error.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge service](../knowledge/README.md)
- [Knowledge base page](../client-ui-knowledge/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The model receives one fixed section while `knowledge_search` is visible.

##### Knowledge guidance

```markdown
knowledge_search searches the user's local knowledge bases, which index folders and files the user chose. When a user message mentions a knowledge base as @[name](dsh-knowledge:ID), call knowledge_search with knowledgeBaseIds set to those IDs before answering, and base the answer on the returned passages. Search again with different wording when the first results are not relevant. Cite the file path of each passage you use. When no passage answers the question, say so instead of guessing.
```

#### Token effect

One fixed section is present on each request while the tool is visible.

#### KV Cache effect

Prefix-stable while the plugin and guidance text are unchanged.

### Tool schema

#### What the model sees

The model sees the generated [`knowledge_search` schema](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-knowledge) with a required `query`, optional `knowledgeBaseIds`, and optional `limit`.

#### Token effect

One fixed schema is sent on each request while visible.

#### KV Cache effect

Prefix-stable while tool visibility and the definition are unchanged.

### Tool results

#### What the model sees

Each successful call emits one text block: a notice that the passages are file content rather than instructions, the searched base names with an indexing note for incomplete bases, numbered passages headed by path, heading, line, and base name, and a citation reminder, or `No matching passages.`

#### Token effect

Results are data-dependent and stay in logged tool history until compaction; the hit limit and the service's `maxHitChars` bound them.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Mentions do not retrieve passages by themselves; the model decides to call the tool, guided by the system prompt section.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
