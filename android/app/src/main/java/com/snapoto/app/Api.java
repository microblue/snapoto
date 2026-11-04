package com.snapoto.app;

import android.content.Context;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class Api {

  /** HTTP failure carrying its status code so callers can branch on it. */
  public static final class HttpException extends Exception {

    public final int status;

    public HttpException(int status, String message) {
      super(message);
      this.status = status;
    }
  }

  static final int CHUNK = 512 * 1024;

  /**
   * Release builds must only talk HTTPS (manifest also disables cleartext);
   * debuggable builds may use a LAN http:// server for development.
   */
  public static boolean allowedBase(String base, boolean debuggable) {
    if (base == null || base.isEmpty()) return false;
    if (base.startsWith("https://")) return base.length() > 8;
    return debuggable && base.startsWith("http://") && base.length() > 7;
  }

  /** Production server used by release builds when none was entered. */
  public static final String RELEASE_BASE = "https://snapoto.vercel.app";

  /**
   * Default server: release builds point at production; debug builds keep
   * the previous behaviour (no default, the developer enters a URL).
   */
  public static String defaultBase(boolean debuggable) {
    return debuggable ? "" : RELEASE_BASE;
  }

  /** Server in use: the saved one, else the build's default. */
  public static String base(Context ctx) {
    String saved = ctx
      .getSharedPreferences("account", 0)
      .getString("server", "");
    return saved.isEmpty() ? defaultBase(debuggable(ctx)) : saved;
  }

  static boolean debuggable(Context ctx) {
    return (
      (ctx.getApplicationInfo().flags &
        android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) !=
      0
    );
  }

  private static HttpURLConnection open(Context ctx, String endpoint)
    throws Exception {
    String base = base(ctx);
    if (base.isEmpty()) throw new Exception("Sign in to enable cloud sync");
    if (!allowedBase(base, debuggable(ctx))) throw new Exception(
      "HTTPS is required for the server URL"
    );
    return (HttpURLConnection) new URL(base + endpoint).openConnection();
  }

  public static JSONObject request(
    Context ctx,
    String endpoint,
    String method,
    JSONObject data
  ) throws Exception {
    var p = ctx.getSharedPreferences("account", 0);
    HttpURLConnection c = open(ctx, endpoint);
    c.setConnectTimeout(15000);
    c.setReadTimeout(30000);
    c.setRequestMethod(method);
    if (!endpoint.startsWith("/api/auth/")) c.setRequestProperty(
      "Authorization",
      "Bearer " + p.getString("token", "")
    );
    try {
      if (data != null) {
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (var out = c.getOutputStream()) {
          out.write(data.toString().getBytes(StandardCharsets.UTF_8));
        }
      }
      int status = c.getResponseCode();
      java.io.InputStream in = status >= 400
        ? c.getErrorStream()
        : c.getInputStream();
      if (in == null) {
        if (status >= 400) throw new HttpException(
          status,
          "HTTP " + status
        );
        return new JSONObject();
      }
      try (var autoClose = in) {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = autoClose.read(chunk)) != -1) buf.write(chunk, 0, n);
        String value = new String(buf.toByteArray(), StandardCharsets.UTF_8);
        if (status >= 400) {
          String detail;
          try {
            detail = new JSONObject(value).optString("error", "HTTP " + status);
          } catch (Exception parseError) {
            detail = value.isEmpty() ? "HTTP " + status : value;
          }
          throw new HttpException(status, detail + " (HTTP " + status + ")");
        }
        return value.trim().startsWith("[")
          ? new JSONObject().put("items", new org.json.JSONArray(value))
          : new JSONObject(value);
      }
    } finally {
      c.disconnect();
    }
  }

  /** PUT one chunk read straight from the file; never buffers whole assets. */
  public static void chunk(
    Context ctx,
    String endpoint,
    java.io.File file,
    long offset,
    int count
  ) throws Exception {
    var p = ctx.getSharedPreferences("account", 0);
    byte[] buf = new byte[count];
    try (java.io.RandomAccessFile f = new java.io.RandomAccessFile(file, "r")) {
      f.seek(offset);
      f.readFully(buf);
    }
    HttpURLConnection c = open(ctx, endpoint);
    try {
      c.setConnectTimeout(15000);
      c.setReadTimeout(30000);
      c.setRequestMethod("PUT");
      c.setRequestProperty(
        "Authorization",
        "Bearer " + p.getString("token", "")
      );
      c.setRequestProperty("Content-Type", "application/octet-stream");
      c.setRequestProperty("X-Offset", String.valueOf(offset));
      c.setDoOutput(true);
      c.setFixedLengthStreamingMode(count);
      try (var out = c.getOutputStream()) {
        out.write(buf, 0, count);
      }
      int status = c.getResponseCode();
      if (status >= 400) throw new HttpException(
        status,
        "Chunk upload failed (HTTP " + status + ")"
      );
    } finally {
      c.disconnect();
    }
  }

  /**
   * Resumable upload. metadata.assets[i] = {kind, mime, sha256, bytes} and
   * files.get(i) is the matching local file. The server returns stored
   * offsets, so an interrupted upload resumes where it stopped; the session
   * is keyed by capture id, so retries are idempotent.
   */
  public static JSONObject upload(
    Context ctx,
    String space,
    JSONObject metadata,
    java.util.List<java.io.File> files
  ) throws Exception {
    String base = "/api/spaces/" + space;
    JSONObject upload = request(ctx, base + "/uploads", "POST", metadata);
    String uid = upload.getString("id");
    if (!upload.optBoolean("completed")) {
      org.json.JSONArray offsets = upload.getJSONArray("offsets");
      for (int i = 0; i < files.size(); i++) {
        long length = files.get(i).length();
        for (
          long offset = offsets.getLong(i);
          offset < length;
          offset += CHUNK
        ) chunk(
          ctx,
          base + "/uploads/" + uid + "/" + i,
          files.get(i),
          offset,
          (int) Math.min(CHUNK, length - offset)
        );
      }
    }
    return request(
      ctx,
      base + "/uploads/" + uid + "/complete",
      "POST",
      new JSONObject()
    );
  }
}
