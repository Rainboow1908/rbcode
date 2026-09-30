# OreUI 控件样式（vendored）

「OreUI（我的世界）」主题下按钮用的样式与字体，**直接取自上游项目**，不是自己仿写的：

- 上游：<https://github.com/Spectrollay-OreUI/OreUI>
- 提交：`8ff5dd04ef22881cc1015c3b3faa759382410f35`（2026-09-06，tag `2026090601`）
- 许可：MIT（© 2020 Spectrollay）—— 保留在各文件顶部的版权声明里

## 文件对照

| 这里的文件 | 上游路径 | 改动 |
| --- | --- | --- |
| `colors.css` | `src/components/design/colors/style.css` | 无（逐字复制） |
| `button.css` | `src/components/controls/button/style.css` | 无（逐字复制） |
| `NotoSans-Bold.ttf` | `src/assets/fonts/NotoSans-Bold.ttf` | 无 |
| `fonts.css` | — | 本仓库补写：给上面这个字体加 `@font-face`（上游该声明在 `design/typography/style.css`，那份还带了 Mojang 的 Minecraft 字体，未收录） |
| `oreui.css` | — | 本仓库补写：把上面几份 `@import` 进来，并把上游按钮暴露的尺寸变量调成我们界面的紧凑尺寸 |

## 上游怎么用按钮

上游的组件 `OreUIButton`（`src/components/controls/button/index.js`）最终渲染出的结构就是：

```html
<button class="oreui_btn_inner size_middle status_green">文字</button>
```

外观全部来自 `button.css`。本仓库在 `src/components/OreButton.tsx` 里复现同一个结构
（样式仍然只来自这份 `button.css`），于是按钮的底色 / 凿边 / 按下手感 / 字体与上游一致。

## 更新方式

```bash
git clone --depth 1 https://github.com/Spectrollay-OreUI/OreUI.git
# 复制 colors.css / button.css / NotoSans-Bold.ttf 覆盖本目录（保持逐字复制）
# 更新本文件里的提交号
```

> 整个上游库编译出来约 9.5 MB CSS（里面把 8 个字体内联成了 base64），
> 主题用不到那么多，所以这里只收按钮真正依赖的几份：设计令牌 + 按钮样式 + 按钮字体。
