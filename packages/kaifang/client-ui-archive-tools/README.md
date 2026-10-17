---
description: "Archive tool catalog in the sidebar with click-to-reference and an @ picker in the composer."
kind: "package-reference"
---

# @deepseek-ai/dsh-kaifang-client-ui-archive-tools

English | [中文](README.zh.md)

## Summary

Open **Archive tools** in the left sidebar, below **Plugins**, to see the archive tool catalog. Local tools are grouped into **Image processing** and **Document processing**; online tools follow. Click a card to return to the shown conversation with that tool referenced in the draft, or type `@` in the composer and pick a tool from the **Archive tools** group.

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

The Web bundle mounts this plugin by default. The catalog lists OCR text recognition, image to searchable PDF, AI archive cleanup, document polish, and the Demo test. A card click appends the tool's reference chip to the end of the shown conversation's draft and returns the keyboard to the composer. Without a shown conversation, the click starts one whose draft holds the tool's `@<tool id>` mention. While the draft is being submitted, the click leaves it unchanged and shows a notice in the composer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The plugin registers a `main` panel and a `sidebar.panellist` entry under the shared id `kaifang-archive-tools`, so the sidebar's own panel button selects the catalog. It also registers the `@` trigger source `kaifang-archive-tools` ahead of file and Session references. Its static lexicon decorates typed `@<tool id>` text, and its codec sends each chip as that mention. A card click finds the Session retained by the main view, inserts the chip through that Session's composer input, selects the Conversation panel, and focuses the composer on the next animation frame. Disposal removes the source, both slot entries, and any pending focus.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Input triggers](../../client/ui-input-trigger/README.md) — `@` sources, reference chips, and codecs.
- [Web Client](../../../docs/subsystems/web-client.md) — plugin composition and main-panel selection.

<a id="model-experience"></a>
## Model Experience

None, as this plugin only places reviewable `@<tool id>` mentions in the unsent draft; the user's submitted message carries them.

#### KV Cache effect

None; the plugin adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No tool implementations** — the catalog references tools by `@<tool id>` mention only; no Host package provides OCR, PDF conversion, archive cleanup, copy polish, or the online demo, so the model receives the mention without a matching tool.

<a id="dev-note"></a>
### Dev Note

None.
