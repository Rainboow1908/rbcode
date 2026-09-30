//! 音乐面板的后端：代理第三方音乐 API + 把整首歌取回来。
//!
//! 为什么放在本机执行器里：
//!   - 浏览器直接调第三方音乐 API 会被 CORS 拦；
//!   - 「音乐播放工具只能通过本机执行器使用」是明确的产品要求。
//!
//! 上游默认用 `music-api.gdstudio.xyz`（社区聚合接口）。它是第三方服务、曲库来自各家
//! 音乐平台，能不能用/合不合规由使用者自己判断；设置里可以把 base 换成自建实例。

use std::io::Read;

use serde_json::{json, Value};

use crate::web;

/// 默认的第三方音乐 API（设置里可换成自建实例）
pub const DEFAULT_BASE: &str = "https://music-api.gdstudio.xyz/api.php";

/// 允许的 types —— 别把它变成任意 URL 的开放代理
const ALLOWED_TYPES: [&str; 4] = ["search", "url", "pic", "lyric"];
/// 文档里列出的音乐源（具体哪个能用由上游决定，不支持时会回 detail）
const ALLOWED_SOURCES: [&str; 10] = [
    "netease", "tencent", "kuwo", "tidal", "qobuz", "joox", "bilibili", "apple", "ytmusic", "spotify",
];
/// 允许的音质（740 = 16bit 无损，999 = 24bit 无损）
const ALLOWED_BR: [u64; 5] = [128, 192, 320, 740, 999];
/// 允许的封面尺寸
const ALLOWED_PIC_SIZE: [u64; 2] = [300, 500];
/// 单次下载上限（base64 之后还要更大，别把内存吃爆）
const MAX_DOWNLOAD_BYTES: usize = 40 * 1024 * 1024;
/// 封面图上限（封面都很小，别让上游拿它当大文件通道）
const MAX_COVER_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_SOURCE: &str = "netease";

/* ---------------------------------- 参数解析 ---------------------------------- */

fn text_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn number_param(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|value| {
        if let Some(number) = value.as_u64() {
            return Some(number);
        }
        // 前端有时候会把数字当字符串传
        value.as_str()?.trim().parse::<u64>().ok()
    })
}

fn proxy_param(params: &Value) -> Option<String> {
    text_param(params, "proxy")
}

/* ----------------------------------- 请求 ----------------------------------- */

/// 把参数拼成上游 URL（纯函数，方便单测）
pub fn build_url(params: &Value) -> Result<String, String> {
    let base = text_param(params, "base").unwrap_or_else(|| DEFAULT_BASE.to_string());
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("音乐 API 地址必须是 http/https".to_string());
    }

    let types = text_param(params, "types").ok_or("缺少 types 参数")?;
    if !ALLOWED_TYPES.contains(&types.as_str()) {
        return Err(format!("不支持的 types：{types}"));
    }

    // 允许 "netease_album" 这种「取专辑曲目」的写法
    let source = text_param(params, "source").unwrap_or_else(|| DEFAULT_SOURCE.to_string());
    let bare = source.split('_').next().unwrap_or("").to_string();
    if !ALLOWED_SOURCES.contains(&bare.as_str()) {
        return Err(format!("不支持的音乐源：{source}"));
    }

    let mut url = format!(
        "{base}?types={}&source={}",
        web::encode_query(&types),
        web::encode_query(&source)
    );
    if let Some(id) = text_param(params, "id") {
        url.push_str(&format!("&id={}", web::encode_query(&id)));
    }
    if let Some(name) = text_param(params, "name") {
        url.push_str(&format!("&name={}", web::encode_query(&name)));
    }
    if let Some(count) = number_param(params, "count") {
        url.push_str(&format!("&count={}", count.clamp(1, 50)));
    }
    if let Some(pages) = number_param(params, "pages") {
        url.push_str(&format!("&pages={}", pages.clamp(1, 100)));
    }
    if let Some(br) = number_param(params, "br") {
        let br = if ALLOWED_BR.contains(&br) { br } else { 320 };
        url.push_str(&format!("&br={br}"));
    }
    if let Some(size) = number_param(params, "size") {
        let size = if ALLOWED_PIC_SIZE.contains(&size) { size } else { 300 };
        url.push_str(&format!("&size={size}"));
    }
    Ok(url)
}

