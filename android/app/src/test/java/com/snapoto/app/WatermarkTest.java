package com.snapoto.app;

import static org.junit.Assert.*;

import org.json.*;
import org.junit.Test;

public class WatermarkTest {

  @Test
  public void lockedFieldsAreRenderedEvenIfDeselectedLocally() throws Exception {
    JSONObject t = new JSONObject()
      .put("fields", new JSONArray().put("date"))
      .put("locked_fields", new JSONArray().put("company").put("date"))
      .put("company", "Acme Movers");
    assertEquals(java.util.Arrays.asList("date", "company"), Watermark.effectiveFields(t));
    assertTrue(Watermark.isLocked(t, "company"));
    assertFalse(Watermark.isLocked(t, "note"));
    JSONObject r = new JSONObject().put("captured_at_device", "2026-11-03T15:00:00Z").put("timezone", "UTC");
    assertTrue(Watermark.lines(null, t, r).contains("Acme Movers"));
  }

  @Test
  public void timeIsShownInCaptureZoneWithZoneLabel() throws Exception {
    JSONObject t = new JSONObject().put("fields", new JSONArray().put("date").put("time"));
    JSONObject r = new JSONObject()
      .put("captured_at_device", "2026-11-03T02:30:00Z")
      .put("timezone", "America/Chicago");
    String lines = Watermark.lines(null, t, r);
    assertTrue(lines, lines.startsWith("2026-11-02\n20:30:00 CST (device)"));
  }

  @Test
  public void accuracyIsRoundedAndMissingGpsIsExplicit() throws Exception {
    JSONObject t = new JSONObject().put("fields", new JSONArray().put("gps").put("accuracy"));
    JSONObject r = new JSONObject()
      .put("captured_at_device", "2026-11-03T02:30:00Z")
      .put("gps", new JSONObject().put("latitude", 41.8781136).put("longitude", -87.6297982).put("accuracy", 12.6));
    assertEquals("41.878114, -87.629798\n±13 m", Watermark.lines(null, t, r));
    r.remove("gps");
    assertEquals("GPS not provided\nAccuracy unknown", Watermark.lines(null, t, r));
  }
}
