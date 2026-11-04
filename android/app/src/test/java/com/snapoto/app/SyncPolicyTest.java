package com.snapoto.app;

import static org.junit.Assert.*;

import java.util.*;
import org.json.*;
import org.junit.Test;

public class SyncPolicyTest {

  private static JSONObject rec(String state, String space, String user)
    throws Exception {
    return new JSONObject()
      .put("id", "c1")
      .put("state", state)
      .put("space_id", space)
      .put("user_id", user);
  }

  @Test
  public void signedOutCapturesNeverUpload() throws Exception {
    assertFalse(SyncPolicy.eligible(rec("pending", "local", "local"), "u1", true));
    assertFalse(SyncPolicy.eligible(rec("pending", "", "u1"), "u1", true));
  }

  @Test
  public void onlyTheCapturingUserUploadsToTheCaptureSpace() throws Exception {
    assertTrue(SyncPolicy.eligible(rec("pending", "team1", "u1"), "u1", false));
    assertFalse(SyncPolicy.eligible(rec("pending", "team1", "u1"), "u2", false));
    assertFalse(SyncPolicy.eligible(rec("pending", "team1", "u1"), "", false));
  }

  @Test
  public void unfinishedAndSyncedRecordsAreSkipped() throws Exception {
    for (String s : new String[] { "processing", "awaiting_selfie", "synced" })
      assertFalse(s, SyncPolicy.eligible(rec(s, "team1", "u1"), "u1", true));
    // A crash mid-upload leaves "uploading": it must be resumed.
    assertTrue(SyncPolicy.eligible(rec("uploading", "team1", "u1"), "u1", false));
    assertTrue(SyncPolicy.eligible(rec("error", "team1", "u1"), "u1", false));
  }

  @Test
  public void needsAttentionOnlyRetriesManually() throws Exception {
    JSONObject r = rec("needs_attention", "team1", "u1");
    assertFalse(SyncPolicy.eligible(r, "u1", false));
    assertTrue(SyncPolicy.eligible(r, "u1", true));
  }

  @Test
  public void classifiesFailures() {
    assertEquals(SyncPolicy.Outcome.RETRY, SyncPolicy.classify(new java.io.IOException("offline")));
    assertEquals(SyncPolicy.Outcome.RETRY, SyncPolicy.classify(new Api.HttpException(503, "x")));
    assertEquals(SyncPolicy.Outcome.RETRY, SyncPolicy.classify(new Api.HttpException(429, "x")));
    assertEquals(SyncPolicy.Outcome.RETRY, SyncPolicy.classify(new Api.HttpException(409, "resume")));
    assertEquals(SyncPolicy.Outcome.SIGN_IN, SyncPolicy.classify(new Api.HttpException(401, "x")));
    assertEquals(SyncPolicy.Outcome.ATTENTION, SyncPolicy.classify(new Api.HttpException(403, "x")));
    assertEquals(SyncPolicy.Outcome.ATTENTION, SyncPolicy.classify(new Api.HttpException(413, "x")));
    assertEquals(SyncPolicy.Outcome.ATTENTION, SyncPolicy.classify(new Api.HttpException(422, "x")));
    assertEquals(
      SyncPolicy.Outcome.ATTENTION,
      SyncPolicy.classify(new Exception("wrap", new SyncPolicy.PermanentFailure("missing")))
    );
  }

  @Test
  public void uploadMetadataIsStableAcrossLocalBookkeeping() throws Exception {
    JSONObject r = rec("error", "team1", "u1")
      .put("captured_at_device", "2026-11-03T10:00:00Z")
      .put("note", "dock 4")
      .put("gps", JSONObject.NULL)
      .put("error", "timeout")
      .put("file", "c1.jpg")
      .put("sha256", "ab")
      .put("rendered", new JSONObject().put("file", "c1-rendered.jpg"));
    String first = SyncPolicy.metadata(r).toString();
    r.put("state", "uploading").put("error", "other").put("attempts", 3);
    assertEquals(first, SyncPolicy.metadata(r).toString());
    JSONObject m = SyncPolicy.metadata(r);
    assertFalse(m.has("space_id"));
    assertFalse(m.has("user_id"));
    assertFalse(m.has("gps")); // null is omitted, server accepts missing
    assertEquals("dock 4", m.getString("note"));
  }

  @Test
  public void syncedOnlyWhenServerConfirmsEveryHash() throws Exception {
    JSONObject ok = new JSONObject()
      .put("hash_check", "verified")
      .put(
        "assets",
        new JSONArray()
          .put(new JSONObject().put("sha256", "aa"))
          .put(new JSONObject().put("sha256", "bb"))
      );
    assertNull(SyncPolicy.verifyStored(ok, Arrays.asList("aa", "bb")));
    assertNotNull(SyncPolicy.verifyStored(ok, Arrays.asList("aa", "cc")));
    assertNotNull(SyncPolicy.verifyStored(new JSONObject(), Arrays.asList("aa")));
    ok.put("hash_check", "failed");
    assertNotNull(SyncPolicy.verifyStored(ok, Arrays.asList("aa")));
  }

  @Test
  public void galleryLabelsShowEachState() throws Exception {
    assertEquals("Waiting to upload", SyncPolicy.label(rec("pending", "t", "u"), true));
    assertTrue(SyncPolicy.label(rec("pending", "t", "u"), false).contains("off"));
    assertTrue(SyncPolicy.label(rec("pending", "local", "local"), true).contains("device only"));
    assertEquals("Uploading…", SyncPolicy.label(rec("uploading", "t", "u"), true));
    assertTrue(SyncPolicy.label(rec("synced", "t", "u"), true).startsWith("In cloud"));
    String err = SyncPolicy.label(rec("error", "t", "u").put("error", "timeout"), true);
    assertTrue(err.contains("will retry") && err.contains("timeout"));
    assertTrue(SyncPolicy.label(rec("needs_attention", "t", "u").put("error", "403"), true).contains("403"));
  }

  @Test
  public void summaryCountsStates() throws Exception {
    String s = SyncPolicy.summary(
      Arrays.asList(
        rec("synced", "t", "u"),
        rec("pending", "t", "u"),
        rec("error", "t", "u"),
        rec("pending", "local", "local")
      )
    );
    assertTrue(s, s.contains("1 in cloud") && s.contains("1 waiting") && s.contains("1 with errors") && s.contains("1 device-only"));
  }

  @Test
  public void releaseBuildsRequireHttps() {
    assertTrue(Api.allowedBase("https://snapoto.example", false));
    assertFalse(Api.allowedBase("http://10.0.2.2:4310", false));
    assertTrue(Api.allowedBase("http://10.0.2.2:4310", true));
    assertFalse(Api.allowedBase("https://", false));
    assertFalse(Api.allowedBase("", true));
    assertFalse(Api.allowedBase("ftp://x", true));
  }
}
