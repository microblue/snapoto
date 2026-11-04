package com.snapoto.app;

import android.content.Context;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

public final class CaptureStore {

  /** Minimum usable bytes required before a photo capture starts. */
  public static final long MIN_FREE_PHOTO = 10L * 1024 * 1024;
  /** Minimum usable bytes required before a video capture starts. */
  public static final long MIN_FREE_VIDEO = 30L * 1024 * 1024;

  /**
   * True when a failure means the device ran out of space. Matches ENOSPC
   * and "No space left on device" from the exception or its string form.
   */
  public static boolean isNoSpace(Throwable e) {
    if (e == null) return false;
    String hay = (String.valueOf(e.getMessage()) + "\n" + e.toString())
      .toLowerCase(java.util.Locale.US);
    return hay.contains("enospc") || hay.contains("no space left");
  }

  /**
   * Pre-capture storage probe. Throws IOException (ENOSPC wording) when the
   * capture directory has fewer than needBytes usable, so callers never mark
   * a photo saved before persistent local storage completes.
   */
  public static void requireSpace(File dir, long needBytes)
    throws IOException {
    dir.mkdirs();
    long free = dir.getUsableSpace();
    if (free < needBytes) throw new IOException(
      "No space left on device (ENOSPC): " +
        free +
        " bytes usable, need " +
        needBytes +
        ". Free storage and retry."
    );
  }

  public static File directory(Context c) {
    File f = new File(c.getFilesDir(), "captures");
    f.mkdirs();
    return f;
  }

  public static String digest(byte[] bytes) throws Exception {
    StringBuilder b = new StringBuilder();
    for (byte v : MessageDigest.getInstance("SHA-256").digest(bytes))
      b.append(String.format("%02x", v));
    return b.toString();
  }

  /** Streaming SHA-256 so large videos are never loaded into memory. */
  public static String digest(File file) throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(file)) {
      byte[] chunk = new byte[64 * 1024];
      int n;
      while ((n = in.read(chunk)) != -1) md.update(chunk, 0, n);
    }
    StringBuilder b = new StringBuilder();
    for (byte v : md.digest()) b.append(String.format("%02x", v));
    return b.toString();
  }

  /**
   * Serialises every metadata write in the process. The activity, the render
   * executor and SyncWorker all write records; without this two writers could
   * share the same ".tmp" file and one would publish a torn record.
   */
  static final Object LOCK = new Object();

  /** fsync a file's bytes. Used for originals written by CameraX/MediaRecorder. */
  public static void syncFile(File file) throws IOException {
    try (RandomAccessFile f = new RandomAccessFile(file, "rw")) {
      f.getFD().sync();
    }
    syncDir(file.getParentFile());
  }

  /**
   * fsync the directory so a newly created or renamed entry survives power
   * loss, not only its bytes. Best effort: some filesystems refuse it.
   */
  static void syncDir(File dir) {
    if (dir == null) return;
    try (
      java.nio.channels.FileChannel ch = java.nio.channels.FileChannel.open(
        dir.toPath(),
        java.nio.file.StandardOpenOption.READ
      )
    ) {
      ch.force(true);
    } catch (Exception ignored) {}
  }

  public static void atomic(File file, JSONObject value) throws Exception {
    synchronized (LOCK) {
      File tmp = new File(file.getPath() + ".tmp");
      try (FileOutputStream out = new FileOutputStream(tmp)) {
        out.write(
          value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );
        out.getFD().sync();
      }
      if (!tmp.renameTo(file)) {
        tmp.delete();
        throw new IOException("Could not persist capture metadata");
      }
      syncDir(file.getParentFile());
    }
  }

  /** Mutation applied to the freshest on-disk copy of a record. */
  public interface Mutation {
    void apply(JSONObject current) throws Exception;
  }

  /**
   * Read-modify-write under the store lock. Re-reads the record from disk so a
   * long-running caller (e.g. an upload) never overwrites fields another
   * writer changed in the meantime with its stale in-memory copy.
   */
  public static JSONObject update(File file, Mutation m) throws Exception {
    synchronized (LOCK) {
      JSONObject current = new JSONObject(
        new String(
          Files.readAllBytes(file.toPath()),
          java.nio.charset.StandardCharsets.UTF_8
        )
      );
      m.apply(current);
      atomic(file, current);
      return current;
    }
  }

  public static File recordFile(Context c, String id) {
    return new File(directory(c), id + ".json");
  }

  public static JSONObject save(
    Context c,
    File original,
    String cid,
    String space,
    String user,
    String timestamp,
    JSONObject gps,
    String note
  ) throws Exception {
    return save(c, original, cid, space, user, timestamp, gps, note, null);
  }

  /**
   * Persist the original (fsync file + directory) and its metadata. Only when
   * this returns may the UI say "Saved". extra fields (address, audio, ...)
   * are written in the same atomic record so a later failure cannot lose them.
   */
  public static JSONObject save(
    Context c,
    File original,
    String cid,
    String space,
    String user,
    String timestamp,
    JSONObject gps,
    String note,
    JSONObject extra
  ) throws Exception {
    if (!original.isFile() || original.length() == 0) throw new IOException(
      "Camera produced no data"
    );
    syncFile(original);
    JSONObject r = new JSONObject()
      .put("id", cid)
      .put("space_id", space)
      .put("user_id", user)
      .put("captured_at_device", timestamp)
      .put("gps", gps == null ? JSONObject.NULL : gps)
      .put("note", note)
      .put("address", "")
      .put("collection", "")
      .put("file", original.getName())
      .put("bytes", original.length())
      .put("timezone", java.util.TimeZone.getDefault().getID())
      .put("sha256", digest(original))
      .put("state", "processing");
    if (extra != null) for (Iterator<String> k = extra.keys(); k.hasNext();) {
      String key = k.next();
      r.put(key, extra.get(key));
    }
    atomic(new File(directory(c), cid + ".json"), r);
    return r;
  }

  public static List<JSONObject> all(Context c) {
    List<JSONObject> rows = new ArrayList<>();
    File[] files = directory(c).listFiles((d, n) -> n.endsWith(".json"));
    if (files != null) for (File f : files)
      try {
        rows.add(
          new JSONObject(
            new String(
              Files.readAllBytes(f.toPath()),
              java.nio.charset.StandardCharsets.UTF_8
            )
          )
        );
      } catch (Exception ignored) {}
    rows.sort((a, b) ->
      b
        .optString("captured_at_device")
        .compareTo(a.optString("captured_at_device"))
    );
    return rows;
  }
}
