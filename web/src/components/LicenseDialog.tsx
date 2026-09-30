import Dialog from './Dialog.tsx'
import OreButton from './OreButton.tsx'
import { useT } from '../lib/i18n.ts'

/**
 * 版权与许可。
 *
 * 这里是**法律原文**，按惯例保留英文原稿，不做翻译：
 *   - 本项目自身的许可声明（AGPL-3.0-or-later 的标准 NOTICE）
 *   - 随本项目一起分发 / 引用的第三方组件，逐条给出许可与引用地址
 * 新增依赖时，记得同步下面的 THIRD_PARTY 表。
 */

/** 本项目：AGPL-3.0-or-later 标准声明（英文原稿，按段落展示） */
const SELF_NOTICE: string[] = [
  'RB Code — AI coding agent in the browser\nCopyright (C) 2026 RB Code',
  'This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.',
  'This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.',
  'You should have received a copy of the GNU Affero General Public License along with this program. If not, see https://www.gnu.org/licenses/.',
]

const SELF_LICENSE = 'AGPL-3.0-or-later'
const SELF_URL = 'https://www.gnu.org/licenses/agpl-3.0.txt'
/** 本项目的源码地址（AGPL 第 13 条的「对应源码」入口） */
const SELF_SOURCE = 'https://github.com/Rainboow1908/rbcode'
/** 音乐面板默认接口的出处（按要求注明） */
const MUSIC_API = 'https://music.gdstudio.xyz'

