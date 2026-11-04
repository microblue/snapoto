package com.snapoto.app;

import static org.junit.Assert.*;

import java.time.*;
import java.util.*;
import org.json.*;
import org.junit.Test;

public class FieldRulesTest {

  @Test
  public void gpsQualityBuckets() {
    assertEquals(FieldRules.GpsQuality.NONE, FieldRules.gpsQuality(null, 0));
    assertEquals(FieldRules.GpsQuality.GOOD, FieldRules.gpsQuality(5.0, 1000));
    assertEquals(FieldRules.GpsQuality.GOOD, FieldRules.gpsQuality(20.0, 1000));
    assertEquals(FieldRules.GpsQuality.FAIR, FieldRules.gpsQuality(20.5, 1000));
    assertEquals(FieldRules.GpsQuality.FAIR, FieldRules.gpsQuality(100.0, 1000));
    assertEquals(FieldRules.GpsQuality.POOR, FieldRules.gpsQuality(101.0, 1000));
    // Stale beats accuracy: a precise fix from 3 minutes ago is red.
    assertEquals(
      FieldRules.GpsQuality.POOR,
      FieldRules.gpsQuality(3.0, FieldRules.STALE_GPS_MS + 1)
    );
  }

  @Test
  public void distanceIsRoughlyRight() {
    // 0.001° latitude ≈ 111 m.
    double d = FieldRules.distanceM(40.0, -74.0, 40.001, -74.0);
    assertEquals(111.2, d, 0.5);
  }

  @Test
  public void addressSticksUntilMovedMoreThan150m() throws Exception {
    JSONObject choice = new JSONObject()
      .put("text", "12 Oak St")
      .put("lat", 40.0)
      .put("lon", -74.0);
    // ~111 m: keep.
    assertEquals(
      FieldRules.AddressDecision.KEEP,
      FieldRules.addressDecision(choice, 40.001, -74.0, 10)
    );
    // ~222 m with a good fix: reset.
    assertEquals(
      FieldRules.AddressDecision.RESET,
      FieldRules.addressDecision(choice, 40.002, -74.0, 10)
    );
    // ~222 m but the fix itself is ±300 m: jitter, keep.
    assertEquals(
      FieldRules.AddressDecision.KEEP,
      FieldRules.addressDecision(choice, 40.002, -74.0, 300)
    );
  }

  @Test
  public void addressWithoutPositionGetsAnchored() throws Exception {
    JSONObject typed = new JSONObject().put("text", "Site 4");
    assertEquals(
      FieldRules.AddressDecision.ANCHOR,
      FieldRules.addressDecision(typed, 1, 1, 5)
    );
    assertEquals(
      FieldRules.AddressDecision.KEEP,
      FieldRules.addressDecision(null, 1, 1, 5)
    );
  }

  @Test
  public void distinctAddressesDedupesAndCaps() {
    List<String> out = FieldRules.distinctAddresses(
      Arrays.asList("1 A St", "1 a st ", "", null, "2 B St", "3 C St", "4 D St"),
      3
    );
    assertEquals(Arrays.asList("1 A St", "2 B St", "3 C St"), out);
  }

  private static JSONObject rec(String state, String space) throws Exception {
    return new JSONObject().put("state", state).put("space_id", space).put("user_id", "u1");
  }

  @Test
  public void statusKindsAndReasons() throws Exception {
    assertEquals(
      FieldRules.StatusKind.CLOUD,
      FieldRules.status(rec("synced", "t1"), true, true, false).kind
    );
    assertEquals(
      FieldRules.StatusKind.UPLOADING,
      FieldRules.status(rec("uploading", "t1"), true, true, false).kind
    );
    FieldRules.Status err = FieldRules.status(
      rec("error", "t1").put("error", "Timeout"),
      true,
      true,
      false
    );
    assertEquals(FieldRules.StatusKind.PROBLEM, err.kind);
    assertTrue(err.reason.contains("Timeout"));
    FieldRules.Status local = FieldRules.status(rec("pending", "local"), true, true, false);
    assertEquals(FieldRules.StatusKind.SAVED, local.kind);
    assertTrue(local.reason.contains("stays on this phone"));
    assertEquals(
      "Waiting for Wi-Fi",
      FieldRules.status(rec("pending", "t1"), true, true, true).reason
    );
    assertTrue(
      FieldRules.status(rec("pending", "t1"), true, false, false).reason.contains("off")
    );
  }

