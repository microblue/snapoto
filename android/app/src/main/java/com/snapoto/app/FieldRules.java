package com.snapoto.app;

import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import org.json.*;

/**
 * Pure (Android-free) rules behind the V2 worker screens so they can be unit
 * tested on the JVM: GPS quality buckets, the address "sticks until you move"
 * rule, per-photo status, day grouping, AI findings parsing, invite parsing
 * and template switching with team locks.
 */
public final class FieldRules {

  private FieldRules() {}

  // ---------------------------------------------------------------- GPS

  /** Location fixes older than this are stale (matches the camera's rule). */
  public static final long STALE_GPS_MS = 2 * 60 * 1000;

  public enum GpsQuality {
    /** ≤ 20 m and fresh. */
    GOOD,
    /** ≤ 100 m and fresh. */
    FAIR,
    /** > 100 m, or older than STALE_GPS_MS. */
    POOR,
    /** No fix at all. */
    NONE,
  }

  public static GpsQuality gpsQuality(Double accuracyM, long ageMs) {
    if (accuracyM == null || accuracyM.isNaN() || accuracyM < 0) return (
      GpsQuality.NONE
    );
    if (ageMs > STALE_GPS_MS) return GpsQuality.POOR;
    if (accuracyM <= 20) return GpsQuality.GOOD;
    if (accuracyM <= 100) return GpsQuality.FAIR;
    return GpsQuality.POOR;
  }

  // ----------------------------------------------------- address choice

  /** A person-picked address stays until the device moves this far. */
  public static final double ADDRESS_STICKY_M = 150;

  public enum AddressDecision {
    /** Keep using the chosen address. */
    KEEP,
    /** Choice had no position yet: anchor it to this fix and keep it. */
    ANCHOR,
    /** Device moved away: drop the choice, go back to automatic. */
    RESET,
  }

