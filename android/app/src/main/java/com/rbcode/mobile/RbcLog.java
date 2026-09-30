package com.rbcode.mobile;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Deque;
import java.util.Locale;

/** 最近 RPC 调用的环形日志，供 App 界面查看（排查「卡住」用）。 */
public final class RbcLog {
  public static final class Entry {
    final long at;
    final String op;
    final long ms;
    final boolean ok;
    final String error;

    Entry(long at, String op, long ms, boolean ok, String error) {
      this.at = at;
      this.op = op;
      this.ms = ms;
      this.ok = ok;
      this.error = error;
    }
  }

  private static final int MAX = 80;
  private static final Deque<Entry> entries = new ArrayDeque<>();
  private static final SimpleDateFormat FMT = new SimpleDateFormat("HH:mm:ss", Locale.ROOT);

  public static synchronized void add(String op, long ms, boolean ok, String error) {
    entries.addLast(new Entry(System.currentTimeMillis(), op, ms, ok, error));
    while (entries.size() > MAX) entries.removeFirst();
  }

  public static synchronized String dump() {
    if (entries.isEmpty()) return "（还没有请求）";
    StringBuilder sb = new StringBuilder();
    for (Entry e : entries) {
      sb.append(FMT.format(new Date(e.at)))
          .append(' ').append(e.op)
          .append(" · ").append(e.ms).append("ms")
          .append(e.ok ? " · ok" : " · 失败: " + e.error)
          .append('\n');
    }
    return sb.toString();
  }
}
