package com.snapoto.app;

import java.util.*;
import org.json.*;

/**
 * Pure (Android-free) sync decisions so they can be unit tested on the JVM:
 * which records may upload, how a failure is classified, and what the
 * employee sees in Photos / Me (PRD §4.1, §6, §14).
 */
public final class SyncPolicy {

  private SyncPolicy() {}

  public static final String PROCESSING = "processing";
  public static final String AWAITING_SELFIE = "awaiting_selfie";
  public static final String PENDING = "pending";
  public static final String UPLOADING = "uploading";
  public static final String SYNCED = "synced";
  public static final String ERROR = "error";
  public static final String NEEDS_ATTENTION = "needs_attention";

  /** What to do after a failed upload attempt. */
  public enum Outcome {
    /** Transient (offline, timeout, 5xx, 408/409/429): back off and retry. */
    RETRY,
    /** Permanent for this record (4xx, local integrity): only manual retry. */
    ATTENTION,
    /** Session invalid (401): stop the whole run until the user signs in. */
    SIGN_IN,
  }

  /** Thrown for failures that retrying cannot fix (missing/changed file). */
  public static final class PermanentFailure extends Exception {

    public PermanentFailure(String message) {
      super(message);
    }
  }

  public static Outcome classify(Throwable e) {
    for (Throwable t = e; t != null; t = t.getCause()) {
      if (t instanceof PermanentFailure) return Outcome.ATTENTION;
      if (t instanceof Api.HttpException) {
        int s = ((Api.HttpException) t).status;
        if (s == 401) return Outcome.SIGN_IN;
        if (s == 408 || s == 409 || s == 429 || s >= 500) return Outcome.RETRY;
        if (s == 410) return Outcome.RETRY; // expired upload session: restart
        return Outcome.ATTENTION;
      }
    }
    return Outcome.RETRY;
  }

  /**
   * Whether this record may be uploaded by the signed-in user right now.
   * Space ownership is fixed at capture: a record only ever uploads to the
   * space_id it was captured in, by the user who captured it. Local-only
   * (signed-out) captures never upload.
   */
  public static boolean eligible(JSONObject r, String user, boolean manual) {
    String state = r.optString("state");
    if (
      state.equals(SYNCED) ||
      state.equals(PROCESSING) ||
      state.equals(AWAITING_SELFIE)
    ) return false;
    if (state.equals(NEEDS_ATTENTION) && !manual) return false;
    String space = r.optString("space_id");
    if (space.isEmpty() || space.equals("local")) return false;
    return !user.isEmpty() && r.optString("user_id").equals(user);
  }

  /**
   * Upload metadata from an allow-list. The server fingerprints the upload
   * metadata for idempotency, so local bookkeeping (state, error, attempts,
   * rendered copy...) must never leak into it or a retry gets a 409.
   */
  public static JSONObject metadata(JSONObject r) throws JSONException {
    JSONObject body = new JSONObject();
    for (String k : new String[] {
      "id",
      "captured_at_device",
      "selfie_captured_at",
      "camera_time_delta_ms",
      "gps",
      "note",
      "address",
      "collection",
    })
      if (r.has(k) && !r.isNull(k)) body.put(k, r.get(k));
    return body;
  }

  /**
   * Server confirmation that every local asset hash was stored. Returns null
   * when verified, otherwise a reason. 2xx alone is not proof of integrity.
   */
  public static String verifyStored(JSONObject response, List<String> hashes) {
    String check = response.optString("hash_check", "");
    if (!check.isEmpty() && !check.equals("verified")) return (
      "Server integrity check: " + check
    );
    JSONArray assets = response.optJSONArray("assets");
    if (assets == null) return "Server did not confirm stored files";
    Set<String> stored = new HashSet<>();
    for (int i = 0; i < assets.length(); i++) {
      JSONObject a = assets.optJSONObject(i);
      if (a != null) stored.add(a.optString("sha256"));
    }
    for (String h : hashes) if (!stored.contains(h)) return (
      "Server copy does not match the local SHA-256"
    );
    return null;
  }

  /** Short employee-facing status for one record (Photos list). */
  public static String label(JSONObject r, boolean cloudAllowed) {
    String state = r.optString("state");
    String error = r.optString("error", "");
    boolean local =
      r.optString("space_id").isEmpty() ||
      r.optString("space_id").equals("local");
    switch (state) {
      case PROCESSING:
        return "Saved on device · preparing";
      case AWAITING_SELFIE:
        return "Saved on device · taking front photo";
      case UPLOADING:
        return "Uploading…";
      case SYNCED:
        return "In cloud · SHA-256 verified";
      case ERROR:
        return "Upload error · will retry" + (error.isEmpty() ? "" : "\n" + error);
      case NEEDS_ATTENTION:
        return (
          "Upload stopped · needs attention" + (error.isEmpty() ? "" : "\n" + error)
        );
      default:
        if (local) return "On this device only (taken while signed out)";
        if (!cloudAllowed) return "Waiting to upload · background upload is off (Me)";
        return "Waiting to upload";
    }
  }

  /** One-line sync summary for the Me tab. */
  public static String summary(List<JSONObject> rows) {
    int waiting = 0, uploading = 0, synced = 0, failed = 0, local = 0;
    for (JSONObject r : rows) {
      String s = r.optString("state");
      String space = r.optString("space_id");
      if (s.equals(SYNCED)) synced++;
      else if (s.equals(UPLOADING)) uploading++;
      else if (s.equals(ERROR) || s.equals(NEEDS_ATTENTION)) failed++;
      else if (space.isEmpty() || space.equals("local")) local++;
      else waiting++;
    }
    return (
      "Sync: " +
      synced +
      " in cloud · " +
      uploading +
      " uploading · " +
      waiting +
      " waiting · " +
      failed +
      " with errors · " +
      local +
      " device-only"
    );
  }
}
