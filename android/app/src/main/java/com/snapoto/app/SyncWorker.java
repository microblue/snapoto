package com.snapoto.app;

import android.content.Context;
import androidx.work.*;
import java.io.File;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.json.*;

public class SyncWorker extends Worker {

  static final String MANUAL = "manual";

  public SyncWorker(Context c, WorkerParameters p) {
    super(c, p);
  }

  /** Automatic sync after a capture or network change. */
  public static void enqueue(Context c) {
    enqueue(c, false);
  }

  /**
   * manual=true is the employee tapping "Retry": it also retries records that
   * stopped for a human reason (403 etc.) and replaces a run that may be
   * sleeping in exponential backoff, so the tap takes effect now. Replacing a
   * running upload is safe because uploads resume from server offsets.
   */
  public static void enqueue(Context c, boolean manual) {
    OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(SyncWorker.class)
      .setConstraints(
        new Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build()
      )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .setInputData(new Data.Builder().putBoolean(MANUAL, manual).build())
      .build();
    WorkManager.getInstance(c).enqueueUniqueWork(
      "snapoto-sync",
      manual ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.APPEND_OR_REPLACE,
      req
    );
  }

  private static void mark(File file, String state, String error) {
    try {
      CaptureStore.update(file, cur -> {
        cur.put("state", state);
        if (error == null) cur.remove("error");
        else cur.put("error", error);
      });
    } catch (Exception ignored) {}
  }

  /** Verify a sidecar asset against the hash recorded at capture time. */
  private static String sidecarHash(File f, JSONObject r, String key)
    throws Exception {
    if (!f.isFile()) throw new SyncPolicy.PermanentFailure(
      "Local file missing: " + f.getName()
    );
    String actual = CaptureStore.digest(f);
    String expected = r.optString(key, "");
    if (!expected.isEmpty() && !expected.equals(actual)) throw new SyncPolicy.PermanentFailure(
      "Local file changed since capture: " + f.getName()
    );
    return actual;
  }

  private static JSONObject asset(String kind, String mime, String sha, File f)
    throws JSONException {
    return new JSONObject()
      .put("kind", kind)
      .put("mime", mime)
      .put("sha256", sha)
      .put("bytes", f.length());
  }

  @Override
  public Result doWork() {
    Context c = getApplicationContext();
    var prefs = c.getSharedPreferences("account", 0);
    if (
      !prefs.getBoolean("cloud", false) ||
      prefs.getString("token", "").isEmpty()
    ) return Result.success();
    String user = prefs.getString("user", "");
    boolean manual = getInputData().getBoolean(MANUAL, false);
    boolean retry = false;
    File dir = CaptureStore.directory(c);
    for (JSONObject r : CaptureStore.all(c)) {
      if (isStopped()) return Result.retry();
      if (!SyncPolicy.eligible(r, user, manual)) continue;
      File recordFile = CaptureStore.recordFile(c, r.optString("id"));
      try {
        File original = new File(dir, r.getString("file"));
        if (!original.isFile()) throw new SyncPolicy.PermanentFailure(
          "Original file is missing on this device"
        );
        if (
          !CaptureStore.digest(original).equals(r.getString("sha256"))
        ) throw new SyncPolicy.PermanentFailure(
          "Local file integrity check failed"
        );
        List<File> files = new ArrayList<>();
        List<String> hashes = new ArrayList<>();
        JSONArray assets = new JSONArray();
        boolean video = r.optString("kind").equals("video");
        assets.put(
          asset(
            video ? "video" : "original",
            video ? "video/mp4" : "image/jpeg",
            r.getString("sha256"),
            original
          )
        );
        files.add(original);
        hashes.add(r.getString("sha256"));
        if (r.has("selfie_file")) {
          File f = new File(dir, r.getString("selfie_file"));
          String h = sidecarHash(f, r, "selfie_sha256");
          assets.put(asset("selfie", "image/jpeg", h, f));
          files.add(f);
          hashes.add(h);
        }
        if (r.has("audio_file")) {
          File f = new File(dir, r.getString("audio_file"));
          String h = sidecarHash(f, r, "audio_sha256");
          assets.put(asset("audio", "audio/mp4", h, f));
          files.add(f);
          hashes.add(h);
        }
        JSONObject body = SyncPolicy.metadata(r).put("assets", assets);
        mark(recordFile, SyncPolicy.UPLOADING, null);
        JSONObject stored = Api.upload(c, r.getString("space_id"), body, files);
        String mismatch = SyncPolicy.verifyStored(stored, hashes);
        if (mismatch != null) throw new SyncPolicy.PermanentFailure(mismatch);
        String received = stored.optString("server_received_at", "");
        CaptureStore.update(recordFile, cur -> {
          cur.put("state", SyncPolicy.SYNCED);
          cur.remove("error");
          if (!received.isEmpty()) cur.put("server_received_at", received);
        });
      } catch (Exception e) {
        switch (SyncPolicy.classify(e)) {
          case SIGN_IN:
            mark(
              recordFile,
              SyncPolicy.ERROR,
              "Session expired. Sign in again in Me; the photo stays on this device."
            );
            // Every further request would fail the same way; stop until the
            // user signs in (sign-in enqueues a new sync).
            return Result.success();
          case ATTENTION:
            mark(
              recordFile,
              SyncPolicy.NEEDS_ATTENTION,
              e.getMessage() + ". Not retried automatically; fix access or storage, then tap Retry."
            );
            break;
          default:
            retry = true;
            mark(recordFile, SyncPolicy.ERROR, String.valueOf(e.getMessage()));
        }
      }
    }
    return retry ? Result.retry() : Result.success();
  }
}
