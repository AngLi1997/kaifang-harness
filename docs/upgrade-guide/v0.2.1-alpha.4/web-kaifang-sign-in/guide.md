---
kind: upgrade-guide
description: "The Web app opens on a KaifangLab sign-in page, and every sign-in entry signs in to KaifangLab instead of the DeepSeek Platform."
---

# The Web app requires a KaifangLab sign-in

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.4, the Web app opened the workspace directly, and the sidebar launcher, Account settings, and model onboarding signed in to the DeepSeek Platform. In the next release, the `@deepseek-ai/dsh-web-app` bundle sets `kaifangSignIn: true` on the `ui-settings-account` row: the Web app covers the workspace with a KaifangLab sign-in page until an account signs in, and every sign-in entry signs in to KaifangLab. Desktop already signed in through its welcome window and now routes every sign-in entry there. Web users and deployments that compose the Web app bundle are affected.

## Migration

1. Open the Web app, choose Settings on the sign-in page, and enter the KaifangLab system URL, sign-in page URL, and authorization code. One-click sign-in needs the Web app opened at `127.0.0.1` or `localhost`; password sign-in needs the KaifangLab server to accept the Web app's origin through CORS.
2. To keep the previous behavior, add an overlay or home patch that sets the option to false:

   ```yaml
   - id: ui-settings-account
     config:
       kaifangSignIn: false
   ```

3. Confirm by reloading the Web app: with the option true the sign-in page appears until you sign in, and the sidebar launcher then shows the KaifangLab nickname; with the option false the workspace opens directly.