/// 发一次请求，**4xx/5xx 也把 body 带回来** —— 上游用 `{"detail": "..."}` 说明原因
fn fetch_text(url: &str, proxy: Option<&str>) -> Result<(u16, String), String> {
    let request = web::agent(proxy)?
        .get(url)
        .set("Accept", "application/json, */*");
    match request.call() {
        Ok(response) => Ok((response.status(), response.into_string().unwrap_or_default())),
        Err(ureq::Error::Status(code, response)) => {
            Ok((code, response.into_string().unwrap_or_default()))
        }
        Err(err) => Err(format!("请求音乐 API 失败：{err}")),
    }
}

/* ---------------------------------- RPC 入口 ---------------------------------- */

/// `music.api`：`{ base?, types, source?, id?, name?, count?, pages?, br?, size?, proxy? }`
///
/// 原样把上游 JSON 放回 `data` 里（search / url / pic / lyric 四种）。
pub fn music_api(params: &Value) -> Result<Value, String> {
    let url = build_url(params)?;
    let proxy = proxy_param(params);
    let (status, body) = fetch_text(&url, proxy.as_deref())?;

    let data: Value =
        serde_json::from_str(&body).unwrap_or_else(|_| json!({ "raw": body.chars().take(400).collect::<String>() }));

    if !(200..300).contains(&status) {
        let detail = data
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("上游返回了错误");
        return Err(format!("{detail}（HTTP {status}）"));
    }
    Ok(json!({ "data": data }))
}

/// `music.download`：`{ base?, source?, id, br?, name?, proxy? }`
///
/// 先解析直链（types=url），再把整首歌取回来，base64 交给前端触发「浏览器默认下载」。
pub fn music_download(params: &Value) -> Result<Value, String> {
    let id = text_param(params, "id").ok_or("缺少 id 参数")?;
    let proxy = proxy_param(params);

    // 复用 build_url：把 types 换成 url 就是「取直链」
    let mut direct = params.clone();
    if let Some(object) = direct.as_object_mut() {
        object.insert("types".to_string(), json!("url"));
        object.remove("size");
    }
    let url = build_url(&direct)?;
    let (status, body) = fetch_text(&url, proxy.as_deref())?;
    let data: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let detail = data
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("上游返回了错误");
        return Err(format!("{detail}（HTTP {status}）"));
    }
    let direct_url = data
        .get("url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("这首歌拿不到直链（可能没版权 / 需要会员）")?
        .to_string();

    let (mime, bytes) = fetch_bytes(&direct_url, proxy.as_deref(), MAX_DOWNLOAD_BYTES)?;
    let fallback = format!("track-{id}");
    let stem = sanitize_filename(&text_param(params, "name").unwrap_or(fallback));
    let extension = extension_for(&mime, &direct_url);

    Ok(json!({
        "name": format!("{stem}{extension}"),
        "mime": mime,
        "size": bytes.len(),
        "base64": crate::server::base64_encode(&bytes),
    }))
}

/// `music.cover`：`{ base?, source, id, size?, proxy? }`
///
/// 封面以前是**浏览器直连**上游图床的（joox 之类常常白图 —— 图床只认本机 / 要 Referer）。
/// 现在和播放、下载一样经本机执行器：先问 API 要 pic 地址，再由 companion 把图片取回来，
/// 前端用 data URL 显示。地址只允许 http(s)、且有大小上限，不会变成任意 URL 下载器。
pub fn music_cover(params: &Value) -> Result<Value, String> {
    let size = number_param(params, "size").unwrap_or(300);
    let size = if ALLOWED_PIC_SIZE.contains(&size) { size } else { 300 };

    // 复用 build_url：types 换成 pic 就是「取封面直链」
    let mut direct = params.clone();
    if let Some(object) = direct.as_object_mut() {
        object.insert("types".to_string(), json!("pic"));
        object.insert("size".to_string(), json!(size));
        for key in ["br", "name", "count", "pages"] {
            object.remove(key);
        }
    }
    let proxy = proxy_param(params);
    let url = build_url(&direct)?;
    let (status, body) = fetch_text(&url, proxy.as_deref())?;
    let data: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let detail = data
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("上游返回了错误");
        return Err(format!("{detail}（HTTP {status}）"));
    }

    let pic = data
        .get("url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("这首歌没有封面")?
        .to_string();
    if !pic.starts_with("http://") && !pic.starts_with("https://") {
        return Err("封面地址不是 http/https".to_string());
    }

    let (mime, bytes) = fetch_bytes(&pic, proxy.as_deref(), MAX_COVER_BYTES)?;
    Ok(json!({
        "mime": mime,
        "size": bytes.len(),
        "base64": crate::server::base64_encode(&bytes),
    }))
}

