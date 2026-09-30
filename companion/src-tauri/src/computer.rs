//! computer use：让模型「看屏幕 + 动键鼠」。
//!
//! 为什么放在 companion：浏览器做不到；而且之前试过用 PowerShell 抓屏，会被 Windows Defender
//! 当成可疑脚本拦下，所以这里直接用 Windows 原生 API（GDI 抓屏 / SendInput 注入）。
//!
//! 两个 op：
//!   - `computer.screen`  抓整个虚拟桌面（多屏拼成一张）→ 可选等比缩放 → PNG → base64
//!   - `computer.actions` 执行一批动作（鼠标/键盘）
//!
//! 坐标约定：`computer.actions` 收到的是**屏幕绝对坐标**（虚拟桌面左上为原点）。
//! 「截图坐标 → 屏幕坐标」的换算放在调用方，和 Anthropic / OpenAI 的 display_width_px 做法一致。

use serde_json::{json, Value};
use std::time::Duration;

#[cfg(windows)]
use std::mem::size_of;

/// 一张截图
struct Screen {
  /// RGBA
  pixels: Vec<u8>,
  width: u32,
  height: u32,
  /// 虚拟桌面左上角在屏幕坐标系里的位置（多屏时可能为负）
  origin_x: i32,
  origin_y: i32,
}

/* ---------------------------------- 截屏 ---------------------------------- */

pub fn screen_capture(params: &Value) -> Result<Value, String> {
  let max_width = params.get("maxWidth").and_then(Value::as_u64).unwrap_or(0) as u32;
  let screen = capture_virtual_screen()?;

  let (pixels, width, height) = if max_width > 0 && screen.width > max_width {
    resample(&screen.pixels, screen.width, screen.height, max_width)
  } else {
    (screen.pixels, screen.width, screen.height)
  };

  let png = encode_png(&pixels, width, height)?;
  Ok(json!({
      "width": width,
      "height": height,
      "screenWidth": screen.width,
      "screenHeight": screen.height,
      "originX": screen.origin_x,
      "originY": screen.origin_y,
      "base64": crate::server::base64_encode(&png),
  }))
}

/// 面积平均缩放（比最近邻更能看清界面文字）
fn resample(pixels: &[u8], width: u32, height: u32, max_width: u32) -> (Vec<u8>, u32, u32) {
  let new_width = max_width.clamp(1, width.max(1));
  let new_height = ((height as f64) * (new_width as f64) / (width.max(1) as f64))
    .round()
    .max(1.0) as u32;
  let mut out = vec![0u8; (new_width * new_height * 4) as usize];
  let x_ratio = width as f64 / new_width as f64;
  let y_ratio = height as f64 / new_height as f64;

  for y in 0..new_height {
    let y0 = (y as f64 * y_ratio) as u32;
    let y1 = (((y + 1) as f64 * y_ratio).ceil() as u32).clamp(y0 + 1, height);
    for x in 0..new_width {
      let x0 = (x as f64 * x_ratio) as u32;
      let x1 = (((x + 1) as f64 * x_ratio).ceil() as u32).clamp(x0 + 1, width);

      let (mut r, mut g, mut b, mut a, mut count) = (0u32, 0u32, 0u32, 0u32, 0u32);
      for sy in y0..y1 {
        for sx in x0..x1 {
          let index = ((sy * width + sx) * 4) as usize;
          r += pixels[index] as u32;
          g += pixels[index + 1] as u32;
          b += pixels[index + 2] as u32;
          a += pixels[index + 3] as u32;
          count += 1;
        }
      }

      let at = ((y * new_width + x) * 4) as usize;
      out[at] = (r / count) as u8;
      out[at + 1] = (g / count) as u8;
      out[at + 2] = (b / count) as u8;
      out[at + 3] = (a / count) as u8;
    }
  }
  (out, new_width, new_height)
}

fn encode_png(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
  let mut out = Vec::new();
  {
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
      .write_header()
      .map_err(|err| format!("PNG 编码失败：{err}"))?;
    writer
      .write_image_data(pixels)
      .map_err(|err| format!("PNG 写入失败：{err}"))?;
  }
  Ok(out)
}

/* ---------------------------------- 动作 ---------------------------------- */

/// `computer.actions`：`{ actions: [{ action, coordinate?, start_coordinate?, text?, direction?, amount?, duration? }] }`
///
/// 按顺序执行，遇到第一个失败就停（后面的动作通常依赖前面的结果）。
pub fn computer_actions(params: &Value) -> Result<Value, String> {
  let actions = params
    .get("actions")
    .and_then(Value::as_array)
    .ok_or("缺少 actions 参数")?;
  if actions.len() > 50 {
    return Err("一次最多 50 个动作".to_string());
  }

  let mut applied = 0usize;
  for action in actions {
    run_action(action).map_err(|err| format!("第 {} 个动作失败：{err}", applied + 1))?;
    applied += 1;
  }
  Ok(json!({ "applied": applied }))
}

