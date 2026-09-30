# Contributing

Issues and pull requests are welcome.

## License of contributions

By contributing you agree that:

1. Your contribution is licensed under AGPL-3.0-or-later, the license of this project.
2. You keep your copyright, and you grant the project maintainer a perpetual,
   worldwide, royalty-free right to use, modify and **re-license** your contribution
   (for example to move the project to a different license later).

Only send code you wrote yourself, or code whose license allows the above.

## Before opening a pull request

- `cd web && npm run typecheck && npm test`
- `cd companion/src-tauri && cargo check`
- Keep changes focused; describe what the change does and how you tested it.

---

## 中文

欢迎提 issue 和 pull request。

**贡献许可**：提交即表示你同意

1. 你的贡献按本项目许可（AGPL-3.0-or-later）提供；
2. 你保留版权，同时授予项目维护者永久、全球、免费的**再许可**权利
   （例如将来把项目换到别的许可）。

只提交你自己写的代码，或提交其许可允许上述用法的代码。

**提 PR 前**：`cd web && npm run typecheck && npm test`、`cd companion/src-tauri && cargo check`；
改动尽量聚焦，并说明改了什么、怎么验证的。