/** 第三方组件：名称 / 许可 / 引用地址 */
const THIRD_PARTY: { name: string; license: string; url: string }[] = [
  { name: 'OreUI（界面风格与按钮样式，vendored）', license: 'MIT', url: 'https://github.com/Spectrollay-OreUI/OreUI' },
  { name: 'Noto Sans（OreUI 按钮字体）', license: 'SIL OFL 1.1', url: 'https://github.com/notofonts/noto-fonts' },
  { name: 'GD音乐台（音乐面板默认接口）', license: 'CC BY-NC 4.0', url: MUSIC_API },
  { name: 'React / React DOM', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'xterm.js（终端渲染）', license: 'MIT', url: 'https://github.com/xtermjs/xterm.js' },
  { name: 'MathJax（数学公式）', license: 'Apache-2.0', url: 'https://github.com/mathjax/MathJax-src' },
  { name: 'mermaid（流程图）', license: 'MIT', url: 'https://github.com/mermaid-js/mermaid' },
  { name: 'highlight.js（代码高亮）', license: 'BSD-3-Clause', url: 'https://github.com/highlightjs/highlight.js' },
  { name: 'pdf.js（PDF 预览）', license: 'Apache-2.0', url: 'https://github.com/mozilla/pdf.js' },
  { name: 'react-markdown', license: 'MIT', url: 'https://github.com/remarkjs/react-markdown' },
  { name: 'remark-math / rehype-mathjax', license: 'MIT', url: 'https://github.com/remarkjs/remark-math' },
  { name: 'remark-gfm', license: 'MIT', url: 'https://github.com/remarkjs/remark-gfm' },
  { name: 'rehype-highlight', license: 'MIT', url: 'https://github.com/rehypejs/rehype-highlight' },
  { name: 'zod', license: 'MIT', url: 'https://github.com/colinhacks/zod' },
  { name: 'Tailwind CSS', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss' },
  { name: 'Vite', license: 'MIT', url: 'https://github.com/vitejs/vite' },
  { name: 'Tauri（桌面执行器外壳）', license: 'MIT / Apache-2.0', url: 'https://github.com/tauri-apps/tauri' },
]

/** 安装包里内置的第三方组件（不在源码仓库里，随客户端分发） */
const BUNDLED: { name: string; license: string; url: string }[] = [
  { name: 'proot（安卓版内置 Linux 环境）', license: 'GPL-2.0', url: 'https://github.com/termux/proot' },
  { name: 'Ubuntu Base（安卓版内置的 Linux 根文件系统）', license: 'GPL 等多种开源许可', url: 'https://cdimage.ubuntu.com/ubuntu-base/' },
  { name: 'Termux 依赖包（libtalloc / libandroid-shmem / termux-exec）', license: 'GPL-3.0 等', url: 'https://github.com/termux' },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function LicenseDialog({ open, onClose }: Props) {
  const t = useT()
  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <span className="text-sm font-medium text-neutral-100">
          {t('版权与许可', 'Copyright & licences', '版權與授權')}
        </span>
      </div>

      <div className="max-h-[65vh] overflow-y-auto px-4 py-3">
        <div className="text-xs font-medium text-neutral-200">
          {t('本软件', 'This software', '本軟體')}
        </div>
        <div className="mt-1.5 space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3 text-[11px] leading-relaxed text-neutral-400">
          {SELF_NOTICE.map((paragraph) => (
            <p key={paragraph.slice(0, 24)} className="whitespace-pre-wrap">
              {paragraph}
            </p>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-neutral-500">
          {SELF_LICENSE} ·{' '}
          <a
            href={SELF_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-amber-400 underline decoration-dotted hover:text-amber-300"
          >
            {SELF_URL}
          </a>
        </p>

        <div className="mt-4 text-xs font-medium text-neutral-200">
          {t('第三方组件与引用地址', 'Third-party components and their sources', '第三方組件與引用位址')}
        </div>
        <ul className="mt-1.5 space-y-1.5">
          {THIRD_PARTY.map((item) => (
            <li key={item.url + item.name} className="text-[11px] leading-relaxed">
              <span className="text-neutral-300">{item.name}</span>
              <span className="text-neutral-600"> · {item.license} · </span>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-amber-400 underline decoration-dotted hover:text-amber-300"
              >
                {item.url}
              </a>
            </li>
          ))}
        </ul>

        <div className="mt-4 text-xs font-medium text-neutral-200">
          {t('随客户端一起分发的组件', 'Components shipped with the clients', '隨用戶端一起分發的組件')}
        </div>
        <ul className="mt-1.5 space-y-1.5">
          {BUNDLED.map((item) => (
            <li key={item.url + item.name} className="text-[11px] leading-relaxed">
              <span className="text-neutral-300">{item.name}</span>
              <span className="text-neutral-600"> · {item.license} · </span>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-amber-400 underline decoration-dotted hover:text-amber-300"
              >
                {item.url}
              </a>
            </li>
          ))}
        </ul>

        <div className="mt-4 text-xs font-medium text-neutral-200">
          {t('音乐接口出处', 'Music API attribution', '音樂介面出處')}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">
          音乐接口由 GD音乐台（music.gdstudio.xyz）提供 · Written by GD Studio · License: CC BY-NC 4.0
          <br />
          {t(
            '该接口仅限非商业用途；要商用请把它换成你自建或已获授权的接口（设置 → 音乐 → API 地址）。',
            'That API is for non-commercial use only; for commercial use point the app at your own or licensed endpoint (Settings → Music → API base URL).',
            '該介面僅限非商業用途；要商用請把它換成你自建或已獲授權的介面（設定 → 音樂 → API 位址）。',
          )}
        </p>

        <div className="mt-4 text-xs font-medium text-neutral-200">
          {t('本项目的源码', 'Source code', '本專案的原始碼')}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">
          {t(
            '本软件的完整源码在这里，可以自由获取（AGPL 第 13 条）：',
            'The complete source of this software is available here (AGPL section 13):',
            '本軟體的完整原始碼在這裡，可以自由取得（AGPL 第 13 條）：',
          )}
          <br />
          <a
            href={SELF_SOURCE}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all text-amber-400 underline decoration-dotted hover:text-amber-300"
          >
            {SELF_SOURCE}
          </a>
        </p>

        <p className="mt-4 text-[11px] leading-relaxed text-neutral-500">
          {t(
            '各第三方组件版权归其各自作者所有，均按其许可条款使用。',
            'All third-party components remain the property of their authors and are used under their respective licences.',
            '各第三方組件版權歸其各自作者所有，均按其授權條款使用。',
          )}
        </p>
      </div>

      <div className="flex justify-end border-t border-neutral-800 px-4 py-3">
        <OreButton
          status="green"
          onClick={onClose}
          className="rounded-md px-3.5 py-1.5 text-xs font-medium text-white"
        >
          {t('知道了', 'Close', '知道了')}
        </OreButton>
      </div>
    </Dialog>
  )
}