fn run_action(action: &Value) -> Result<(), String> {
  let name = action
    .get("action")
    .and_then(Value::as_str)
    .ok_or("动作缺少 action 字段")?;

  match name {
    "mouse_move" => {
      let (x, y) = point(action, "coordinate")?;
      move_to(x, y)
    }
    "left_click" | "left_click_drag" => {
      let (x, y) = point(action, "coordinate")?;
      if name == "left_click_drag" {
        let (sx, sy) = point(action, "start_coordinate")?;
        move_to(sx, sy)?;
        press_mouse("left", true)?;
        drag_to(x, y);
        press_mouse("left", false)
      } else {
        move_to(x, y)?;
        click("left", false)
      }
    }
    "right_click" | "middle_click" | "double_click" => {
      if let Ok((x, y)) = point(action, "coordinate") {
        move_to(x, y)?;
      }
      let button = match name {
        "right_click" => "right",
        "middle_click" => "middle",
        _ => "left",
      };
      click(button, name == "double_click")
    }
    "scroll" => {
      if let Ok((x, y)) = point(action, "coordinate") {
        move_to(x, y)?;
      }
      let direction = action
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("down");
      let amount = action.get("amount").and_then(Value::as_i64).unwrap_or(3) as i32;
      scroll(direction, amount)
    }
    "type" => {
      let text = action.get("text").and_then(Value::as_str).unwrap_or("");
      type_text(text)
    }
    "key" => {
      let combo = action
        .get("text")
        .and_then(Value::as_str)
        .ok_or("key 动作需要 text，例如 \"ctrl+c\"")?;
      press_combo(combo)
    }
    "wait" => {
      let ms = action
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(500.0)
        .clamp(0.0, 10_000.0);
      std::thread::sleep(Duration::from_millis(ms as u64));
      Ok(())
    }
    other => Err(format!("不支持的动作：{other}")),
  }
}

fn point(action: &Value, key: &str) -> Result<(i32, i32), String> {
  let pair = action
    .get(key)
    .and_then(Value::as_array)
    .ok_or_else(|| format!("缺少 {key}（形如 [x, y]）"))?;
  let x = pair
    .first()
    .and_then(Value::as_f64)
    .ok_or_else(|| format!("{key} 的 x 不是数字"))?;
  let y = pair
    .get(1)
    .and_then(Value::as_f64)
    .ok_or_else(|| format!("{key} 的 y 不是数字"))?;
  Ok((x.round() as i32, y.round() as i32))
}

/* -------------------------------- Windows -------------------------------- */

#[cfg(windows)]
fn capture_virtual_screen() -> Result<Screen, String> {
  use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
  };
  use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
  };

  unsafe {
    let origin_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
    let origin_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    let width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32;
    let height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32;

    let screen_dc = GetDC(None);
    if screen_dc.is_invalid() {
      return Err("拿不到屏幕 DC".to_string());
    }
    let memory_dc = CreateCompatibleDC(Some(screen_dc));
    let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
    let previous = SelectObject(memory_dc, HGDIOBJ(bitmap.0));

    let blit = BitBlt(
      memory_dc,
      0,
      0,
      width as i32,
      height as i32,
      Some(screen_dc),
      origin_x,
      origin_y,
      SRCCOPY,
    );

    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = width as i32;
    // 负数 = 自上而下（和屏幕坐标一致，省得再翻一次）
    info.bmiHeader.biHeight = -(height as i32);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;

    let mut buffer = vec![0u8; (width * height * 4) as usize];
    let copied = GetDIBits(
      memory_dc,
      bitmap,
      0,
      height,
      Some(buffer.as_mut_ptr().cast()),
      &mut info,
      DIB_RGB_COLORS,
    );

    let _ = SelectObject(memory_dc, previous);
    let _ = DeleteObject(HGDIOBJ(bitmap.0));
    let _ = DeleteDC(memory_dc);
    ReleaseDC(None, screen_dc);

    blit.map_err(|err| format!("截屏失败：{err}"))?;
    if copied == 0 {
      return Err("截屏失败：没拿到像素".to_string());
    }

    // GDI 给的是 BGRA；换成 RGBA，并把 alpha 统一成不透明
    for chunk in buffer.chunks_exact_mut(4) {
      chunk.swap(0, 2);
      chunk[3] = 255;
    }

    Ok(Screen {
      pixels: buffer,
      width,
      height,
      origin_x,
      origin_y,
    })
  }
}

#[cfg(windows)]
fn move_to(x: i32, y: i32) -> Result<(), String> {
  use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
  unsafe { SetCursorPos(x, y).map_err(|err| format!("移动鼠标失败：{err}")) }
}