  @Test
  public void countsBuckets() throws Exception {
    int[] c = FieldRules.counts(
      Arrays.asList(
        rec("synced", "t1"),
        rec("uploading", "t1"),
        rec("pending", "t1"),
        rec("needs_attention", "t1"),
        rec("pending", "local")
      )
    );
    assertArrayEquals(new int[] { 1, 1, 1, 1, 1 }, c);
  }

  @Test
  public void dayLabelsAndGrouping() throws Exception {
    LocalDate today = LocalDate.of(2026, 11, 4);
    assertEquals("Today", FieldRules.dayLabel(today, today));
    assertEquals("Yesterday", FieldRules.dayLabel(today.minusDays(1), today));
    assertEquals("Mon, Nov 2", FieldRules.dayLabel(LocalDate.of(2026, 11, 2), today));
    assertEquals("Wed, Dec 31, 2025", FieldRules.dayLabel(LocalDate.of(2025, 12, 31), today));
    ZoneId utc = ZoneId.of("UTC");
    List<Object> g = FieldRules.groupByDay(
      Arrays.asList(
        new JSONObject().put("captured_at_device", "2026-11-04T10:00:00Z"),
        new JSONObject().put("captured_at_device", "2026-11-04T08:00:00Z"),
        new JSONObject().put("captured_at_device", "2026-11-03T08:00:00Z")
      ),
      utc,
      today
    );
    assertEquals(5, g.size());
    assertEquals("Today", g.get(0));
    assertEquals("Yesterday", g.get(3));
  }

  @Test
  public void findingsParsingDropsJunkAndClampsValues() throws Exception {
    JSONObject ai = new JSONObject(
      "{\"state\":\"done\",\"findings\":[" +
      "{\"id\":\"f1\",\"field\":\"order_number\",\"value\":\" SO-48213 \",\"confidence\":0.93,\"where\":\"label\",\"status\":\"proposed\"}," +
      "{\"id\":\"f2\",\"field\":\"password\",\"value\":\"x\"}," +
      "{\"id\":\"\",\"field\":\"plate\",\"value\":\"ABC\"}," +
      "{\"id\":\"f3\",\"field\":\"plate\",\"value\":\"\"}," +
      "{\"id\":\"f4\",\"field\":\"meter\",\"value\":\"0042\",\"confidence\":7,\"status\":\"weird\"}," +
      "{\"id\":\"f5\",\"field\":\"serial\",\"value\":\"S1\",\"accepted_value\":\"S1-B\",\"status\":\"accepted\"}" +
      "]}"
    );
    List<FieldRules.Finding> f = FieldRules.findings(ai);
    assertEquals(3, f.size());
    assertEquals("SO-48213", f.get(0).value);
    assertTrue(f.get(0).proposed());
    assertEquals(0.93, f.get(0).confidence, 1e-9);
    assertEquals(1.0, f.get(1).confidence, 1e-9);
    assertEquals("proposed", f.get(1).status);
    assertEquals("S1-B", f.get(2).value);
    assertFalse(f.get(2).proposed());
    assertTrue(FieldRules.findings(null).isEmpty());
    assertTrue(FieldRules.findings(new JSONObject()).isEmpty());
  }

  @Test
  public void captionPrefersHumanEdit() throws Exception {
    JSONObject cloud = new JSONObject()
      .put("ai", new JSONObject().put("state", "done").put("caption", "AI text"));
    assertEquals("AI text", FieldRules.caption(cloud));
    cloud.put("caption", "Human text");
    assertEquals("Human text", FieldRules.caption(cloud));
    JSONObject pending = new JSONObject()
      .put("ai", new JSONObject().put("state", "pending").put("caption", "x"));
    assertEquals("", FieldRules.caption(pending));
    assertEquals("", FieldRules.caption(null));
  }

  @Test
  public void reviewOnlyOwnCloudPhotosWhileSignedIn() throws Exception {
    JSONObject r = rec("synced", "t1");
    assertTrue(FieldRules.canReview(r, "u1", true));
    assertFalse(FieldRules.canReview(r, "u1", false));
    assertFalse(FieldRules.canReview(r, "u2", true));
    assertFalse(FieldRules.canReview(rec("pending", "t1"), "u1", true));
    assertFalse(FieldRules.canReview(rec("synced", "local"), "u1", true));
  }

