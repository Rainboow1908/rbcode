//! Windows 上的伪终端（ConPTY）。
//!
//! 没有 PTY 时，cmd/PowerShell 的 stdin 是管道：它不逐键回显、提示符靠缓冲、
//! 退格/方向键/Ctrl+C 全都不对，`python`/`vim` 这类交互程序也起不来。
//! ConPTY 给子进程一个**真终端**，这些行为全部由终端子系统负责。

use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, TRUE};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::System::Console::{CreatePseudoConsole, COORD, HPCON};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTUPINFOEXW,
};

/// 一个已经起来的伪终端会话
pub struct ConPty {
    pub pid: u32,
    /// 伪终端本体（进程结束后要 ClosePseudoConsole）
    pub hpcon: HPCON,
    /// 子进程句柄（用来等退出）
    pub process: HANDLE,
    /// 读子进程的输出
    pub reader: File,
    /// 往子进程写按键
    pub writer: File,
}

/// 用 ConPTY 起一个子进程（`command_line` 形如 `cmd.exe /Q`）。
pub fn spawn(command_line: &str, cwd: &Path, cols: i16, rows: i16) -> Result<ConPty, String> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            bInheritHandle: TRUE,
            lpSecurityDescriptor: std::ptr::null_mut(),
        };

        // 输入：我们写 -> 伪终端读
        let mut in_read = HANDLE::default();
        let mut in_write = HANDLE::default();
        CreatePipe(&mut in_read, &mut in_write, Some(&sa as *const SECURITY_ATTRIBUTES), 0)
            .map_err(|e| format!("创建输入管道失败：{e}"))?;
        // 输出：伪终端写 -> 我们读
        let mut out_read = HANDLE::default();
        let mut out_write = HANDLE::default();
        CreatePipe(&mut out_read, &mut out_write, Some(&sa as *const SECURITY_ATTRIBUTES), 0)
            .map_err(|e| format!("创建输出管道失败：{e}"))?;

        let hpcon = CreatePseudoConsole(COORD { X: cols, Y: rows }, in_read, out_write, 0)
            .map_err(|e| format!("创建伪终端失败：{e}"))?;

        // 把伪终端挂进进程属性表
        let mut attrs_size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attrs_size);
        let mut attrs_buf = vec![0u8; attrs_size];
        let attrs = LPPROC_THREAD_ATTRIBUTE_LIST(attrs_buf.as_mut_ptr() as *mut c_void);
        InitializeProcThreadAttributeList(Some(attrs), 1, None, &mut attrs_size)
            .map_err(|e| format!("初始化进程属性失败：{e}"))?;
        UpdateProcThreadAttribute(
            attrs,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            // 注意：这里要传「句柄值本身」当指针（hpc as PVOID），不是句柄的地址 ——
            // 传错了宿主进程会得到无效的伪终端句柄，cmd 直接弹 0xc0000142。
            Some(hpcon.0 as *const c_void),
            std::mem::size_of::<HPCON>(),
            None,
            None,
        )
        .map_err(|e| format!("挂载伪终端失败：{e}"))?;

        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attrs;

        let mut pi = PROCESS_INFORMATION::default();
        let mut cmd: Vec<u16> = OsStr::new(command_line)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let dir: Vec<u16> = cwd
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let created = CreateProcessW(
            windows::core::PCWSTR::null(),
            Some(PWSTR(cmd.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT,
            None,
            PCWSTR(dir.as_ptr()),
            &si.StartupInfo,
            &mut pi,
        );
        DeleteProcThreadAttributeList(attrs);
        // 这两端是伪终端内部用的，按文档要在 CreateProcess 之后再关
        let _ = CloseHandle(in_read);
        let _ = CloseHandle(out_write);
        created.map_err(|e| format!("启动会话终端失败：{e}"))?;
        let _ = CloseHandle(pi.hThread);

        Ok(ConPty {
            pid: pi.dwProcessId,
            hpcon,
            process: pi.hProcess,
            reader: File::from_raw_handle(out_read.0 as _),
            writer: File::from_raw_handle(in_write.0 as _),
        })
    }
}

/// 等子进程退出（返回退出码）
/// 句柄不是 Send，但我们保证这两个句柄只在这一个线程里用（等退出 + 关伪终端）
pub struct Handles(pub HANDLE, pub HPCON);

unsafe impl Send for Handles {}

/// 等子进程退出，然后关掉伪终端（必须等进程结束之后才能关）
pub fn wait_and_close(handles: Handles) -> i32 {
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    unsafe {
        let _ = WaitForSingleObject(handles.0, INFINITE);
        let mut code = 0u32;
        let _ = GetExitCodeProcess(handles.0, &mut code);
        let _ = CloseHandle(handles.0);
        windows::Win32::System::Console::ClosePseudoConsole(handles.1);
        code as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// 真起一个 ConPTY，写一条命令，应该能看到回显 + 结果。
    #[test]
    fn conpty_runs_a_command() {
        let dir = std::env::temp_dir();
        let pty = spawn("powershell.exe -NoLogo -NoProfile", &dir, 80, 24).expect("spawn conpty");
        let mut writer = pty.writer;
        let mut reader = pty.reader;

        writer.write_all(b"echo CONPTY_MARK\r\n").unwrap();
        writer.write_all(b"echo SECOND_LINE\r\n").unwrap();
        writer.flush().unwrap();

        let mut acc = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline && !acc.contains("SECOND_LINE") {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => acc.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
        }

        drop(writer);
        wait_and_close(Handles(pty.process, pty.hpcon));
        eprintln!("--- conpty output ---\n{acc}\n---------------------");
        assert!(acc.contains("CONPTY_MARK"), "看不到命令回显");
        assert!(acc.contains("SECOND_LINE"), "看不到第二条命令");
    }
}