/// 用一串小步把鼠标拖过去（有些界面需要中间有移动事件）
#[cfg(windows)]
fn drag_to(x: i32, y: i32) {
  use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};
  use windows::Win32::Foundation::POINT;

  let mut start = POINT::default();
  unsafe {
    if GetCursorPos(&mut start).is_err() {
      let _ = SetCursorPos(x, y);
      return;
    }
  }
  let steps = 12;
  for step in 1..=steps {
    let nx = start.x + (x - start.x) * step / steps;
    let ny = start.y + (y - start.y) * step / steps;
    unsafe {
      let _ = SetCursorPos(nx, ny);
    }
    std::thread::sleep(Duration::from_millis(12));
  }
}

#[cfg(windows)]
fn click(button: &str, double: bool) -> Result<(), String> {
  let times = if double { 2 } else { 1 };
  for _ in 0..times {
    press_mouse(button, true)?;
    std::thread::sleep(Duration::from_millis(20));
    press_mouse(button, false)?;
    std::thread::sleep(Duration::from_millis(60));
  }
  Ok(())
}

#[cfg(windows)]
fn press_mouse(button: &str, down: bool) -> Result<(), String> {
  use windows::Win32::UI::Input::KeyboardAndMouse::{
    mouse_event, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
  };

  let flag = match (button, down) {
    ("right", true) => MOUSEEVENTF_RIGHTDOWN,
    ("right", false) => MOUSEEVENTF_RIGHTUP,
    ("middle", true) => MOUSEEVENTF_MIDDLEDOWN,
    ("middle", false) => MOUSEEVENTF_MIDDLEUP,
    (_, true) => MOUSEEVENTF_LEFTDOWN,
    (_, false) => MOUSEEVENTF_LEFTUP,
  };
  unsafe { mouse_event(flag, 0, 0, 0, 0) }
  Ok(())
}

#[cfg(windows)]
fn scroll(direction: &str, amount: i32) -> Result<(), String> {
  use windows::Win32::UI::Input::KeyboardAndMouse::{
    mouse_event, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL,
  };

  /// 滚轮的一格（Win32 的 WHEEL_DELTA 固定是 120）
  const WHEEL_STEP: i32 = 120;

  let step = WHEEL_STEP * amount.clamp(1, 20);
  let (flag, delta) = match direction {
    "up" => (MOUSEEVENTF_WHEEL, step),
    "down" => (MOUSEEVENTF_WHEEL, -step),
    "left" => (MOUSEEVENTF_HWHEEL, -step),
    _ => (MOUSEEVENTF_HWHEEL, step),
  };
  unsafe { mouse_event(flag, 0, 0, delta, 0) }
  Ok(())
}

#[cfg(windows)]
fn type_text(text: &str) -> Result<(), String> {
  use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    VIRTUAL_KEY,
  };

  // KEYEVENTF_UNICODE 能直接送任意字符（中文、emoji 都行），不需要按键映射
  let mut inputs: Vec<INPUT> = Vec::new();
  for unit in text.encode_utf16() {
    for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
      inputs.push(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
          ki: KEYBDINPUT {
            wVk: VIRTUAL_KEY(0),
            wScan: unit,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
          },
        },
      });
    }
  }
  if inputs.is_empty() {
    return Ok(());
  }

  let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
  if sent as usize != inputs.len() {
    return Err("输入文本被系统拒绝".to_string());
  }
  Ok(())
}

#[cfg(windows)]
fn press_combo(combo: &str) -> Result<(), String> {
  use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP};

  let mut modifiers: Vec<u8> = Vec::new();
  let mut main: Option<u8> = None;

  for raw in combo.split('+') {
    let name = raw.trim().to_ascii_lowercase();
    if name.is_empty() {
      continue;
    }
    if let Some(vk) = modifier_vk(&name) {
      modifiers.push(vk);
      continue;
    }
    main = Some(key_vk(&name).ok_or_else(|| format!("不认识的按键：{name}"))?);
  }
  let main = main.ok_or("key 动作需要一个主键，例如 ctrl+c")?;

  unsafe {
    for vk in &modifiers {
      keybd_event(*vk, 0, KEYBD_EVENT_FLAGS(0), 0);
      std::thread::sleep(Duration::from_millis(10));
    }
    keybd_event(main, 0, KEYBD_EVENT_FLAGS(0), 0);
    std::thread::sleep(Duration::from_millis(20));
    keybd_event(main, 0, KEYEVENTF_KEYUP, 0);
    for vk in modifiers.iter().rev() {
      keybd_event(*vk, 0, KEYEVENTF_KEYUP, 0);
    }
  }
  Ok(())
}

#[cfg(windows)]
fn modifier_vk(name: &str) -> Option<u8> {
  match name {
    "ctrl" | "control" => Some(0x11),
    "shift" => Some(0x10),
    "alt" => Some(0x12),
    "win" | "meta" | "cmd" | "super" => Some(0x5B),
    _ => None,
  }
}