  @Test
  public void cloudRefreshThrottle() throws Exception {
    JSONObject r = rec("synced", "t1");
    assertTrue(FieldRules.shouldRefreshCloud(r, 1000, 60000));
    r.put("cloud", new JSONObject().put("fetched_at_ms", 0).put("ai", new JSONObject().put("state", "pending")));
    assertFalse(FieldRules.shouldRefreshCloud(r, 30000, 60000));
    assertTrue(FieldRules.shouldRefreshCloud(r, 70000, 60000));
    r.getJSONObject("cloud").getJSONObject("ai").put("state", "done");
    assertFalse(FieldRules.shouldRefreshCloud(r, 70000, 60000));
    // No ai block = AI off: only re-checked rarely.
    r.put("cloud", new JSONObject().put("fetched_at_ms", 0));
    assertFalse(FieldRules.shouldRefreshCloud(r, 70000, 60000));
    assertTrue(FieldRules.shouldRefreshCloud(r, FieldRules.OFF_RECHECK_MS, 60000));
  }

  @Test
  public void cloudCacheIsAllowListed() throws Exception {
    JSONObject cap = new JSONObject()
      .put("ai", new JSONObject())
      .put("order_number", "SO-1")
      .put("assets", new JSONArray())
      .put("signed_manifest", "x");
    JSONObject c = FieldRules.cloudCache(cap, 5);
    assertTrue(c.has("ai"));
    assertTrue(c.has("order_number"));
    assertFalse(c.has("assets"));
    assertFalse(c.has("signed_manifest"));
    assertEquals(5, c.getLong("fetched_at_ms"));
  }

  @Test
  public void inviteTokenFromLinkOrCode() {
    String t = "ab".repeat(32);
    assertEquals(t, FieldRules.inviteToken("https://snapoto.vercel.app/?invite=" + t));
    assertEquals(t, FieldRules.inviteToken("  " + t.toUpperCase() + " "));
    assertEquals(t, FieldRules.inviteToken("Join us: https://x.app/?a=1&invite=" + t + "&b=2"));
    assertNull(FieldRules.inviteToken("https://x.app/?invite=" + t + "ff"));
    assertNull(FieldRules.inviteToken("hello"));
    assertNull(FieldRules.inviteToken(null));
  }

  @Test
  public void switchingTemplatesKeepsTeamLocks() throws Exception {
    JSONObject def = new JSONObject()
      .put("id", "d")
      .put("is_default", true)
      .put("locked_fields", new JSONArray().put("company").put("gps"));
    JSONObject other = new JSONObject()
      .put("id", "o")
      .put("locked_fields", new JSONArray().put("date"));
    JSONObject out = FieldRules.withTeamLocks(other, def);
    List<String> locks = new ArrayList<>();
    for (int i = 0; i < out.getJSONArray("locked_fields").length(); i++) locks.add(out.getJSONArray("locked_fields").getString(i));
    assertEquals(Arrays.asList("date", "company", "gps"), locks);
    assertEquals("o", out.getString("id"));
  }

  @Test
  public void refreshKeepsPickOrFallsBackToDefault() throws Exception {
    JSONArray items = new JSONArray()
      .put(new JSONObject().put("id", "d").put("is_default", true).put("version", 2).put("locked_fields", new JSONArray().put("company")))
      .put(new JSONObject().put("id", "o").put("version", 5));
    // Current team pick survives with fresh server version + default locks.
    JSONObject keep = FieldRules.afterRefresh(new JSONObject().put("id", "o").put("version", 1), items);
    assertEquals("o", keep.getString("id"));
    assertEquals(5, keep.getInt("version"));
    assertTrue(Watermark.isLocked(keep, "company"));
    // Deleted pick → default.
    assertEquals("d", FieldRules.afterRefresh(new JSONObject().put("id", "gone"), items).getString("id"));
    // Nothing picked yet → default.
    assertEquals("d", FieldRules.afterRefresh(null, items).getString("id"));
    // Own template stays, but gains the team locks.
    JSONObject mine = FieldRules.afterRefresh(new JSONObject().put("name", "My watermark").put("local", true), items);
    assertTrue(mine.optBoolean("local"));
    assertTrue(Watermark.isLocked(mine, "company"));
    assertNull(FieldRules.afterRefresh(null, new JSONArray()));
  }

  @Test
  public void releaseBuildsDefaultToProduction() {
    assertEquals("https://snapoto.vercel.app", Api.defaultBase(false));
    assertEquals("", Api.defaultBase(true));
    assertTrue(Api.allowedBase(Api.defaultBase(false), false));
  }
}