fn fetch_bytes(url: &str, proxy: Option<&str>, max: usize) -> Result<(String, Vec<u8>), String> {
    let response = web::agent(proxy)?
        .get(url)
        .call()
        .map_err(|err| format!("下载失败：{err}"))?;
    let mime = response
        .header("content-type")
        .unwrap_or("audio/mpeg")
        .to_string();

    let mut reader = response.into_reader().take((max + 1) as u64);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|err| format!("读取内容失败：{err}"))?;
    if bytes.len() > max {
        return Err(format!("文件太大（超过 {} MB）", max / 1024 / 1024));
    }
    Ok((mime, bytes))
}

/* ---------------------------------- 小工具 ---------------------------------- */

/// 文件名去掉 Windows 不允许的字符，并限长
fn sanitize_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    let limited: String = trimmed.chars().take(80).collect();
    if limited.is_empty() {
        "track".to_string()
    } else {
        limited
    }
}

/// 优先按 content-type 推扩展名，其次看直链后缀，最后兜底 .mp3
fn extension_for(mime: &str, url: &str) -> String {
    let by_mime = match mime.split(';').next().unwrap_or("").trim() {
        "audio/mpeg" | "audio/mp3" => Some(".mp3"),
        "audio/flac" | "audio/x-flac" => Some(".flac"),
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => Some(".m4a"),
        "audio/ogg" => Some(".ogg"),
        "audio/wav" | "audio/x-wav" => Some(".wav"),
        _ => None,
    };
    if let Some(extension) = by_mime {
        return extension.to_string();
    }

    let guess = url
        .split('?')
        .next()
        .unwrap_or("")
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match guess.as_str() {
        "mp3" => ".mp3".to_string(),
        "flac" => ".flac".to_string(),
        "m4a" => ".m4a".to_string(),
        "ogg" => ".ogg".to_string(),
        "wav" => ".wav".to_string(),
        _ => ".mp3".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_search_url_with_bounds() {
        let url = build_url(&json!({
            "types": "search",
            "source": "netease",
            "name": "周杰伦",
            "count": 999,
            "pages": 0,
        }))
        .unwrap();
        assert!(url.starts_with(DEFAULT_BASE));
        assert!(url.contains("types=search"));
        assert!(url.contains("source=netease"));
        assert!(url.contains(&format!("name={}", web::encode_query("周杰伦"))));
        assert!(url.contains("count=50")); // 上限
        assert!(url.contains("pages=1")); // 下限
    }

    #[test]
    fn rejects_unknown_types_and_sources() {
        let bad_type = build_url(&json!({ "types": "playlist" })).unwrap_err();
        assert!(bad_type.contains("types"), "{bad_type}");

        let bad_source = build_url(&json!({ "types": "search", "source": "piracy" })).unwrap_err();
        assert!(bad_source.contains("音乐源"), "{bad_source}");

        let bad_base = build_url(&json!({ "types": "search", "base": "file:///etc" })).unwrap_err();
        assert!(bad_base.contains("http"), "{bad_base}");
    }

    #[test]
    fn allows_album_suffix_and_clamps_quality() {
        let url = build_url(&json!({
            "types": "search",
            "source": "netease_album",
            "br": 111,
            "size": 999,
        }))
        .unwrap();
        assert!(url.contains("source=netease_album"));
        assert!(url.contains("br=320")); // 不在允许列表 → 回落 320
        assert!(url.contains("size=300"));
    }

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("a/b:c*d?e\"f<g>h|i"), "a_b_c_d_e_f_g_h_i");
        assert_eq!(sanitize_filename("  周杰伦 - 稻香  "), "周杰伦 - 稻香");
        assert_eq!(sanitize_filename("..."), "track");
    }

    #[test]
    fn picks_extension() {
        assert_eq!(extension_for("audio/mpeg", "https://x/y"), ".mp3");
        assert_eq!(extension_for("audio/flac", "https://x/y"), ".flac");
        assert_eq!(extension_for("", "https://x/song.FLAC?token=1"), ".flac");
        assert_eq!(extension_for("", "https://x/nothing"), ".mp3");
    }
}
