package com.rbcode.mobile;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.tukaani.xz.XZInputStream;

/**
 * 内置 Linux 环境：proot + Ubuntu 24.04 rootfs（随 APK 打包）。
 * shell 命令默认跑在这个 guest 里，于是有 apt / python3 / node / git（没装的用 apt 装）。
 *
 * proot 来自 Termux（aarch64），依赖 libtalloc.so.2 / libandroid-shmem.so / libtermux-exec.so，
 * loader 路径用 PROOT_LOADER 指定到我们自己的目录（它默认硬编码在 Termux 的路径下）。
 */
public final class LinuxEnv {
  private static final String[] BINARIES = {
      "proot",
      "loader",
      "loader32",
      "libtalloc.so.2",
      "libandroid-shmem.so",
      "libtermux-exec.so",
      "libtermux-exec-ld-preload.so",
  };
  // rootfs 用 xz（比 gzip 小 ~42%）：APK 才压得进 CF 静态资源的单文件 25 MiB 上限
  private static final String ROOTFS_ASSET = "linux/ubuntu.txz";

  private static LinuxEnv instance;

  public static synchronized LinuxEnv get(Context ctx) {
    if (instance == null) instance = new LinuxEnv(ctx);
    return instance;
  }

  private final Context ctx;
  private final File base;   // filesDir/linux
  private final File proot;  // filesDir/linux/proot
  private final File root;   // filesDir/linux/root（guest 根）
  private final File tmp;

  private volatile boolean preparing = false;
  private volatile boolean ready;
  private volatile String stage = "";
  private volatile String error = null;

  private LinuxEnv(Context ctx) {
    this.ctx = ctx.getApplicationContext();
    this.base = new File(ctx.getFilesDir(), "linux");
    this.proot = new File(base, "proot");
    this.root = new File(base, "root");
    this.tmp = new File(base, "tmp");
    this.ready = isExtracted();
  }

  public boolean isReady() { return ready; }
  public boolean isPreparing() { return preparing; }
  public String stage() { return stage; }
  public String error() { return error; }

  private boolean isExtracted() {
    return new File(root, "bin/sh").exists();
  }

  /** 后台解压（幂等）。返回是否已就绪。 */
  public synchronized boolean prepare() {
    if (ready) return true;
    if (preparing) return false;
    preparing = true;
    error = null;
    try {
      base.mkdirs();
      tmp.mkdirs();
      stage = "准备 proot…";
      for (String name : BINARIES) copyAsset("linux/" + name, new File(base, name));
      new File(base, "proot").setExecutable(true, false);
      new File(base, "loader").setExecutable(true, false);
      new File(base, "loader32").setExecutable(true, false);

      if (!isExtracted()) {
        stage = "解压 Ubuntu（约 17MB）…";
        root.mkdirs();
        File rootfs = new File(base, "ubuntu.tar.xz");
        if (!rootfs.exists()) copyAsset(ROOTFS_ASSET, rootfs);
        extract(rootfs, root);
        setupGuest();
      }
      ready = true;
      stage = "就绪";
      return true;
    } catch (Exception e) {
      error = e.getMessage() == null ? e.toString() : e.getMessage();
      stage = "准备失败：" + error;
      return false;
    } finally {
      preparing = false;
    }
  }

