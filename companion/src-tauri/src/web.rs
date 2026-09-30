//! 联网访问：网页搜索 + 抓网页，**都由用户本机发起**。
//!
//! 为什么放在本机执行器里而不是 Cloudflare Worker：
//!   - 搜索请求从数据中心出口 IP 发出时，很容易被搜索引擎当成爬虫封掉（返回验证码页）；
//!   - 抓取也要能用用户本机的代理（比如 Clash 的 127.0.0.1:7897），
//!     而 Worker 在 Cloudflare 上，够不到你本机的代理。
//!
//! 搜索不依赖任何 API Key，直接请求搜索引擎的公开结果页并解析：
//!   - Bing：优先 `format=rss`（结构稳定、好解析），拿不到再退回普通结果页
//!   - DuckDuckGo：`html.duckduckgo.com/html/` 端点

use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};
use ureq::{Agent, Response};

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ACCEPT_LANGUAGE: &str = "zh-CN,zh;q=0.9,en;q=0.8";
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: u32 = 5;
/// 每个源最多带回多少条（前端还会按 max_results 再截一次）
const MAX_HITS: usize = 10;
/// 抓取返回的正文上限（字符数），和 Worker 那边保持一致
const MAX_TEXT: usize = 60_000;

/* ------------------------------------ 搜索 ------------------------------------ */

/// web.search 的实现。
///
/// params = `{ query: string, engine?: "auto"|"bing"|"duckduckgo", proxy?: string }`
///
/// `auto`（默认）会先试 Bing，没有结果再试 DuckDuckGo。
/// 返回 `{ engine, results: [{title,url,snippet}], note? }`。
pub fn web_search(params: &Value) -> Result<Value, String> {
    let query = string_param(params, "query").ok_or("缺少 query 参数")?;
    let engine = params
        .get("engine")
        .and_then(|value| value.as_str())
        .unwrap_or("auto");
    let proxy = proxy_param(params);

    let order: &[&str] = match engine {
        "bing" => &["bing"],
        "duckduckgo" => &["duckduckgo"],
        _ => &["bing", "duckduckgo"],
    };

    let mut problems: Vec<String> = Vec::new();
    for name in order {
        let attempt = if *name == "bing" {
            search_bing(&query, proxy.as_deref())
        } else {
            search_duckduckgo(&query, proxy.as_deref())
        };
        match attempt {
            Ok(hits) if !hits.is_empty() => {
                return Ok(json!({ "engine": name, "results": hits }));
            }
            Ok(_) => problems.push(format!("{name}: no results")),
            Err(err) => problems.push(format!("{name}: {err}")),
        }
    }

    Ok(json!({
        "engine": order.first().copied().unwrap_or("auto"),
        "results": [],
        "note": format!(
            "No results were parsed ({}). The search engine may have returned a captcha page, or the query has no matches.",
            problems.join("; ")
        ),
    }))
}

fn search_bing(query: &str, proxy: Option<&str>) -> Result<Vec<Value>, String> {
    let encoded = encode_query(query);

    // 1) 先试 RSS 输出：结果结构固定，比抓 HTML 稳得多
    let rss = get(
        &format!("https://www.bing.com/search?q={encoded}&format=rss&count=20"),
        proxy,
    )?;
    let hits = parse_bing_rss(&rss);
    if !hits.is_empty() {
        return Ok(hits);
    }

    // 2) 退回解析普通结果页
    let html = get(&format!("https://www.bing.com/search?q={encoded}"), proxy)?;
    Ok(parse_bing_html(&html))
}

fn search_duckduckgo(query: &str, proxy: Option<&str>) -> Result<Vec<Value>, String> {
    let html = get(
        &format!("https://html.duckduckgo.com/html/?q={}", encode_query(query)),
        proxy,
    )?;
    Ok(parse_duckduckgo(&html))
}

fn parse_bing_rss(xml: &str) -> Vec<Value> {
    let item_re = Regex::new(r"(?is)<item>(.*?)</item>").unwrap();
    let mut hits = Vec::new();

    for capture in item_re.captures_iter(xml) {
        let block = &capture[1];
        let title = tag_text(block, "title");
        let url = tag_text(block, "link");
        let snippet = tag_text(block, "description");
        if title.is_empty() || url.is_empty() {
            continue;
        }
        hits.push(json!({ "title": title, "url": url, "snippet": snippet }));
        if hits.len() >= MAX_HITS {
            break;
        }
    }
    hits
}

