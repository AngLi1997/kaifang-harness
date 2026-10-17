---
description: "Web page for local knowledge bases, the @ knowledge base menu, and mention chips."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-knowledge

English | [中文](README.zh.md)

## Summary

This browser plugin adds a Knowledge bases entry to the Web sidebar. Its page lists every local knowledge base with its indexing status and lets the user create, rename, re-index, and delete bases, choose folders, add files, and start a conversation that mentions a base. In any conversation, `@` lists knowledge bases beside files and sessions.

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

Enable the [knowledge bundle](../knowledge-bundle/README.md) in Plugins, then open Knowledge bases in the sidebar. New knowledge base asks for a name and folders: Choose folder opens the operating system's chooser on a local Host or an in-app folder browser otherwise, and an absolute path can be typed. Files lists indexed files; Add files copies files chosen in the file explorer into the base. Ask this knowledge base opens a new conversation in the current or most recent workspace whose draft starts with the base's chip. Typing `@` in the composer lists matching knowledge bases; picking one inserts the same chip, and the sent message shows it as a folder chip that opens this page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The plugin mounts the generated `knowledge` Remote contribution and follows the catalog stream once for its lifetime. The page receives the catalog through the injected `knowledgeCatalog` hook and every Host operation as a callback. The `@` source, user-text rule, and keyed `conversation.user.text.node` renderer use the Host's canonical `@[name](dsh-knowledge:id)` mention; the composer chip uses the folder appearance. The sidebar row uses order 2, directly below Archive tools and above Automation tasks.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge service](../knowledge/README.md)
- [knowledge_search tool](../tool-knowledge/README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the page manages knowledge bases and the composer only inserts reviewable mention chips into the unsent draft.

#### KV Cache effect

No direct effect; ordinary submission owns the message content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Added files are read into memory and sent as base64 in one request, so the upload limit stays small enough for one Remote message.
- Ask this knowledge base needs an existing workspace; without one, the workspace notice asks the user to choose a folder first.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
