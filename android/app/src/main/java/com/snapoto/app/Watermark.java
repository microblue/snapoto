package com.snapoto.app;

import android.content.*;
import android.graphics.*;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import org.json.*;

public final class Watermark {

  public static final String[] FIELDS = {
    "date",
    "time",
    "timezone",
    "address",
    "gps",
    "accuracy",
    "company",
    "phone",
    "employee",
    "order_number",
    "plate",
    "meter",
    "serial",
    "note",
    "custom",
    "verification",
  };

  public static JSONObject selected(Context c, String space) {
    try {
      return new JSONObject(
        c
          .getSharedPreferences("templates", 0)
          .getString(
            space,
            "{\"name\":\"My watermark\",\"fields\":[\"date\",\"time\"],\"locked_fields\":[],\"position\":\"bottom-left\",\"font_size\":24,\"opacity\":0.6,\"version\":1}"
          )
      );
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  /**
   * Fields actually rendered: the template's selection plus every
   * team-locked field. A local edit or a stale cache can therefore never
   * drop a field the team requires (PRD §5.2, US-03).
   */
  public static List<String> effectiveFields(JSONObject template) {
    LinkedHashSet<String> out = new LinkedHashSet<>();
    JSONArray fields = template.optJSONArray("fields");
    if (fields != null) for (int i = 0; i < fields.length(); i++) out.add(
      fields.optString(i)
    );
    JSONArray locked = template.optJSONArray("locked_fields");
    if (locked != null) for (int i = 0; i < locked.length(); i++) out.add(
      locked.optString(i)
    );
    out.remove("");
    return new ArrayList<>(out);
  }

  public static boolean isLocked(JSONObject template, String field) {
    JSONArray locked = template.optJSONArray("locked_fields");
    if (locked != null) for (int i = 0; i < locked.length(); i++) if (
      field.equals(locked.optString(i))
    ) return true;
    return false;
  }

  private static java.time.ZonedDateTime zoned(JSONObject record) {
    String time = record.optString("captured_at_device", "");
    java.time.Instant instant;
    try {
      instant = java.time.Instant.parse(time);
    } catch (Exception e) {
      instant = java.time.Instant.now();
    }
    java.time.ZoneId zone;
    try {
      String id = record.optString("timezone", "");
      zone = id.isEmpty() ? java.time.ZoneId.systemDefault() : java.time.ZoneId.of(id);
    } catch (Exception e) {
      zone = java.time.ZoneId.systemDefault();
    }
    return instant.atZone(zone);
  }

  public static String lines(
    Context ctx,
    JSONObject template,
    JSONObject record
  ) {
    List<String> lines = new ArrayList<>();
    List<String> fields = effectiveFields(template);
    if (fields.isEmpty()) return "";
    // Shown in the device's zone at capture (stored on the record); the zone
    // is always printed with the time so it is never ambiguous.
    java.time.ZonedDateTime when = zoned(record);
    String zoneLabel = when.format(
      java.time.format.DateTimeFormatter.ofPattern("zzz xxx", Locale.US)
    );
    JSONObject gps = record.optJSONObject("gps");
    for (String key : fields) {
      String value = "";
      switch (key) {
        case "date":
          value = when.toLocalDate().toString();
          break;
        case "time":
          value =
            when.format(
              java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss", Locale.US)
            ) +
            " " +
            when.format(java.time.format.DateTimeFormatter.ofPattern("zzz", Locale.US)) +
            " (device)";
          break;
        case "timezone":
          value = zoneLabel;
          break;
        case "gps":
          value =
            gps == null
              ? "GPS not provided"
              : String.format(
                Locale.US,
                "%.6f, %.6f",
                gps.optDouble("latitude"),
                gps.optDouble("longitude")
              );
          break;
        case "accuracy":
          value =
            gps == null
              ? "Accuracy unknown"
              : "±" + Math.round(gps.optDouble("accuracy")) + " m";
          break;
        case "verification":
          value = "Local record " + record.optString("id", "");
          break;
        case "company":
        case "phone":
        case "employee":
          value = template.optString(key, "");
          break;
        case "custom":
          value = template.optString("custom", "");
          break;
        default:
          value = record.optString(key, "");
          // plate / meter / serial come from confirmed AI findings
          // (capture.fields) once the server has them.
          JSONObject extra = record.optJSONObject("fields");
          if (value.isEmpty() && extra != null) value = extra.optString(key, "");
      }
      if (!value.isEmpty()) lines.add(value);
    }
    return String.join("\n", lines);
  }

  public static Bitmap thumbnail(String path, int limit) {
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inJustDecodeBounds = true;
    BitmapFactory.decodeFile(path, options);
    options.inSampleSize = 1;
    while (
        Math.max(options.outWidth, options.outHeight) / options.inSampleSize >
        limit
      )
      options.inSampleSize *= 2;
    options.inJustDecodeBounds = false;
    Bitmap image = BitmapFactory.decodeFile(path, options);
    if (image == null) return null;
    try {
      android.media.ExifInterface exif = new android.media.ExifInterface(path);
      int orientation = exif.getAttributeInt(
        android.media.ExifInterface.TAG_ORIENTATION,
        1
      );
      Matrix m = new Matrix();
      if (orientation == 3) m.postRotate(180);
      else if (orientation == 6) m.postRotate(90);
      else if (orientation == 8) m.postRotate(270);
      if (!m.isIdentity()) {
        Bitmap rotated = Bitmap.createBitmap(
          image,
          0,
          0,
          image.getWidth(),
          image.getHeight(),
          m,
          true
        );
        if (rotated != image) image.recycle();
        image = rotated;
      }
    } catch (Exception ignored) {}
    return image;
  }

  public static JSONObject render(
    Context ctx,
    File original,
    JSONObject template,
    JSONObject record
  ) throws Exception {
    Bitmap src = thumbnail(original.getPath(), 2000);
    if (src == null) throw new IOException("Image cannot be decoded");
    Bitmap result = src.copy(Bitmap.Config.ARGB_8888, true);
    src.recycle();
    Canvas canvas = new Canvas(result);
    if (record.has("selfie_file")) {
      Bitmap selfie = thumbnail(
        new File(
          CaptureStore.directory(ctx),
          record.getString("selfie_file")
        ).getPath(),
        700
      );
      if (selfie != null) {
        float w = result.getWidth() / 3f,
          h = (w * selfie.getHeight()) / selfie.getWidth();
        canvas.drawBitmap(
          selfie,
          null,
          new RectF(
            result.getWidth() - w - 16,
            16,
            result.getWidth() - 16,
            16 + Math.min(h, result.getHeight() / 3f)
          ),
          null
        );
        selfie.recycle();
      }
    }
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    float size = Math.max(
      18,
      (template.optInt("font_size", 24) * result.getWidth()) / 800f
    );
    paint.setTextSize(size);
    String[] lines = lines(ctx, template, record).split("\n");
    float width = 0;
    for (String line : lines) width = Math.max(width, paint.measureText(line));
    width = Math.min(result.getWidth(), width + size);
    float height = Math.min(
      result.getHeight(),
      lines.length * size * 1.4f + size
    );
    String pos = template.optString("position", "bottom-left");
    float x = pos.endsWith("right") ? result.getWidth() - width : 0,
      y = pos.startsWith("top") ? 0 : result.getHeight() - height;
    paint.setColor(
      Color.argb((int) (255 * template.optDouble("opacity", .6)), 0, 0, 0)
    );
    canvas.drawRect(x, y, x + width, y + height, paint);
    paint.setColor(Color.WHITE);
    for (int i = 0; i < lines.length; i++) canvas.drawText(
      lines[i],
      x + size / 2,
      y + size + i * size * 1.4f,
      paint
    );
    File file = new File(
      CaptureStore.directory(ctx),
      record.getString("id") + "-rendered.jpg"
    );
    try (FileOutputStream out = new FileOutputStream(file)) {
      result.compress(Bitmap.CompressFormat.JPEG, 92, out);
      out.getFD().sync();
    } finally {
      result.recycle();
    }
    return new JSONObject()
      .put("file", file.getName())
      .put("sha256", CaptureStore.digest(Files.readAllBytes(file.toPath())))
      .put("template", template);
  }
}