fn parse_bing_html(html: &str) -> Vec<Value> {
    let block_re = Regex::new(r#"(?is)<li class="b_algo".*?</li>"#).unwrap();
    let link_re = Regex::new(r#"(?is)<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let snippet_re = Regex::new(r"(?is)<p[^>]*>(.*?)</p>").unwrap();
    let mut hits = Vec::new();

    for capture in block_re.captures_iter(html) {
        let block = &capture[0];
        let Some(link) = link_re.captures(block) else {
            continue;
        };
        let url = decode_entities(&link[1]);
        let title = clean_text(&link[2]);
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = snippet_re
            .captures(block)
            .map(|cap| clean_text(&cap[1]))
            .unwrap_or_default();
        hits.push(json!({ "title": title, "url": url, "snippet": snippet }));
        if hits.len() >= MAX_HITS {
            break;
        }
    }
    hits
}

fn parse_duckduckgo(html: &str) -> Vec<Value> {
    let link_re =
        Regex::new(r#"(?is)<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
            .unwrap();
    let snippet_re =
        Regex::new(r#"(?is)<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>"#).unwrap();

    // 摘要和链接是两个独立的列表，按出现顺序一一对应
    let snippets: Vec<String> = snippet_re
        .captures_iter(html)
        .map(|cap| clean_text(&cap[1]))
        .collect();

    let mut hits = Vec::new();
    for (index, capture) in link_re.captures_iter(html).enumerate() {
        let title = clean_text(&capture[2]);
        if title.is_empty() {
            continue;
        }
        hits.push(json!({
            "title": title,
            "url": unwrap_duckduckgo_url(&capture[1]),
            "snippet": snippets.get(index).cloned().unwrap_or_default(),
        }));
        if hits.len() >= MAX_HITS {
            break;
        }
    }
    hits
}

/// DuckDuckGo 的结果链接形如 `//duckduckgo.com/l/?uddg=<encoded>`
fn unwrap_duckduckgo_url(raw: &str) -> String {
    let candidate = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.to_string()
    };
    if candidate.contains("duckduckgo.com/l/") {
        if let Some(rest) = candidate.split("uddg=").nth(1) {
            let encoded = rest.split('&').next().unwrap_or(rest);
            return percent_decode(encoded);
        }
    }
    candidate
}

/* ------------------------------------ 抓取 ------------------------------------ */

/// web.fetch 的实现：抓网页并转成纯文本。
///
/// params = `{ url: string, proxy?: string }`
///
/// 和 Worker 那边不同：这里跑在用户自己机器上（本来就能跑任意命令），
/// 所以不做 SSRF 白/黑名单，只限制协议是 http/https。
/// 返回 `{ url, status, contentType, title, text }`。
pub fn web_fetch(params: &Value) -> Result<Value, String> {
    let target = string_param(params, "url").ok_or("缺少 url 参数")?;
    if !target.starts_with("http://") && !target.starts_with("https://") {
        return Err("only http/https URLs are supported".to_string());
    }
    let proxy = proxy_param(params);

    let response = request(&target, proxy.as_deref())?;
    let status = response.status();
    let content_type = response
        .header("content-type")
        .unwrap_or("")
        .to_string();
    let final_url = response.get_url().to_string();
    let raw = response.into_string().map_err(|err| err.to_string())?;

    if !content_type.contains("html")
        && !content_type.contains("text")
        && !content_type.contains("json")
    {
        return Ok(json!({
            "url": final_url,
            "status": status,
            "contentType": content_type,
            "text": format!("(non-text content: {content_type}, {} bytes)", raw.len()),
        }));
    }

    let title = extract_title(&raw);
    let text = if content_type.contains("json") {
        truncate(&raw)
    } else {
        truncate(&html_to_text(&raw))
    };

    Ok(json!({
        "url": final_url,
        "status": status,
        "contentType": content_type,
        "title": title,
        "text": text,
    }))
}

fn extract_title(html: &str) -> String {
    match Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap().captures(html) {
        Some(capture) => clean_text(&capture[1]),
        None => String::new(),
    }
}

/// 去 script/style/注释 → 块级标签转换行 → 去标签 → 解实体 → 归一化空白
fn html_to_text(html: &str) -> String {
    let dropped = Regex::new(r"(?is)<script[\s\S]*?</script>|<style[\s\S]*?</style>|<!--[\s\S]*?-->")
        .unwrap()
        .replace_all(html, " ")
        .to_string();
    let breaks = Regex::new(r"(?i)<br\s*/?>")
        .unwrap()
        .replace_all(&dropped, "\n")
        .to_string();
    let blocks = Regex::new(r"(?i)</(p|div|li|h[1-6]|tr|section|article|header|footer)>")
        .unwrap()
        .replace_all(&breaks, "\n")
        .to_string();
    let list_items = Regex::new(r"(?i)<li[^>]*>")
        .unwrap()
        .replace_all(&blocks, "- ")
        .to_string();
    let stripped = Regex::new(r"<[^>]+>")
        .unwrap()
        .replace_all(&list_items, " ")
        .to_string();
    normalize_whitespace(&decode_entities(&stripped))
}

/// 合并空白：行内多空格压成一个，最多保留一个空行
fn normalize_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank_run = 0;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
            out.push('\n');
        } else {
            blank_run = 0;
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT {
        text.to_string()
    } else {
        text.chars().take(MAX_TEXT).collect()
    }
}

/* ------------------------------------ HTTP ------------------------------------ */

/// 建一个本次请求专用的 agent（可选走代理）
pub(crate) fn agent(proxy: Option<&str>) -> Result<Agent, String> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .redirects(MAX_REDIRECTS);
    if let Some(raw) = proxy {
        let parsed = ureq::Proxy::new(raw).map_err(|err| format!("代理地址无效：{err}"))?;
        builder = builder.proxy(parsed);
    }
    Ok(builder.build())
}

fn request(url: &str, proxy: Option<&str>) -> Result<Response, String> {
    agent(proxy)?
        .get(url)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .set("Accept-Language", ACCEPT_LANGUAGE)
        .call()
        .map_err(|err| err.to_string())
}

fn get(url: &str, proxy: Option<&str>) -> Result<String, String> {
    request(url, proxy)?
        .into_string()
        .map_err(|err| err.to_string())
}

/* ------------------------------- 参数 / 文本工具 ------------------------------- */

fn string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 代理地址（空 = 直连），例如 http://127.0.0.1:7897
fn proxy_param(params: &Value) -> Option<String> {
    string_param(params, "proxy")
}

/// 取出某个标签里的文本（大小写不敏感、允许跨行）
fn tag_text(block: &str, tag: &str) -> String {
    let pattern = format!(r"(?is)<{tag}[^>]*>(.*?)</{tag}>");
    match Regex::new(&pattern) {
        Ok(re) => re
            .captures(block)
            .map(|capture| clean_text(&capture[1]))
            .unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// 去 CDATA / 去标签 / 解实体 / 合并空白
fn clean_text(html: &str) -> String {
    let without_cdata = html.replace("<![CDATA[", "").replace("]]>", "");
    let stripped = Regex::new(r"(?s)<[^>]+>")
        .unwrap()
        .replace_all(&without_cdata, " ")
        .to_string();
    decode_entities(&stripped)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_entities(text: &str) -> String {
    let mut out = text.to_string();
    for (from, to) in [
        ("&nbsp;", " "),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&apos;", "'"),
    ] {
        out = out.replace(from, to);
    }

    // 数字实体：&#39; / &#x27;
    let numeric = Regex::new(r"&#(x?)([0-9a-fA-F]+);").unwrap();
    let mut decoded = String::with_capacity(out.len());
    let mut last = 0;
    for capture in numeric.captures_iter(&out) {
        let whole = capture.get(0).unwrap();
        decoded.push_str(&out[last..whole.start()]);
        let digits = capture.get(2).unwrap().as_str();
        let radix = if capture.get(1).unwrap().as_str().is_empty() {
            10
        } else {
            16
        };
        match u32::from_str_radix(digits, radix).ok().and_then(char::from_u32) {
            Some(ch) => decoded.push(ch),
            None => decoded.push_str(whole.as_str()),
        }
        last = whole.end();
    }
    decoded.push_str(&out[last..]);
    decoded
}

/// 查询串百分号编码（RFC 3986 的 unreserved 之外全部转义，空格用 %20）
pub(crate) fn encode_query(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 百分号解码（不把 `+` 当空格，和 URL 里的语义保持一致）
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_query() {
        assert_eq!(encode_query("rust 中文&x=1"), "rust%20%E4%B8%AD%E6%96%87%26x%3D1");
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("a &amp; b &#x4e2d;"), "a & b 中");
    }

    #[test]
    fn parses_bing_rss() {
        let xml = r#"<rss><channel>
            <item><title>Hello &amp; world</title><link>https://a.example</link><description><![CDATA[Some <b>text</b>]]></description></item>
            <item><title>Second</title><link>https://b.example</link><description>plain</description></item>
        </channel></rss>"#;
        let hits = parse_bing_rss(xml);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["title"], "Hello & world");
        assert_eq!(hits[0]["url"], "https://a.example");
        assert_eq!(hits[0]["snippet"], "Some text");
    }

    #[test]
    fn parses_duckduckgo_and_unwraps_url() {
        let html = r#"
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=x">Title <b>here</b></a>
            <a class="result__snippet">Snippet text</a>
        "#;
        let hits = parse_duckduckgo(html);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["title"], "Title here");
        assert_eq!(hits[0]["url"], "https://example.com/page");
        assert_eq!(hits[0]["snippet"], "Snippet text");
    }

    #[test]
    fn extracts_title_and_text() {
        let html = r#"<html><head><title>标题 - 站点</title>
            <script>var x = 1;</script><style>p{color:red}</style></head>
            <body><p>hello&nbsp;world</p><ul><li>one</li><li>two</li></ul>
            <!-- 注释不要 --></body></html>"#;
        assert_eq!(extract_title(html), "标题 - 站点");
        let text = html_to_text(html);
        assert!(text.contains("hello world"));
        assert!(text.contains("- one"));
        assert!(!text.contains("var x"));
        assert!(!text.contains("color:red"));
        assert!(!text.contains("注释"));
    }

    #[test]
    fn rejects_non_http_urls() {
        let err = web_fetch(&json!({ "url": "file:///etc/passwd" })).unwrap_err();
        assert!(err.contains("http/https"));
    }

    #[test]
    fn invalid_proxy_is_reported() {
        // 搜/抓 会把每一源的错误收集成 note，所以这里直接测 agent 构造
        let err = agent(Some("fakeproto://localhost")).unwrap_err();
        assert!(err.contains("代理"), "unexpected: {err}");
    }
}
