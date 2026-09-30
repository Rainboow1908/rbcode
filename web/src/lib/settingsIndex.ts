// 由 scripts/build-settings-index.mjs 生成：设置页每一条设置项（分组 + 标题 + 说明摘要）。
// 设置页搜索用它命中「具体设置项」，改完 SettingsPage 记得重跑那个脚本。
export interface SettingIndexEntry {
  section: string
  title: string
  desc: string
}

export const SETTINGS_INDEX: SettingIndexEntry[] = [
  { section: 'general', title: "兼容导入", desc: "打开项目时，可以把旧工具（如 .reasonix）留下的对话导入进来；原文件只读。" },
  { section: 'general', title: "默认权限", desc: "" },
  { section: 'general', title: "上下文窗口", desc: "模型一次能记住多少内容。不确定就保持默认值。" },
  { section: 'general', title: "压缩触发阈值", desc: "" },
  { section: 'general', title: "压缩保留条数", desc: "总结时最近几条保持原文。留得多更不容易忘事，也更占空间。" },
  { section: 'general', title: "单轮最大工具调用次数", desc: "一轮回答里模型最多连续调用多少次工具。填 0 = 不限（一直干到它自己做完），适合长任务；不确定就先用默认值。" },
  { section: 'general', title: "审批等待时长", desc: "每次要你确认的操作，等这么多秒还没答复就自动拒绝。填 0 = 不限（一直等你）。" },
  { section: 'general', title: "启用重复内容检测", desc: "关掉后不再自动停止（模型重复输出也不会被打断）。" },
  { section: 'general', title: "检测范围", desc: "看哪些输出：回答正文 / 思考过程 / 全部（连工具参数一起看）。" },
  { section: 'general', title: "重复阈值", desc: "同一段内容连续出现几次就算异常。越小越灵敏，也越容易误判。" },
  { section: 'general', title: "最小重复单元", desc: "多长的一段才算「一段内容」（太短的不算，免得把标点、缩进当成卡带）。" },
  { section: 'general', title: "温度 temperature", desc: "回答的随机程度：越低越稳，越高越有创意。留空 = 服务商默认值。" },
  { section: 'general', title: "核采样 top_p", desc: "和「温度」二选一调整即可。留空 = 默认值。" },
  { section: 'general', title: "最大输出 token", desc: "一条回复的最大长度。留空 = 服务商默认值。" },
  { section: 'general', title: "思考强度", desc: "" },
  { section: 'general', title: "默认搜索源", desc: "搜索默认用哪个引擎；「自动」由程序挑。需要本机执行器。" },
  { section: 'general', title: "代理", desc: "搜索与抓网页走本机代理（例如 Clash 的 127.0.0.1:7897）。留空 = 直连。" },
  { section: 'appearance', title: "主题", desc: "切换后立即生效，随设置保存在本机浏览器。OreUI 是《我的世界》基岩版的界面风格（方角、凿边按钮 + 原版绿）。" },
  { section: 'appearance', title: "颜色", desc: "界面强调色。「默认」用主题自带配色。" },
  { section: 'appearance', title: "悬浮窗", desc: "一个置顶小窗：随时看模型的状态 / 决定 / 思考 / 回答，也能在里面审批和插话。需要 Chrome / Edge 116 以上；关掉小窗会自动把这个开关关掉。" },
  { section: 'appearance', title: "思考过程默认展开", desc: "开启后，模型返回的思考内容默认展开；关闭则折叠成一行，点击再展开。" },
  { section: 'appearance', title: "语言", desc: "界面语言，立即生效。" },
  { section: 'appearance', title: "界面布局", desc: "换一种排版：与主题配色互不影响，可以随意搭配。" },
  { section: 'appearance', title: "扁平控件", desc: "隐藏界面上的边框，改由鼠标悬浮时的轻微底色变化来提示。" },
  { section: 'appearance', title: "过程显示", desc: "运行时显示多少过程：全部 / 紧凑（收成一行摘要）/ 只显示最终回答。" },
  { section: 'statusbar', title: "显示状态栏", desc: "关掉就不再显示底部这条横栏（两套布局都不显示）。" },
  { section: 'statusbar', title: "显示文字", desc: "打开后状态栏显示「文字 + 图标」，更好辨认；关掉则只显示图标，更省地方。" },
  { section: 'voice', title: "语音输入", desc: "输入框旁显示麦克风：点一下开始，再点一下结束。" },
  { section: 'voice', title: "朗读回答", desc: "每条回答下方显示小喇叭：点一下朗读，再点一下停止。" },
  { section: 'voice', title: "自动朗读新回答", desc: "默认关闭；打开后自动朗读每轮的最终回答。" },
  { section: 'voice', title: "朗读速度", desc: "1 倍为正常语速。" },
  { section: 'voice', title: "朗读音色", desc: "「自动」按回答文字的语言选音色。" },
  { section: 'voice', title: "音色分组方式", desc: "音色列表的分类方式。" },
  { section: 'sound', title: "启用提示音", desc: "关闭后所有事件都不再响。" },
  { section: 'sound', title: "音量", desc: "对所有提示音生效。" },
  { section: 'music', title: "音乐源", desc: "搜索用哪些音乐来源；「自动」会合并多个来源。" },
  { section: 'music', title: "API 地址", desc: "留空 = 内置接口，也可以填自建地址。" },
  { section: 'music', title: "音质", desc: "优先请求的音质，实际以音源为准（740 = 无损，999 = 更高解析）。" },
  { section: 'providers', title: "提供商", desc: "有 100+ 预设（官方 / 聚合 / 中转 / 本地），可直接搜名字或型号。" },
  { section: 'providers', title: "名称", desc: "" },
  { section: 'providers', title: "接口风格", desc: "" },
  { section: 'providers', title: "接口地址", desc: "服务商给的接口地址，一般以 /v1 结尾。" },
  { section: 'providers', title: "API Key", desc: "" },
  { section: 'providers', title: "连接测试", desc: "用当前地址与 Key 请求一次模型列表，只验证连通性。" },
  { section: 'providers', title: "模型列表", desc: "" },
  { section: 'providers', title: "最大 token 字段名", desc: "高级项：新版 OpenAI 推理模型用 max_completion_tokens，其他多为 max_tokens。不确定就别改。" },
  { section: 'providers', title: "系统提示词角色", desc: "高级项：老接口用 system，新接口用 developer。不确定就别改。" },
  { section: 'providers', title: "请求流式返回 usage", desc: "高级项：关掉后不再请求用量统计。第三方中转报错时再关。" },
  { section: 'providers', title: "发送采样参数", desc: "高级项：关掉后不发送温度 / top_p。推理模型报错时再关。" },
  { section: 'providers', title: "额外请求体（JSON）", desc: "高级项：额外传给服务商的 JSON 参数。不懂就留空。" },
  { section: 'backend', title: "当前连接", desc: "" },
  { section: 'backend', title: "下载客户端", desc: "手机版 App 自带本机后端；电脑端执行器让网页能读写整机文件、跑命令、操作屏幕。" },
  { section: 'backend', title: "打开项目时优先使用", desc: "会话里也可以随时用顶栏的后端徽章切换，两种方式共用同一份项目数据。" },
  { section: 'backend', title: "本机执行器配对令牌", desc: "在本机执行器窗口点「复制」，粘贴保存即可。" },
  { section: 'mcp', title: "内置浏览器", desc: "让模型自己开网页（登录、点按、截图）。自带内核首次约需 150MB，也可用系统已装的浏览器。" },
  { section: 'mcp', title: "无界面模式", desc: "浏览器在后台跑，不弹窗口。关掉会弹出真的浏览器窗口 —— 需要你手动登录或过验证码时很有用。" },
  { section: 'mcp', title: "检测", desc: "点一下启动该服务并列出工具（首次较慢）。自定义服务第一次要用它激活。" },
  { section: 'computer', title: "启用 Computer use", desc: "关掉后 computer_use 工具会直接拒绝（模型也不会看到它）。" },
  { section: 'computer', title: "截图宽度上限", desc: "给模型的截图大小。太大更慢更贵，太小点不准。默认 1280 多数够用。" },
  { section: 'advanced', title: "自定义系统提示词", desc: "替换内置的行为设定；建议先导出备份。" },
  { section: 'data', title: "导出设置", desc: "把当前设置（含服务商、密钥、提示词）存成文件备份。" },
  { section: 'data', title: "导入设置", desc: "从备份文件恢复设置，会整体覆盖当前设置。" },
  { section: 'data', title: "清空会话列表缓存", desc: "" },
  { section: 'data', title: "清空项目列表", desc: "" },
  { section: 'data', title: "恢复出厂设置", desc: "重置全部设置项为默认值（不影响项目与会话数据）。" },
  { section: 'data', title: "版本", desc: "" },
  { section: 'data', title: "版权与许可", desc: "本软件的版权声明与用到的第三方组件" },
  { section: 'data', title: "当前后端", desc: "" },
  { section: 'data', title: "后端服务", desc: "检查云端服务是否在线。" },
  { section: 'data', title: "系统通知", desc: "" },
]

/** 在索引里找匹配的设置项（标题或说明包含关键词，忽略大小写） */
export function matchSettings(query: string, limit = 40): SettingIndexEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits = SETTINGS_INDEX.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) || entry.desc.toLowerCase().includes(needle),
  )
  // 标题命中排在说明命中前面
  hits.sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(needle) ? 0 : 1
    const bTitle = b.title.toLowerCase().includes(needle) ? 0 : 1
    return aTitle - bTitle
  })
  return hits.slice(0, limit)
}
