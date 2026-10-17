---
description: "Enable local knowledge bases, knowledge_search, and @ mentions from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-knowledge-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle composes the [knowledge service](../knowledge/README.md), the [knowledge_search tool](../tool-knowledge/README.md), and the [knowledge base page](../client-ui-knowledge/README.md). Shipped profiles leave it disabled.

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

Open Plugins in the Web sidebar and enable Local knowledge bases. A Knowledge bases entry appears in the sidebar; create a base from folders or added files there, then mention it with `@` in a conversation or use Ask this knowledge base. The bundle keeps BM25 retrieval; set `retrieval: hybrid` on the `knowledge` row in the profile's `cordis.patch.yml` to add vectors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` adds the `knowledge`, `tool-knowledge`, and `ui-knowledge` rows and stores data under `dshHomePath('knowledge')`. Disabling the bundle removes the rows; stored definitions, indexes, and added files remain on disk.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge service](../knowledge/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [knowledge_search tool](../tool-knowledge/README.md#model-experience) that this bundle mounts.

#### KV Cache effect

Enabling the bundle adds one fixed prompt section and one tool schema, which changes the request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle icon awaits designer review.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
