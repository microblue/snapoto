package com.snapoto.app;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.*;

/** Programmatic Material-like building blocks (no XML layouts in this app). */
final class Ui {

  private Ui() {}

  static final int INK = Color.rgb(17, 24, 39);
  static final int MUTED = Color.rgb(100, 112, 128);
  static final int BG = Color.rgb(243, 245, 249);
  static final int CARD = Color.WHITE;
  static final int LINE = Color.rgb(226, 230, 237);
  static final int PRIMARY = Color.rgb(35, 94, 219);
  static final int PRIMARY_SOFT = Color.rgb(229, 237, 252);
  static final int AI = Color.rgb(109, 64, 214);
  static final int AI_SOFT = Color.rgb(241, 236, 253);

  /** Status colours: gray saved on phone, blue uploading, green cloud, red problem. */
  static final int GRAY = Color.rgb(107, 114, 128);
  static final int BLUE = Color.rgb(37, 99, 235);
  static final int GREEN = Color.rgb(22, 163, 74);
  static final int AMBER = Color.rgb(217, 145, 0);
  static final int RED = Color.rgb(220, 38, 38);

  static int statusColor(FieldRules.StatusKind k) {
    switch (k) {
      case UPLOADING:
        return BLUE;
      case CLOUD:
        return GREEN;
      case PROBLEM:
        return RED;
      default:
        return GRAY;
    }
  }

  static int gpsColor(FieldRules.GpsQuality q) {
    switch (q) {
      case GOOD:
        return GREEN;
      case FAIR:
        return AMBER;
      default:
        return RED;
    }
  }

  static int dp(Context c, float v) {
    return Math.round(v * c.getResources().getDisplayMetrics().density);
  }

  static GradientDrawable round(Context c, int fill, float radiusDp) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(fill);
    d.setCornerRadius(dp(c, radiusDp));
    return d;
  }

  static GradientDrawable outlined(
    Context c,
    int fill,
    int stroke,
    float radiusDp
  ) {
    GradientDrawable d = round(c, fill, radiusDp);
    d.setStroke(dp(c, 1), stroke);
    return d;
  }

  static GradientDrawable dot(int color) {
    GradientDrawable d = new GradientDrawable();
    d.setShape(GradientDrawable.OVAL);
    d.setColor(color);
    return d;
  }

  /** Background with a touch ripple. */
  static RippleDrawable pressable(Context c, int fill, float radiusDp) {
    return new RippleDrawable(
      ColorStateList.valueOf(0x33000000),
      round(c, fill, radiusDp),
      round(c, Color.BLACK, radiusDp)
    );
  }

  static TextView text(Context c, String value, float sp, int color) {
    TextView v = new TextView(c);
    v.setText(value);
    v.setTextSize(sp);
    v.setTextColor(color);
    v.setLineSpacing(0, 1.1f);
    return v;
  }

  static TextView title(Context c, String value, float sp) {
    TextView v = text(c, value, sp, INK);
    v.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    return v;
  }

  /** Filled (primary) or tonal button, ≥ 52dp tall. */
  static Button button(Context c, String label, boolean filled, Runnable action) {
    Button b = new Button(c);
    b.setText(label);
    b.setAllCaps(false);
    b.setTextSize(16);
    b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    b.setTextColor(filled ? Color.WHITE : PRIMARY);
    b.setBackground(pressable(c, filled ? PRIMARY : PRIMARY_SOFT, 14));
    b.setStateListAnimator(null);
    b.setMinHeight(dp(c, 52));
    b.setPadding(dp(c, 16), 0, dp(c, 16), 0);
    b.setOnClickListener(v -> action.run());
    return b;
  }

  static Button colored(
    Context c,
    String label,
    int fill,
    int textColor,
    Runnable action
  ) {
    Button b = button(c, label, true, action);
    b.setBackground(pressable(c, fill, 14));
    b.setTextColor(textColor);
    return b;
  }

  static LinearLayout.LayoutParams full(Context c, int topDp) {
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.topMargin = dp(c, topDp);
    return p;
  }

  static LinearLayout vertical(Context c) {
    LinearLayout l = new LinearLayout(c);
    l.setOrientation(LinearLayout.VERTICAL);
    return l;
  }

  static LinearLayout row(Context c) {
    LinearLayout l = new LinearLayout(c);
    l.setOrientation(LinearLayout.HORIZONTAL);
    l.setGravity(Gravity.CENTER_VERTICAL);
    return l;
  }

  /** White rounded card with padding. */
  static LinearLayout card(Context c) {
    LinearLayout l = vertical(c);
    l.setBackground(outlined(c, CARD, LINE, 18));
    int p = dp(c, 16);
    l.setPadding(p, p, p, p);
    return l;
  }

  /** Small coloured dot + label, e.g. the status chip. */
  static LinearLayout statusChip(Context c, int color, String label, boolean dark) {
    LinearLayout chip = row(c);
    View d = new View(c);
    d.setBackground(dot(color));
    LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(
      Ui.dp(c, 10),
      Ui.dp(c, 10)
    );
    dp.rightMargin = Ui.dp(c, 6);
    chip.addView(d, dp);
    TextView t = text(c, label, 13, dark ? Color.WHITE : color);
    t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    chip.addView(t);
    int h = Ui.dp(c, 10);
    chip.setPadding(h, Ui.dp(c, 4), h, Ui.dp(c, 4));
    chip.setBackground(
      round(c, dark ? 0x99000000 : (color & 0x00FFFFFF) | 0x1F000000, 20)
    );
    return chip;
  }

  /** Dark translucent pill used on top of the camera preview. */
  static TextView pill(Context c, String label) {
    TextView t = text(c, label, 14, Color.WHITE);
    t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    t.setSingleLine();
    t.setEllipsize(android.text.TextUtils.TruncateAt.END);
    t.setGravity(Gravity.CENTER_VERTICAL);
    t.setMinHeight(dp(c, 44));
    int h = dp(c, 14);
    t.setPadding(h, 0, h, 0);
    t.setBackground(pressable(c, 0x8C000000, 22));
    return t;
  }

  static Switch toggle(Context c, String label, boolean on) {
    Switch s = new Switch(c);
    s.setText(label);
    s.setTextSize(16);
    s.setTextColor(INK);
    s.setChecked(on);
    s.setMinHeight(dp(c, 52));
    return s;
  }

  static EditText input(Context c, String hint, String value, boolean secret) {
    EditText e = new EditText(c);
    e.setHint(hint);
    e.setText(value);
    e.setSingleLine();
    e.setTextSize(16);
    e.setMinHeight(dp(c, 52));
    if (secret) e.setInputType(
      android.text.InputType.TYPE_CLASS_TEXT |
      android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    );
    return e;
  }
}