#[cfg(windows)]
fn key_vk(name: &str) -> Option<u8> {
  // 0x30-0x39 = 0-9，0x41-0x5A = A-Z
  if name.len() == 1 {
    let ch = name.chars().next()?;
    if ch.is_ascii_alphanumeric() {
      return Some(ch.to_ascii_uppercase() as u8);
    }
  }
  match name {
    "enter" | "return" => Some(0x0D),
    "esc" | "escape" => Some(0x1B),
    "tab" => Some(0x09),
    "space" => Some(0x20),
    "backspace" => Some(0x08),
    "delete" | "del" => Some(0x2E),
    "insert" => Some(0x2D),
    "home" => Some(0x24),
    "end" => Some(0x23),
    "pageup" | "page_up" => Some(0x21),
    "pagedown" | "page_down" => Some(0x22),
    "up" => Some(0x26),
    "down" => Some(0x28),
    "left" => Some(0x25),
    "right" => Some(0x27),
    "f1" => Some(0x70),
    "f2" => Some(0x71),
    "f3" => Some(0x72),
    "f4" => Some(0x73),
    "f5" => Some(0x74),
    "f6" => Some(0x75),
    "f7" => Some(0x76),
    "f8" => Some(0x77),
    "f9" => Some(0x78),
    "f10" => Some(0x79),
    "f11" => Some(0x7A),
    "f12" => Some(0x7B),
    _ => None,
  }
}

/* ------------------------------ 其它平台占位 ------------------------------ */

#[cfg(not(windows))]
fn capture_virtual_screen() -> Result<Screen, String> {
  Err("computer use 目前只支持 Windows".to_string())
}

#[cfg(not(windows))]
fn move_to(_x: i32, _y: i32) -> Result<(), String> {
  Err("computer use 目前只支持 Windows".to_string())
}

#[cfg(not(windows))]
fn drag_to(_x: i32, _y: i32) {}

#[cfg(not(windows))]
fn click(_button: &str, _double: bool) -> Result<(), String> {
  Err("computer use 目前只支持 Windows".to_string())
}

#[cfg(not(windows))]
fn press_mouse(_button: &str, _down: bool) -> Result<(), String> {
  Err("computer use 目前只支持 Windows".to_string())
}

#[cfg(not(windows))]
fn scroll(_direction: &str, _amount: i32) -> Result<(), String> {
  Err("computer use 目前只支持 Windows".to_string())
}

#[cfg(not(windows))]
fn type_text(_text: &str) -> Result<(), String> {
  Err("computer use 目前只支持 Windows".to_string())
}

#[cfg(not(windows))]
fn press_combo(_combo: &str) -> Result<(), String> {
  Err("computer use 目前只支持 Windows".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_points() {
    let action = json!({ "coordinate": [12.6, -3.2] });
    assert_eq!(point(&action, "coordinate").unwrap(), (13, -3));
    assert!(point(&json!({}), "coordinate").is_err());
    assert!(point(&json!({ "coordinate": [1] }), "coordinate").is_err());
  }

  #[test]
  fn resample_halves_cleanly() {
    // 2x2 全白 → 1x1 应该还是白
    let pixels = vec![255u8; 2 * 2 * 4];
    let (out, w, h) = resample(&pixels, 2, 2, 1);
    assert_eq!((w, h), (1, 1));
    assert_eq!(out, vec![255, 255, 255, 255]);
  }

  #[test]
  fn resample_skips_when_not_needed() {
    let pixels = vec![1u8; 3 * 3 * 4];
    let (out, w, h) = resample(&pixels, 3, 3, 10);
    assert_eq!((w, h), (3, 3));
    assert_eq!(out.len(), 3 * 3 * 4);
  }

  #[test]
  fn encodes_png_header() {
    let png = encode_png(&vec![0u8; 2 * 2 * 4], 2, 2).unwrap();
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
  }

  #[test]
  fn rejects_unknown_action() {
    let err = run_action(&json!({ "action": "explode" })).unwrap_err();
    assert!(err.contains("不支持的动作"), "{err}");
  }

  #[test]
  fn caps_action_count() {
    let actions: Vec<Value> = (0..51).map(|_| json!({ "action": "wait", "duration": 0 })).collect();
    let err = computer_actions(&json!({ "actions": actions })).unwrap_err();
    assert!(err.contains("最多"), "{err}");
  }

  #[test]
  fn maps_keys() {
    assert_eq!(key_vk("a"), Some(0x41));
    assert_eq!(key_vk("enter"), Some(0x0D));
    assert_eq!(modifier_vk("ctrl"), Some(0x11));
    assert_eq!(key_vk("没这个键"), None);
  }
}
