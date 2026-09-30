import type { ApiStyle } from '../types.ts'

/**
 * 预设提供商（创建提供商时的默认值，选错了随时可以改）。
 *
 * 说明：
 * - `group` 只是给界面分组/搜索用，不影响请求。
 * - `note` 有值表示这个地址需要你自己核对（中转站换域名很频繁），或者有额外要求。
 * - baseURL 都写「到 /v1 为止」的形式；少数厂商路径不是 /v1（如智谱 v4、火山 v3），
 *   按官方文档原样写，程序会直接拼 /chat/completions。
 */
export type PresetGroup = 'officialIntl' | 'officialCn' | 'aggregatorIntl' | 'relayCn' | 'local'

export interface ProviderPreset {
  name: string
  baseURL: string
  apiStyle: ApiStyle
  group: PresetGroup
  note?: string
  /** 中文别名（只用于搜索，不显示） */
  aliases?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  /* ------------------------------ 国际官方 ------------------------------ */
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', apiStyle: 'anthropic', group: 'officialIntl' },
  {
    name: 'Google Gemini (OpenAI-compatible)', aliases: '谷歌 gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiStyle: 'openai',
    group: 'officialIntl',
  },
  { name: 'xAI Grok', baseURL: 'https://api.x.ai/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Mistral', baseURL: 'https://api.mistral.ai/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Cohere', baseURL: 'https://api.cohere.ai/compatibility/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Together AI', baseURL: 'https://api.together.xyz/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Fireworks AI', baseURL: 'https://api.fireworks.ai/inference/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'DeepInfra', baseURL: 'https://api.deepinfra.com/v1/openai', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Perplexity', baseURL: 'https://api.perplexity.ai', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Cerebras', baseURL: 'https://api.cerebras.ai/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'SambaNova', baseURL: 'https://api.sambanova.ai/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Novita AI', baseURL: 'https://api.novita.ai/v3/openai', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Hyperbolic', baseURL: 'https://api.hyperbolic.xyz/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Lambda Labs', baseURL: 'https://api.lambdalabs.com/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Nebius', baseURL: 'https://api.studio.nebius.com/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Chutes', baseURL: 'https://llm.chutes.ai/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'GitHub Models', baseURL: 'https://models.github.ai/inference', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1', apiStyle: 'openai', group: 'officialIntl' },
  {
    name: 'Hugging Face Router',
    baseURL: 'https://router.huggingface.co/v1',
    apiStyle: 'openai',
    group: 'officialIntl',
  },
  { name: 'AI21', baseURL: 'https://api.ai21.com/studio/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Upstage Solar', baseURL: 'https://api.upstage.ai/v1/solar', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Reka', baseURL: 'https://api.reka.ai/v1', apiStyle: 'openai', group: 'officialIntl' },
  { name: 'Writer', baseURL: 'https://api.writer.com/v1', apiStyle: 'openai', group: 'officialIntl' },
  {
    name: 'Azure OpenAI',
    baseURL: 'https://你的资源名.openai.azure.com/openai/v1',
    apiStyle: 'openai',
    group: 'officialIntl',
    note: '把「你的资源名」换成 Azure 资源；部署名当模型名用',
  },
  {
    name: 'Cloudflare Workers AI',
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/你的账户ID/ai/v1',
    apiStyle: 'openai',
    group: 'officialIntl',
    note: '需要填账户 ID，并加 Authorization 头（自定义请求头里填）',
  },
  {
    name: 'Databricks',
    baseURL: 'https://你的工作区.cloud.databricks.com/serving-endpoints',
    apiStyle: 'openai',
    group: 'officialIntl',
    note: '把「你的工作区」换成自己的；模型名用 endpoint 名',
  },
  { name: 'Voyage AI', baseURL: 'https://api.voyageai.com/v1', apiStyle: 'openai', group: 'officialIntl', note: '主要是向量模型' },

  /* ------------------------------ 国内官方 ------------------------------ */
  { name: 'DeepSeek', aliases: '深度求索', baseURL: 'https://api.deepseek.com/v1', apiStyle: 'openai', group: 'officialCn' },
  {
    name: 'Alibaba Qwen DashScope (CN)', aliases: '通义千问 通义 阿里百炼 百炼',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiStyle: 'openai',
    group: 'officialCn',
  },
  {
    name: 'Alibaba Qwen DashScope (intl)', aliases: '通义千问 通义 阿里百炼 百炼',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiStyle: 'openai',
    group: 'officialCn',
  },
  { name: 'Zhipu GLM (CN)', aliases: '智谱 清言 智谱清言', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiStyle: 'openai', group: 'officialCn' },
  { name: 'Zhipu GLM (z.ai)', aliases: '智谱 清言', baseURL: 'https://api.z.ai/api/paas/v4', apiStyle: 'openai', group: 'officialCn' },
  { name: 'Moonshot Kimi (CN)', aliases: '月之暗面 kimi 摩斯', baseURL: 'https://api.moonshot.cn/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'Moonshot Kimi (intl)', aliases: '月之暗面 kimi', baseURL: 'https://api.moonshot.ai/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'MiniMax (CN)', aliases: 'minimax 海螺', baseURL: 'https://api.minimax.chat/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'MiniMax (intl)', aliases: 'minimax 海螺', baseURL: 'https://api.minimax.io/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'Baidu Qianfan (OpenAI-compatible)', aliases: '百度 千帆 文心 文心一言', baseURL: 'https://qianfan.baidubce.com/v2', apiStyle: 'openai', group: 'officialCn' },
  { name: 'Tencent Hunyuan', aliases: '混元 腾讯', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', apiStyle: 'openai', group: 'officialCn' },
  {
    name: 'Volcano Ark (Doubao)', aliases: '豆包 火山 方舟 字节',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiStyle: 'openai',
    group: 'officialCn',
  },
  { name: 'iFlytek Spark (OpenAI-compatible)', aliases: '讯飞 星火', baseURL: 'https://spark-api-open.xf-yun.com/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'Baichuan', aliases: '百川', baseURL: 'https://api.baichuan-ai.com/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: '01.AI Yi', aliases: '零一万物', baseURL: 'https://api.lingyiwanwu.com/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'StepFun', aliases: '阶跃星辰 阶跃', baseURL: 'https://api.stepfun.com/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'SenseNova', aliases: '商汤 日日新', baseURL: 'https://api.sensenova.cn/compatible-mode/v1', apiStyle: 'openai', group: 'officialCn' },
  { name: 'Skywork', aliases: '昆仑万维 天工', baseURL: 'https://sky-api.singularity-ai.com/saas/api/v4', apiStyle: 'openai', group: 'officialCn', note: '路径按官方文档，可能变动' },
  { name: 'Tencent Cloud TokenHub', aliases: '腾讯 混元 tokenhub', baseURL: 'https://api.lkeap.cloud.tencent.com/v1', apiStyle: 'openai', group: 'officialCn', note: '混元正在往 TokenHub 迁移，请核对' },
  { name: 'SCNet Supercomputing', aliases: '国家超算 超算互联网', baseURL: 'https://api.scnet.cn/api/llm/v1', apiStyle: 'openai', group: 'officialCn', note: '请以官网文档为准' },

  /* --------------------------- 国际聚合 / 网关 --------------------------- */
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Vercel AI Gateway', baseURL: 'https://ai-gateway.vercel.sh/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Requesty', baseURL: 'https://router.requesty.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Anannas', baseURL: 'https://api.anannas.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Kluster', baseURL: 'https://api.kluster.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Featherless', baseURL: 'https://api.featherless.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Arli AI', baseURL: 'https://api.arliai.com/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Inference.net', baseURL: 'https://api.inference.net/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Parasail', baseURL: 'https://api.parasail.io/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'OpenPipe', baseURL: 'https://api.openpipe.ai/api/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Portkey', baseURL: 'https://api.portkey.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Helicone', baseURL: 'https://oai.helicone.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Unify AI', baseURL: 'https://api.unify.ai/v0', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Eden AI', baseURL: 'https://api.edenai.run/v2/llm', apiStyle: 'openai', group: 'aggregatorIntl', note: '请核对路径' },
  { name: 'AI/ML API', baseURL: 'https://api.aimlapi.com/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'NanoGPT', baseURL: 'https://nano-gpt.com/api/v1', apiStyle: 'openai', group: 'aggregatorIntl' },
  { name: 'Poe (OpenAI-compatible)', aliases: '兼容', baseURL: 'https://api.poe.com/v1', apiStyle: 'openai', group: 'aggregatorIntl', note: '需按其文档核对' },
  { name: 'Zuki Journey', baseURL: 'https://api.zukijourney.com/v1', apiStyle: 'openai', group: 'aggregatorIntl', note: '第三方社区站，地址多变' },
  { name: 'ElectronHub', baseURL: 'https://api.electronhub.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl', note: '地址多变，请核对' },
  { name: 'ShuttleAI', baseURL: 'https://api.shuttleai.com/v1', apiStyle: 'openai', group: 'aggregatorIntl', note: '地址多变，请核对' },
  { name: 'Mandrill', baseURL: 'https://api.mandrill.ai/v1', apiStyle: 'openai', group: 'aggregatorIntl', note: '地址多变，请核对' },

  /* ----------------------------- 国内中转站 ----------------------------- */
  { name: 'AiHubMix', baseURL: 'https://aihubmix.com/v1', apiStyle: 'openai', group: 'relayCn' },
  { name: '302.AI', baseURL: 'https://api.302.ai/v1', apiStyle: 'openai', group: 'relayCn' },
  { name: 'OhMyGPT', baseURL: 'https://api.ohmygpt.com/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'API2D', baseURL: 'https://openai.api2d.net/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'CloseAI', baseURL: 'https://api.openai-proxy.org/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'DMXAPI', baseURL: 'https://www.dmxapi.cn/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'Nonelinear', aliases: '非线智能', baseURL: 'https://api.nonelinear.com/v1', apiStyle: 'openai', group: 'relayCn', note: '同时支持 Anthropic / Gemini 原生协议' },
  { name: 'TokenRiver', aliases: '词云之河', baseURL: 'https://api.tokenriver.ai/v1', apiStyle: 'openai', group: 'relayCn', note: '请核对当前域名' },
  { name: 'V3 API', baseURL: 'https://api.v3.cm/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'GPTNB', baseURL: 'https://api.gptnb.ai/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'Yunwu API', aliases: '云雾', baseURL: 'https://api.yunwu.ai/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'UIUI API', baseURL: 'https://api.uiui.cc/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'DeepBricks', baseURL: 'https://api.deepbricks.ai/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'FoxCode', baseURL: 'https://api.foxcode.ai/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'ZiYu API', baseURL: 'https://api.ziyuapi.com/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'ChatAnywhere', baseURL: 'https://api.chatanywhere.tech/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'OpenAI-SB', baseURL: 'https://api.openai-sb.com/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'AIGC2D', baseURL: 'https://api.aigc2d.com/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'GeekAI', baseURL: 'https://api.geekai.pro/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'O3.Fan', baseURL: 'https://api.o3.fan/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'XiaoAi API', baseURL: 'https://api.xiaoai.plus/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'PoloAPI', baseURL: 'https://api.poloapi.com/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'Weelinking', baseURL: 'https://api.weelinking.com/v1', apiStyle: 'openai', group: 'relayCn', note: '地址多变，请核对' },
  { name: 'NodeSeek', aliases: '公益站', baseURL: 'https://api.nodeseek.ai/v1', apiStyle: 'openai', group: 'relayCn', note: '社区公益站，地址多变' },

  /* ---------------------------- 本地 / 自建 ---------------------------- */
  { name: 'Ollama (local)', aliases: '本地', baseURL: 'http://localhost:11434/v1', apiStyle: 'openai', group: 'local' },
  { name: 'LM Studio (local)', aliases: '本地', baseURL: 'http://localhost:1234/v1', apiStyle: 'openai', group: 'local' },
  { name: 'vLLM (local)', aliases: '本地', baseURL: 'http://localhost:8000/v1', apiStyle: 'openai', group: 'local' },
  { name: 'llama.cpp server (local)', aliases: '本地', baseURL: 'http://localhost:8080/v1', apiStyle: 'openai', group: 'local' },
  { name: 'Jan (local)', aliases: '本地', baseURL: 'http://localhost:1337/v1', apiStyle: 'openai', group: 'local' },
  { name: 'LocalAI (local)', aliases: '本地', baseURL: 'http://localhost:8080/v1', apiStyle: 'openai', group: 'local' },
  { name: 'Text Generation WebUI (local)', aliases: '本地', baseURL: 'http://localhost:5000/v1', apiStyle: 'openai', group: 'local' },
  { name: 'Xinference (local)', aliases: '本地', baseURL: 'http://localhost:9997/v1', apiStyle: 'openai', group: 'local' },
  { name: 'Open WebUI (local)', aliases: '本地', baseURL: 'http://localhost:3000/api/v1', apiStyle: 'openai', group: 'local' },
  { name: 'One API (self-hosted)', aliases: '自建 oneapi', baseURL: 'http://localhost:3000/v1', apiStyle: 'openai', group: 'local' },
  { name: 'New API (self-hosted)', aliases: '自建 newapi', baseURL: 'http://localhost:3000/v1', apiStyle: 'openai', group: 'local' },
  { name: 'FastChat (self-hosted)', aliases: '自建', baseURL: 'http://localhost:8000/v1', apiStyle: 'openai', group: 'local' },
  { name: 'OpenAI-compatible (custom)', aliases: '自定义 兼容', baseURL: 'https://example.com/v1', apiStyle: 'openai', group: 'local', note: '自己填 baseURL' },
]

/** 预设分组（界面里按这个顺序展示 / 分组） */
export const PRESET_GROUP_ORDER = ['officialIntl', 'officialCn', 'aggregatorIntl', 'relayCn', 'local'] as const