  private void extract(File rootfs, File dest) throws Exception {
    // 系统的 toybox 不保证带 xz，所以用 Java 解 xz，再把 tar 流喂给系统 tar
    // （软链 / 权限 / 属主交给系统 tar 处理，比在 Java 里手搓可靠）
    ProcessBuilder pb = new ProcessBuilder("sh", "-c",
        "tar -x -C '" + dest.getAbsolutePath() + "'");
    pb.redirectErrorStream(true);
    Process p = pb.start();

    // 边写边读：不读走 tar 的输出，管道写满就会卡死
    Thread drain = new Thread(() -> {
      try {
        byte[] b = new byte[8192];
        while (p.getInputStream().read(b) > 0) {
          // 丢掉
        }
      } catch (IOException ignored) {
      }
    });
    drain.setDaemon(true);
    drain.start();

    try (InputStream in = new XZInputStream(new FileInputStream(rootfs));
         OutputStream out = p.getOutputStream()) {
      byte[] buf = new byte[65536];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    int code = p.waitFor();
    drain.join(2000);
    if (!new File(dest, "bin/sh").exists()) {
      throw new IOException("解压失败（exit " + code + "）");
    }
  }

  private void setupGuest() throws Exception {
    mkdirs(new File(root, "sdcard"));
    mkdirs(new File(root, "storage"));
    mkdirs(new File(root, "dev/shm"));
    mkdirs(new File(root, "tmp"));
    mkdirs(new File(root, "proc"));
    mkdirs(new File(root, "sys"));
    // DNS：apt / 联网要能解析
    write(new File(root, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
  }

  private static void mkdirs(File f) { if (!f.exists()) f.mkdirs(); }

  private static void write(File f, String text) throws IOException {
    File parent = f.getParentFile();
    if (parent != null) parent.mkdirs();
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(text.getBytes("UTF-8"));
    }
  }

  private void copyAsset(String asset, File dest) throws IOException {
    File parent = dest.getParentFile();
    if (parent != null) parent.mkdirs();
    try (InputStream in = ctx.getAssets().open(asset);
         FileOutputStream out = new FileOutputStream(dest)) {
      byte[] buf = new byte[65536];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }
  }

  /** 组装 proot 的公共参数（不含最后要跑什么） */
  private List<String> baseArgv(File cwd) {
    String cwdPath = cwd == null ? "/" : cwd.getAbsolutePath();
    boolean bindCwd = cwdPath.startsWith("/sdcard") || cwdPath.startsWith("/storage");
    List<String> a = new ArrayList<>();
    a.add(proot.getAbsolutePath());
    a.add("--link2symlink");
    // proot 退出时把 guest 里的进程一起带走（否则 kill 掉 proot 后 guest 还活着）
    a.add("--kill-on-exit");
    a.add("-0"); // 在 guest 里当 root
    a.add("-r");
    a.add(root.getAbsolutePath());
    for (String bind : new String[]{"/dev", "/proc", "/sys"}) {
      a.add("-b");
      a.add(bind);
    }
    if (new File("/sdcard").exists()) {
      a.add("-b");
      a.add("/sdcard:/sdcard");
    }
    if (new File("/storage").exists()) {
      a.add("-b");
      a.add("/storage:/storage");
    }
    if (bindCwd) {
      a.add("-b");
      a.add(cwdPath + ":" + cwdPath);
      a.add("-w");
      a.add(cwdPath);
    } else {
      a.add("-w");
      a.add("/root");
    }
    a.add("/usr/bin/env");
    a.add("-i");
    a.add("HOME=/root");
    a.add("LANG=C.UTF-8");
    a.add("TERM=xterm-256color");
    a.add("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    return a;
  }

  /** 在 guest 里跑一条命令的 argv（给 ProcessBuilder）。 */
  public List<String> command(String command, File cwd) {
    List<String> a = baseArgv(cwd);
    a.add("/bin/sh");
    a.add("-lc");
    a.add(command);
    return a;
  }

  /** 常驻会话终端：argv 到 /bin/sh 为止，之后的命令往它的 stdin 写 */
  public List<String> shellArgv(File cwd) {
    List<String> a = baseArgv(cwd);
    a.add("/bin/sh");
    return a;
  }

  /**
   * 常驻会话终端（带 PTY）：guest 里的 `script` 会给 /bin/sh 分配一个**真伪终端**。
   * 有了 PTY，sh 才会像在真终端里一样：打印提示符、逐键回显、退格、Ctrl+C 都正常。
   */
  public List<String> ptyArgv(File cwd) {
    List<String> a = baseArgv(cwd);
    a.add("/usr/bin/script");
    a.add("-qfc");
    a.add("/bin/sh");
    a.add("/dev/null");
    return a;
  }

  /** proot 自身需要的环境（loader 路径、库路径）。 */
  public Map<String, String> environment() {
    Map<String, String> env = new HashMap<>();
    env.put("PROOT_LOADER", new File(base, "loader").getAbsolutePath());
    env.put("PROOT_LOADER_32", new File(base, "loader32").getAbsolutePath());
    env.put("PROOT_TMP_DIR", tmp.getAbsolutePath());
    env.put("LD_LIBRARY_PATH", base.getAbsolutePath());
    env.put("HOME", new File(root, "root").getAbsolutePath());
    env.put("TMPDIR", tmp.getAbsolutePath());
    return env;
  }

  public File workDir() { return base; }
}
