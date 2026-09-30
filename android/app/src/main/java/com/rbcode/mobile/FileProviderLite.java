package com.rbcode.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简只读文件提供者：把 file:// 换成 content:// 交给系统文件 App 打开。
 * Android 7+ 不允许直接把 file:// 暴露给别的 App，而项目没引 AndroidX，
 * 所以自己实现一个最小的 FileProvider。
 *
 * authority = 「包名.files」，URI 的 path 就是文件的绝对路径。
 */
public final class FileProviderLite extends ContentProvider {
  public static Uri uriFor(Context ctx, File file) {
    return Uri.parse("content://" + ctx.getPackageName() + ".files" + file.getAbsolutePath());
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    return ParcelFileDescriptor.open(new File(uri.getPath()), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public String getType(Uri uri) {
    return null;
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
                      String sortOrder) {
    return null;
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    return null;
  }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    return 0;
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
    return 0;
  }
}
