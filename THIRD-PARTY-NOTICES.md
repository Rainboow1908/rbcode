# Third-party notices

RB Code itself is licensed under AGPL-3.0-or-later (see [LICENSE](LICENSE)).
Everything below keeps its own license; the notices are kept here as required by those licenses.

## Bundled in this repository

| Component | License | Source |
| --- | --- | --- |
| OreUI (theme styles and button component, vendored under `web/src/oreui/`) | MIT | https://github.com/Spectrollay-OreUI/OreUI |
| Noto Sans Bold (font used by OreUI buttons) | SIL OFL 1.1 | https://github.com/notofonts/noto-fonts |
| React / React DOM | MIT | https://github.com/facebook/react |
| xterm.js | MIT | https://github.com/xtermjs/xterm.js |
| MathJax | Apache-2.0 | https://github.com/mathjax/MathJax-src |
| mermaid | MIT | https://github.com/mermaid-js/mermaid |
| highlight.js | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| pdf.js | Apache-2.0 | https://github.com/mozilla/pdf.js |
| react-markdown | MIT | https://github.com/remarkjs/react-markdown |
| remark-math / rehype-mathjax | MIT | https://github.com/remarkjs/remark-math |
| remark-gfm | MIT | https://github.com/remarkjs/remark-gfm |
| rehype-highlight | MIT | https://github.com/rehypejs/rehype-highlight |
| zod | MIT | https://github.com/colinhacks/zod |
| Tailwind CSS | MIT | https://github.com/tailwindlabs/tailwindcss |
| Vite | MIT | https://github.com/vitejs/vite |
| Tauri (desktop companion shell) | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |

The full text of the SIL Open Font License for Noto Sans is in
[`web/src/oreui/OFL.txt`](web/src/oreui/OFL.txt).

## Shipped with the clients (not in this repository)

The desktop installer and the Android APK bundle additional components. Distributing
those binaries means distributing the components below, so their corresponding source
is available at the addresses listed.

| Component | License | Source |
| --- | --- | --- |
| proot (Linux environment inside the Android app) | GPL-2.0 | https://github.com/termux/proot |
| Ubuntu Base (Linux root filesystem inside the Android app) | Various open-source licenses | https://cdimage.ubuntu.com/ubuntu-base/ |
| Termux packages (libtalloc, libandroid-shmem, termux-exec) | GPL-3.0 and others | https://github.com/termux |

## Music API

The Music panel uses a third-party API by default:

```
Written by GD Studio. License: CC BY-NC 4.0
若使用本站提供的API，请注明出处“GD音乐台(music.gdstudio.xyz)”
```

- Source: GD音乐台 (https://music.gdstudio.xyz)
- License: CC BY-NC 4.0 — **non-commercial use only**
- The endpoint can be replaced in Settings → Music → API base URL. If you use this
  project commercially, point it at your own or a licensed endpoint.

## Trademarks

Minecraft and Ore UI are trademarks of Mojang Studios. This project is not affiliated
with or endorsed by Mojang Studios; the OreUI styling is used under the MIT license of
the third-party implementation listed above.