  /** Great-circle distance in metres (haversine). */
  public static double distanceM(
    double lat1,
    double lon1,
    double lat2,
    double lon2
  ) {
    double r = 6371000;
    double dLat = Math.toRadians(lat2 - lat1);
    double dLon = Math.toRadians(lon2 - lon1);
    double a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(Math.toRadians(lat1)) *
      Math.cos(Math.toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
    return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * What to do with a chosen address when a new fix arrives. choice holds
   * {text, lat?, lon?}. A fix only counts as "moved" when the distance is
   * beyond both 150 m and the new fix's own accuracy, so GPS jitter indoors
   * never throws away an address the person picked.
   */
  public static AddressDecision addressDecision(
    JSONObject choice,
    double lat,
    double lon,
    double accuracyM
  ) {
    if (
      choice == null || choice.optString("text", "").isEmpty()
    ) return AddressDecision.KEEP;
    if (!choice.has("lat") || !choice.has("lon")) return AddressDecision.ANCHOR;
    double d = distanceM(
      choice.optDouble("lat"),
      choice.optDouble("lon"),
      lat,
      lon
    );
    return d > Math.max(ADDRESS_STICKY_M, accuracyM)
      ? AddressDecision.RESET
      : AddressDecision.KEEP;
  }

  /** Up to max distinct, non-empty address lines, in order. */
  public static List<String> distinctAddresses(List<String> lines, int max) {
    LinkedHashMap<String, String> out = new LinkedHashMap<>();
    if (lines != null) for (String l : lines) {
      if (l == null) continue;
      String t = l.trim();
      if (t.isEmpty()) continue;
      out.putIfAbsent(t.toLowerCase(Locale.ROOT), t);
      if (out.size() >= max) break;
    }
    return new ArrayList<>(out.values());
  }

  // ---------------------------------------------------------- statuses

  public enum StatusKind {
    /** Gray: safe on the phone, not (yet) in the cloud. */
    SAVED,
    /** Blue. */
    UPLOADING,
    /** Green ✓. */
    CLOUD,
    /** Red, with a reason. */
    PROBLEM,
  }

  public static final class Status {

    public final StatusKind kind;
    public final String label;
    public final String reason;

    Status(StatusKind kind, String label, String reason) {
      this.kind = kind;
      this.label = label;
      this.reason = reason;
    }
  }

  public static boolean isLocalOnly(JSONObject r) {
    String s = r.optString("space_id");
    return s.isEmpty() || s.equals("local");
  }

  /** Plain-words status for one record (Photos list, camera thumbnail dot). */
  public static Status status(
    JSONObject r,
    boolean signedIn,
    boolean cloudAllowed,
    boolean wifiOnly
  ) {
    String state = r.optString("state");
    String error = r.optString("error", "").trim();
    switch (state) {
      case SyncPolicy.UPLOADING:
        return new Status(StatusKind.UPLOADING, "Uploading…", "");
      case SyncPolicy.SYNCED:
        return new Status(StatusKind.CLOUD, "In cloud ✓", "");
      case SyncPolicy.ERROR:
        return new Status(
          StatusKind.PROBLEM,
          "Problem",
          (error.isEmpty() ? "Upload failed" : error) + " · will retry"
        );
      case SyncPolicy.NEEDS_ATTENTION:
        return new Status(
          StatusKind.PROBLEM,
          "Problem",
          error.isEmpty() ? "Upload stopped · tap Retry" : error
        );
      case SyncPolicy.PROCESSING:
      case SyncPolicy.AWAITING_SELFIE:
        return new Status(StatusKind.SAVED, "Saved on phone", "Preparing copy…");
      default:
        if (isLocalOnly(r)) return new Status(
          StatusKind.SAVED,
          "Saved on phone",
          "Taken while signed out · stays on this phone"
        );
        if (!signedIn) return new Status(
          StatusKind.SAVED,
          "Saved on phone",
          "Sign in (Me) to upload"
        );
        if (!cloudAllowed) return new Status(
          StatusKind.SAVED,
          "Saved on phone",
          "Cloud backup is off (Me)"
        );
        return new Status(
          StatusKind.SAVED,
          "Saved on phone",
          wifiOnly ? "Waiting for Wi-Fi" : "Waiting to upload"
        );
    }
  }

  /** Counts for the Me screen: [inCloud, uploading, waiting, problems, phoneOnly]. */
  public static int[] counts(List<JSONObject> rows) {
    int[] c = new int[5];
    for (JSONObject r : rows) {
      String s = r.optString("state");
      if (s.equals(SyncPolicy.SYNCED)) c[0]++;
      else if (s.equals(SyncPolicy.UPLOADING)) c[1]++;
      else if (
        s.equals(SyncPolicy.ERROR) || s.equals(SyncPolicy.NEEDS_ATTENTION)
      ) c[3]++;
      else if (isLocalOnly(r)) c[4]++;
      else c[2]++;
    }
    return c;
  }

  // ------------------------------------------------------- day grouping

  public static LocalDate day(String isoInstant, ZoneId zone) {
    try {
      return Instant.parse(isoInstant).atZone(zone).toLocalDate();
    } catch (Exception e) {
      return null;
    }
  }

  public static String dayLabel(LocalDate day, LocalDate today) {
    if (day == null) return "Unknown date";
    if (day.equals(today)) return "Today";
    if (day.equals(today.minusDays(1))) return "Yesterday";
    String pattern = day.getYear() == today.getYear()
      ? "EEE, MMM d"
      : "EEE, MMM d, yyyy";
    return day.format(DateTimeFormatter.ofPattern(pattern, Locale.US));
  }

  /**
   * Rows (already sorted newest first) interleaved with day headers. A header
   * is a String, a row is the JSONObject itself.
   */
  public static List<Object> groupByDay(
    List<JSONObject> rows,
    ZoneId zone,
    LocalDate today
  ) {
    List<Object> out = new ArrayList<>();
    String last = null;
    for (JSONObject r : rows) {
      String label = dayLabel(day(r.optString("captured_at_device"), zone), today);
      if (!label.equals(last)) {
        out.add(label);
        last = label;
      }
      out.add(r);
    }
    return out;
  }

  // -------------------------------------------------------------- AI

  public static final class Finding {

    public final String id, field, value, where, status;
    public final double confidence;

    Finding(
      String id,
      String field,
      String value,
      double confidence,
      String where,
      String status
    ) {
      this.id = id;
      this.field = field;
      this.value = value;
      this.confidence = confidence;
      this.where = where;
      this.status = status;
    }

    public boolean proposed() {
      return status.equals("proposed");
    }
  }

  static final List<String> FINDING_FIELDS = Arrays.asList(
    "order_number",
    "plate",
    "meter",
    "serial",
    "text"
  );

  public static String fieldLabel(String field) {
    switch (field) {
      case "order_number":
        return "Order #";
      case "plate":
        return "License plate";
      case "meter":
        return "Meter reading";
      case "serial":
        return "Serial #";
      default:
        return "Text";
    }
  }

  /**
   * Findings from a capture's "ai" object. Untrusted model output: unknown
   * fields, missing ids and empty values are dropped; values are trimmed and
   * capped so a hostile label cannot flood the screen.
   */
  public static List<Finding> findings(JSONObject ai) {
    List<Finding> out = new ArrayList<>();
    if (ai == null) return out;
    JSONArray rows = ai.optJSONArray("findings");
    if (rows == null) return out;
    for (int i = 0; i < rows.length() && out.size() < 20; i++) {
      JSONObject f = rows.optJSONObject(i);
      if (f == null) continue;
      String id = f.optString("id", "").trim();
      String field = f.optString("field", "").trim();
      String value = f.optString("value", "").trim();
      // A person may have edited the value when accepting it.
      String acceptedValue = f.optString("accepted_value", "").trim();
      if (
        f.optString("status").equals("accepted") && !acceptedValue.isEmpty()
      ) value = acceptedValue;
      value = clip(value, 120);
      if (id.isEmpty() || value.isEmpty() || !FINDING_FIELDS.contains(field)) continue;
      String status = f.optString("status", "proposed");
      if (
        !status.equals("accepted") && !status.equals("dismissed")
      ) status = "proposed";
      double c = f.optDouble("confidence", 0);
      if (Double.isNaN(c)) c = 0;
      out.add(
        new Finding(
          id,
          field,
          value,
          Math.max(0, Math.min(1, c)),
          clip(f.optString("where", "").trim(), 80),
          status
        )
      );
    }
    return out;
  }

  /** Caption to show: the human-edited capture caption wins over AI's. */
  public static String caption(JSONObject cloud) {
    if (cloud == null) return "";
    String human = cloud.optString("caption", "").trim();
    if (!human.isEmpty()) return clip(human, 200);
    JSONObject ai = cloud.optJSONObject("ai");
    if (ai == null || !ai.optString("state").equals("done")) return "";
    return clip(ai.optString("caption", "").trim(), 140);
  }

  /**
   * AI review (Confirm / Dismiss) is offered only for the signed-in user's own
   * photo that is already in the cloud, in a real (non-local) space.
   */
  public static boolean canReview(JSONObject r, String user, boolean signedIn) {
    return (
      signedIn &&
      !user.isEmpty() &&
      !isLocalOnly(r) &&
      r.optString("state").equals(SyncPolicy.SYNCED) &&
      r.optString("user_id").equals(user)
    );
  }

  /**
   * Whether the cached cloud copy of a capture should be fetched again:
   * never fetched, or AI still pending and the last fetch is older than
   * minAgeMs.
   */
  public static boolean shouldRefreshCloud(
    JSONObject r,
    long nowMs,
    long minAgeMs
  ) {
    JSONObject cloud = r.optJSONObject("cloud");
    if (cloud == null) return true;
    long at = cloud.optLong("fetched_at_ms", 0);
    if (nowMs - at < minAgeMs) return false;
    JSONObject ai = cloud.optJSONObject("ai");
    // No "ai" block means AI is off for that capture; look again only rarely
    // in case the space turns AI on later.
    if (ai == null) return nowMs - at >= OFF_RECHECK_MS;
    String state = ai.optString("state");
    return !state.equals("done") && !state.equals("off") && !state.equals("failed");
  }

  /** Re-check interval for captures the server returned without AI. */
  public static final long OFF_RECHECK_MS = 30 * 60 * 1000;

  /** Allow-listed copy of the server capture fields the app caches. */
  public static JSONObject cloudCache(JSONObject capture, long nowMs)
    throws JSONException {
    JSONObject c = new JSONObject().put("fetched_at_ms", nowMs);
    for (String k : new String[] {
      "ai",
      "caption",
      "order_number",
      "order_confirmed",
      "fields",
    })
      if (capture.has(k) && !capture.isNull(k)) c.put(k, capture.get(k));
    return c;
  }

  static String clip(String s, int max) {
    return s.length() <= max ? s : s.substring(0, max - 1) + "…";
  }

  // ----------------------------------------------------------- invites

  /**
   * The 64-hex invite token from a pasted link (…/?invite=TOKEN) or a bare
   * code; null when there is none.
   */
  public static String inviteToken(String input) {
    if (input == null) return null;
    String s = input.trim();
    java.util.regex.Matcher m = java.util.regex.Pattern
      .compile("(?:[?&#]invite=)([a-fA-F0-9]{64})(?![a-fA-F0-9])")
      .matcher(s);
    if (m.find()) return m.group(1).toLowerCase(Locale.ROOT);
    if (s.matches("[a-fA-F0-9]{64}")) return s.toLowerCase(Locale.ROOT);
    return null;
  }

  // --------------------------------------------------------- templates

  /**
   * A template chosen for capture with the space default's locked fields
   * added, so switching templates can never drop a field the team requires.
   */
  public static JSONObject withTeamLocks(JSONObject chosen, JSONObject teamDefault)
    throws JSONException {
    JSONObject out = new JSONObject(chosen.toString());
    LinkedHashSet<String> locks = new LinkedHashSet<>();
    for (JSONObject t : new JSONObject[] { chosen, teamDefault }) {
      if (t == null) continue;
      JSONArray a = t.optJSONArray("locked_fields");
      if (a != null) for (int i = 0; i < a.length(); i++) if (
        !a.optString(i).isEmpty()
      ) locks.add(a.optString(i));
    }
    out.put("locked_fields", new JSONArray(locks));
    return out;
  }

  public static JSONObject defaultTemplate(JSONArray items) {
    if (items == null) return null;
    for (int i = 0; i < items.length(); i++) {
      JSONObject t = items.optJSONObject(i);
      if (t != null && t.optBoolean("is_default")) return t;
    }
    return null;
  }

  /**
   * After the team template list is refreshed: a person's own template
   * ("local": true) stays selected; otherwise keep their current team pick
   * (fresh server version) when it still exists, else the space default.
   * Team locks are always applied. Null when there is nothing to select.
   */
  public static JSONObject afterRefresh(JSONObject selected, JSONArray items)
    throws JSONException {
    JSONObject def = defaultTemplate(items);
    if (selected != null && selected.optBoolean("local")) return withTeamLocks(
      selected,
      def
    );
    String selectedId = selected == null ? "" : selected.optString("id", "");
    JSONObject pick = null;
    if (items != null && !selectedId.isEmpty()) for (
      int i = 0;
      i < items.length();
      i++
    ) {
      JSONObject t = items.optJSONObject(i);
      if (t != null && selectedId.equals(t.optString("id"))) pick = t;
    }
    if (pick == null) pick = def;
    return pick == null ? null : withTeamLocks(pick, def);
  }
}
