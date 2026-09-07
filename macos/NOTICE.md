# Notices

Codex Dynamic Skin System is an unofficial customization project. It is not affiliated with, endorsed by, or sponsored by OpenAI.

## Software and artwork

The MIT license applies to the software source and the abstract demo artwork at `macos/assets/portal-hero.png`. It does not grant rights to OpenAI trademarks, official application binaries, or third-party media imported by users.

`preset-gothic-void-crusade/background.jpg` was contributed by `seansong-ideogram` for inclusion in the upstream MIT-licensed theme project. It is the only bundled showcase preset. Users remain responsible for rights to media they import.

## Runtime

The macOS package does not redistribute Node.js. It uses the Node.js executable already signed and bundled inside the user's official Codex desktop application.

The Windows installer redistributes `node.exe` and `LICENSE` from the pinned official Node.js v22.23.1 win-x64 archive after verifying its SHA-256. The Node.js license is installed at `payload/runtime/node/LICENSE`.

## Inno Setup Simplified Chinese messages

The Windows installer uses the Simplified Chinese messages file from the official Inno Setup source tag `is-6_7_1`, maintained by Zhenghan Yang and distributed under the Inno Setup License. The full license is included in the source tree at `windows/installer/languages/Inno-Setup-License.txt` and installed at `licenses/Inno-Setup-License.txt`.

## Security model

The injector uses Chromium DevTools Protocol on loopback only and does not modify `app.asar`. Treat an active local debugging port as sensitive.
