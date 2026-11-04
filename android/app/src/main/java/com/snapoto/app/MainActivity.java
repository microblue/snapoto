package com.snapoto.app;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.*;
import android.location.*;
import android.os.*;
import android.view.*;
import android.widget.*;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import java.io.File;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

public class MainActivity extends ComponentActivity {

  private LinearLayout root;
  private FrameLayout content;
  private TextView state;
  private ImageCapture capture;
  private ProcessCameraProvider provider;
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  /** AI/cloud lookups for Photos; never shares a queue with sign-in or saves. */
  private final ExecutorService net = Executors.newSingleThreadExecutor();
  /**
   * Watermark rendering runs off the capture path so the next shutter press
   * never waits for a 2000px decode/encode (PRD §14: capture never waits).
   */
  private final ExecutorService renderer = Executors.newSingleThreadExecutor();
  /**
   * Capture callbacks and local saves only. Network work (sign-in, geocoding,
   * template fetch) stays on io so it can never delay "Saved".
   */
  private final ExecutorService captureIo = Executors.newSingleThreadExecutor();
  /** Interrupted-capture recovery must run once per process, not per Activity. */
  private static final java.util.concurrent.atomic.AtomicBoolean recovered =
    new java.util.concurrent.atomic.AtomicBoolean(false);
  private static final long STALE_GPS_MS = FieldRules.STALE_GPS_MS;
  private boolean cameraWaitingForPermission = false;
  private String tab = "Camera";
  private int insetTop = 0, insetBottom = 0;
  private String noteText = "";
  private JSONObject lastGps;
  private long lastGpsNanos = 0;
  /** Automatic (Geocoder) address for the current fix. */
  private String lastAddress = "";
  private boolean taking = false;
  private boolean videoMode = false;
  private androidx.camera.video.VideoCapture<androidx.camera.video.Recorder> videoCapture;
  private androidx.camera.video.Recording recording;
  private PreviewView cameraPreview;
  private TextView overlay, gpsChip, addressPill, notePill, voicePill, templateChip;
  private View gpsDot, thumbDot, shutterInner;
  private ImageView thumb;
  private String lastCid = "";
  private final Handler overlayHandler = new Handler(Looper.getMainLooper());
  private final Runnable hideState = () -> {
    if (state != null) state.setVisibility(View.GONE);
  };
  private final Runnable overlayTick = new Runnable() {
    @Override
    public void run() {
      if (tab.equals("Camera")) {
        updateOverlay();
        refreshThumbDot();
      }
      overlayHandler.postDelayed(this, 1000);
    }
  };
  private android.media.MediaRecorder audioRecorder;
  private File audioFile;
  private String pendingAudio = "";
  private String pendingAudioHash = "";

  private android.content.SharedPreferences prefs() {
    return getSharedPreferences("account", 0);
  }

  private boolean signedIn() {
    return !prefs().getString("token", "").isEmpty();
  }

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    if (recovered.compareAndSet(false, true)) recoverInterrupted();
    getOnBackPressedDispatcher()
      .addCallback(
        this,
        new OnBackPressedCallback(true) {
          @Override
          public void handleOnBackPressed() {
            if (!tab.equals("Camera") && recording == null) show("Camera");
            else if (recording == null) finish();
          }
        }
      );
    show("Camera");
    // New members pick up the team's published template without opening Me.
    if (signedIn()) refreshTemplate(false);
    if (
      checkSelfPermission(Manifest.permission.CAMERA) !=
      PackageManager.PERMISSION_GRANTED
    ) requestPermissions(new String[] { Manifest.permission.CAMERA }, 10);
  }

  private int dp(int value) {
    return Ui.dp(this, value);
  }

  // ------------------------------------------------------------ shell

  @SuppressWarnings("deprecation")
  private void systemBars(boolean dark) {
    Window w = getWindow();
    // The insets controller needs the decor view; it is lazily created and
    // does not exist yet on the first call from onCreate.
    w.getDecorView();
    int color = dark ? Color.BLACK : Ui.BG;
    w.setStatusBarColor(color);
    w.setNavigationBarColor(dark ? Color.BLACK : Color.WHITE);
    if (Build.VERSION.SDK_INT >= 30) {
      WindowInsetsController c = w.getInsetsController();
      if (c != null) {
        int light =
          WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
          WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        c.setSystemBarsAppearance(dark ? 0 : light, light);
      }
    } else {
      View d = w.getDecorView();
      int flags = d.getSystemUiVisibility();
      if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
      else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
      d.setSystemUiVisibility(flags);
    }
  }

  @SuppressWarnings("deprecation")
  private void show(String page) {
    tab = page;
    overlayHandler.removeCallbacks(hideState);
    if (provider != null) provider.unbindAll();
    capture = null;
    videoCapture = null;
    overlay = gpsChip = addressPill = notePill = voicePill = templateChip = null;
    gpsDot = thumbDot = shutterInner = null;
    thumb = null;
    state = null;
    boolean dark = page.equals("Camera");
    systemBars(dark);
    root = Ui.vertical(this);
    root.setBackgroundColor(dark ? Color.BLACK : Ui.BG);
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      insetTop = insets.getSystemWindowInsetTop();
      insetBottom = insets.getSystemWindowInsetBottom();
      root.setPadding(0, tab.equals("Camera") ? 0 : insetTop, 0, insetBottom);
      View top = root.findViewWithTag("camera-top");
      if (top != null) top.setPadding(dp(12), insetTop + dp(8), dp(12), dp(8));
      return insets;
    });
    setContentView(root);
    content = new FrameLayout(this);
    root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
    root.addView(navBar(page, dark), new LinearLayout.LayoutParams(-1, dp(68)));
    if (page.equals("Camera")) camera();
    else if (page.equals("Photos")) photos();
    else account();
    root.requestApplyInsets();
  }

  private View navBar(String page, boolean dark) {
    LinearLayout nav = Ui.row(this);
    nav.setBackgroundColor(dark ? Color.BLACK : Color.WHITE);
    nav.setPadding(dp(8), dp(6), dp(8), dp(6));
    for (String t : new String[] { "Camera", "Photos", "Me" }) {
      boolean on = t.equals(page);
      TextView item = Ui.title(this, t, 15);
      item.setGravity(Gravity.CENTER);
      item.setTextColor(
        on ? (dark ? Color.BLACK : Ui.PRIMARY) : (dark ? 0xCCFFFFFF : Ui.MUTED)
      );
      if (on) item.setBackground(
        Ui.round(this, dark ? Color.WHITE : Ui.PRIMARY_SOFT, 18)
      );
      item.setContentDescription(t + " tab");
      item.setOnClickListener(v -> {
        if (recording != null) {
          message("Stop the video recording first");
          return;
        }
        if (!tab.equals(t)) show(t);
      });
      LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, -1, 1);
      p.leftMargin = p.rightMargin = dp(6);
      nav.addView(item, p);
    }
    return nav;
  }

  // ----------------------------------------------------------- camera

  private String spaceLabel() {
    String space = prefs().getString("space", "local");
    if (space.equals("local") || !signedIn()) return "This phone only";
    String kind = spaceKind(space);
    String name = prefs().getString("space_name", "");
    if (kind.equals("personal")) return "Personal";
    return name.isEmpty() ? "Team" : name;
  }

  private String spaceKind(String id) {
    try {
      JSONArray spaces = new JSONArray(prefs().getString("spaces", "[]"));
      for (int i = 0; i < spaces.length(); i++) {
        JSONObject s = spaces.getJSONObject(i);
        if (s.optString("id").equals(id)) return s.optString("kind", "team");
      }
    } catch (Exception ignored) {}
    return "team";
  }

  private String spaceRole(String id) {
    try {
      JSONArray spaces = new JSONArray(prefs().getString("spaces", "[]"));
      for (int i = 0; i < spaces.length(); i++) {
        JSONObject s = spaces.getJSONObject(i);
        if (s.optString("id").equals(id)) return s.optString("role", "");
      }
    } catch (Exception ignored) {}
    return "";
  }

  private void camera() {
    FrameLayout frame = content;
    frame.setBackgroundColor(Color.BLACK);
    PreviewView preview = new PreviewView(this);
    cameraPreview = preview;
    preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
    frame.addView(preview, new FrameLayout.LayoutParams(-1, -1));

    overlay = Ui.text(this, "", 14, Color.WHITE);
    overlay.setShadowLayer(4, 0, 1, Color.BLACK);
    overlay.setBackground(Ui.round(this, 0x66000000, 10));
    overlay.setPadding(dp(10), dp(6), dp(10), dp(6));
    FrameLayout.LayoutParams op = new FrameLayout.LayoutParams(
      -2,
      -2,
      Gravity.BOTTOM | Gravity.START
    );
    op.setMargins(dp(12), dp(76), dp(12), dp(236));
    frame.addView(overlay, op);

    // Top chips: space · template · GPS quality.
    LinearLayout top = Ui.row(this);
    top.setTag("camera-top");
    top.setPadding(dp(12), insetTop + dp(8), dp(12), dp(8));
    top.setBackground(
      new android.graphics.drawable.GradientDrawable(
        android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM,
        new int[] { 0x99000000, 0x00000000 }
      )
    );
    TextView spaceChip = Ui.pill(this, "◉  " + spaceLabel());
    spaceChip.setContentDescription("Space for new photos: " + spaceLabel());
    spaceChip.setOnClickListener(v -> chooseSpace());
    top.addView(spaceChip, new LinearLayout.LayoutParams(-2, -2));
    templateChip = Ui.pill(this, "");
    templateChip.setOnClickListener(v -> chooseTemplate());
    LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, -2, 1);
    tp.leftMargin = dp(8);
    tp.rightMargin = dp(8);
    top.addView(templateChip, tp);
    LinearLayout gps = Ui.row(this);
    gps.setBackground(Ui.pressable(this, 0x8C000000, 22));
    gps.setPadding(dp(12), 0, dp(14), 0);
    gps.setMinimumHeight(dp(44));
    gpsDot = new View(this);
    gpsDot.setBackground(Ui.dot(Ui.RED));
    LinearLayout.LayoutParams gd = new LinearLayout.LayoutParams(dp(12), dp(12));
    gd.rightMargin = dp(6);
    gps.addView(gpsDot, gd);
    gpsChip = Ui.title(this, "No GPS", 14);
    gpsChip.setTextColor(Color.WHITE);
    gps.addView(gpsChip);
    gps.setOnClickListener(v -> askLocation());
    top.addView(gps, new LinearLayout.LayoutParams(-2, dp(44)));
    frame.addView(top, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

    // "Saving… / Saved ✓" banner.
    state = Ui.title(this, "", 16);
    state.setTextColor(Color.WHITE);
    state.setGravity(Gravity.CENTER);
    state.setPadding(dp(18), dp(10), dp(18), dp(10));
    state.setVisibility(View.GONE);
    FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(
      -2,
      -2,
      Gravity.TOP | Gravity.CENTER_HORIZONTAL
    );
    sp.topMargin = dp(120);
    frame.addView(state, sp);

    // Bottom panel: address · note/voice · thumbnail / shutter / mode.
    LinearLayout bottom = Ui.vertical(this);
    bottom.setPadding(dp(12), dp(24), dp(12), dp(14));
    bottom.setBackground(
      new android.graphics.drawable.GradientDrawable(
        android.graphics.drawable.GradientDrawable.Orientation.BOTTOM_TOP,
        new int[] { 0xCC000000, 0x00000000 }
      )
    );
    addressPill = Ui.pill(this, "📍  Finding address…");
    addressPill.setOnClickListener(v -> chooseAddress());
    bottom.addView(addressPill, new LinearLayout.LayoutParams(-1, -2));
    LinearLayout tools = Ui.row(this);
    notePill = Ui.pill(this, "");
    notePill.setOnClickListener(v -> editNote());
    tools.addView(notePill, new LinearLayout.LayoutParams(0, -2, 1));
    voicePill = Ui.pill(
      this,
      audioRecorder != null
        ? "■  Stop voice"
        : (pendingAudio.isEmpty() ? "🎙  Voice note" : "🎙  Voice ✓")
    );
    voicePill.setOnClickListener(v -> voiceNote());
    LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(-2, -2);
    vp.leftMargin = dp(8);
    tools.addView(voicePill, vp);
    bottom.addView(tools, Ui.full(this, 8));
    updateNotePill();

    LinearLayout controls = Ui.row(this);
    controls.setGravity(Gravity.CENTER_VERTICAL);
    FrameLayout thumbBox = new FrameLayout(this);
    thumb = new ImageView(this);
    thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
    thumb.setBackground(Ui.outlined(this, 0x33FFFFFF, Color.WHITE, 12));
    thumb.setClipToOutline(true);
    thumb.setContentDescription("Last photo");
    thumbBox.addView(thumb, new FrameLayout.LayoutParams(dp(60), dp(60), Gravity.CENTER));
    thumbDot = new View(this);
    android.graphics.drawable.GradientDrawable td = Ui.dot(Ui.GRAY);
    td.setStroke(dp(2), Color.WHITE);
    thumbDot.setBackground(td);
    thumbDot.setVisibility(View.GONE);
    thumbBox.addView(thumbDot, new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.TOP | Gravity.END));
    thumbBox.setOnClickListener(v -> {
      if (!lastCid.isEmpty()) {
        JSONObject r = readRecord(lastCid);
        show("Photos");
        if (r != null) detail(r);
      } else show("Photos");
    });
    controls.addView(thumbBox, new LinearLayout.LayoutParams(dp(72), dp(72)));
    controls.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
    FrameLayout shutter = new FrameLayout(this);
    android.graphics.drawable.GradientDrawable ring = Ui.dot(0x22FFFFFF);
    ring.setStroke(dp(5), Color.WHITE);
    shutter.setBackground(ring);
    shutterInner = new View(this);
    shutter.addView(shutterInner, new FrameLayout.LayoutParams(dp(68), dp(68), Gravity.CENTER));
    styleShutter();
    shutter.setContentDescription(videoMode ? "Record or stop video" : "Take photo");
    shutter.setOnClickListener(v -> {
      if (videoMode) video();
      else takePhoto();
    });
    controls.addView(shutter, new LinearLayout.LayoutParams(dp(88), dp(88)));
    controls.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
    TextView mode = Ui.title(this, videoMode ? "Photo" : "Video", 14);
    mode.setTextColor(Color.WHITE);
    mode.setGravity(Gravity.CENTER);
    mode.setBackground(Ui.pressable(this, 0x8C000000, 36));
    mode.setContentDescription(videoMode ? "Switch to photo" : "Switch to video");
    mode.setOnClickListener(v -> {
      if (recording != null) {
        recording.stop();
        return;
      }
      videoMode = !videoMode;
      show("Camera");
    });
    controls.addView(mode, new LinearLayout.LayoutParams(dp(72), dp(72)));
    bottom.addView(controls, Ui.full(this, 14));
    frame.addView(bottom, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));

    updateOverlay();
    loadLastThumb();
    if (
      checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
    ) locate(true);
    cameraWaitingForPermission = false;
    if (
      checkSelfPermission(Manifest.permission.CAMERA) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      cameraWaitingForPermission = true;
      LinearLayout card = Ui.card(this);
      card.addView(Ui.title(this, "Camera access needed", 20));
      boolean blocked = cameraPermanentlyDenied();
      TextView why = Ui.text(
        this,
        blocked
          ? "Camera access is blocked. Turn it on in Settings to take photos. Your photos stay on this phone."
          : "Snapoto needs the camera to take work photos. Photos stay on this phone until you choose to back them up.",
        15,
        Ui.MUTED
      );
      card.addView(why, Ui.full(this, 8));
      card.addView(
        Ui.button(
          this,
          blocked ? "Open Settings" : "Allow camera",
          true,
          () -> {
            if (cameraPermanentlyDenied()) openAppSettings();
            else requestPermissions(
              new String[] { Manifest.permission.CAMERA },
              10
            );
          }
        ),
        Ui.full(this, 16)
      );
      FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
      cp.setMargins(dp(24), 0, dp(24), 0);
      frame.addView(card, cp);
      prefs().edit().putBoolean("camera_guide_shown", true).apply();
      return;
    }
    var future = ProcessCameraProvider.getInstance(this);
    future.addListener(() -> {
      try {
        if (!tab.equals("Camera") || isDestroyed()) return;
        provider = future.get();
        Preview p = new Preview.Builder().build();
        p.setSurfaceProvider(preview.getSurfaceProvider());
        capture = new ImageCapture.Builder()
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
          .setTargetRotation(displayRotation())
          .build();
        provider.unbindAll();
        if (videoMode) {
          androidx.camera.video.Recorder recorder =
            new androidx.camera.video.Recorder.Builder()
              .setQualitySelector(
                androidx.camera.video.QualitySelector.from(
                  androidx.camera.video.Quality.SD,
                  androidx.camera.video.FallbackStrategy.higherQualityOrLowerThan(
                    androidx.camera.video.Quality.SD
                  )
                )
              )
              .build();
          videoCapture = androidx.camera.video.VideoCapture.withOutput(
            recorder
          );
          videoCapture.setTargetRotation(displayRotation());
          provider.bindToLifecycle(
            this,
            CameraSelector.DEFAULT_BACK_CAMERA,
            p,
            videoCapture
          );
        } else provider.bindToLifecycle(
          this,
          CameraSelector.DEFAULT_BACK_CAMERA,
          p,
          capture
        );
      } catch (Exception e) {
        status("Camera unavailable: " + e.getMessage(), Ui.RED, false);
      }
    }, ContextCompat.getMainExecutor(this));
  }

  private void styleShutter() {
    if (shutterInner == null) return;
    if (videoMode && recording != null) {
      shutterInner.setBackground(Ui.round(this, Ui.RED, 10));
      FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) shutterInner.getLayoutParams();
      p.width = p.height = dp(38);
      shutterInner.setLayoutParams(p);
    } else {
      shutterInner.setBackground(Ui.dot(videoMode ? Ui.RED : Color.WHITE));
      FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) shutterInner.getLayoutParams();
      p.width = p.height = dp(68);
      shutterInner.setLayoutParams(p);
    }
  }

  /** Banner on the camera; transient ones fade after 2.5 s. */
  private void status(String text, int color, boolean transientBanner) {
    if (state == null) return;
    overlayHandler.removeCallbacks(hideState);
    state.setText(text);
    state.setBackground(Ui.round(this, color, 24));
    state.setVisibility(View.VISIBLE);
    if (transientBanner) overlayHandler.postDelayed(hideState, 2500);
  }

  private void updateNotePill() {
    if (notePill == null) return;
    notePill.setText(noteText.isEmpty() ? "✎  Add note" : "✎  " + noteText);
  }

  private void editNote() {
    EditText e = Ui.input(this, "Note for the next photos", noteText, false);
    FrameLayout box = new FrameLayout(this);
    box.setPadding(dp(20), dp(8), dp(20), 0);
    box.addView(e);
    new android.app.AlertDialog.Builder(this)
      .setTitle("Photo note")
      .setMessage("Added to every photo until you change or clear it.")
      .setView(box)
      .setPositiveButton("Save", (d, w) -> {
        noteText = e.getText().toString().trim();
        updateNotePill();
      })
      .setNeutralButton("Clear", (d, w) -> {
        noteText = "";
        updateNotePill();
      })
      .setNegativeButton("Cancel", null)
      .show();
  }

  private void askLocation() {
    if (
      checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) !=
      PackageManager.PERMISSION_GRANTED
    ) requestPermissions(
      new String[] {
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
      },
      11
    );
    else {
      message("Updating location…");
      locate();
    }
  }

  // --------------------------------------------------- last thumbnail

  private JSONObject readRecord(String cid) {
    try {
      File f = CaptureStore.recordFile(this, cid);
      return new JSONObject(
        new String(
          java.nio.file.Files.readAllBytes(f.toPath()),
          java.nio.charset.StandardCharsets.UTF_8
        )
      );
    } catch (Exception e) {
      return null;
    }
  }

  private boolean mine(JSONObject r) {
    return (
      r.optString("space_id").equals(prefs().getString("space", "local")) &&
      r.optString("user_id").equals(prefs().getString("user", "local"))
    );
  }

  private void loadLastThumb() {
    io.execute(() -> {
      JSONObject newest = null;
      if (!lastCid.isEmpty()) newest = readRecord(lastCid);
      if (newest == null) for (JSONObject r : CaptureStore.all(this)) if (mine(r)) {
        newest = r;
        break;
      }
      if (newest == null) return;
      showThumb(newest);
    });
  }

  /** Decode off the UI thread, then set image + dot. Call from a worker. */
  private void showThumb(JSONObject r) {
    String id = r.optString("id");
    Bitmap bm = Watermark.thumbnail(
      new File(CaptureStore.directory(this), r.optString("file")).getPath(),
      200
    );
    runOnUiThread(() -> {
      lastCid = id;
      if (thumb == null) {
        if (bm != null) bm.recycle();
        return;
      }
      if (bm != null) thumb.setImageBitmap(bm);
      else thumb.setImageDrawable(null);
      paintThumbDot(r);
    });
  }

  private void paintThumbDot(JSONObject r) {
    if (thumbDot == null || r == null) return;
    FieldRules.Status s = statusOf(r);
    android.graphics.drawable.GradientDrawable d = Ui.dot(Ui.statusColor(s.kind));
    d.setStroke(dp(2), Color.WHITE);
    thumbDot.setBackground(d);
    thumbDot.setVisibility(View.VISIBLE);
    thumbDot.setContentDescription(s.label);
  }

  private void refreshThumbDot() {
    if (lastCid.isEmpty() || thumbDot == null) return;
    String id = lastCid;
    io.execute(() -> {
      JSONObject r = readRecord(id);
      runOnUiThread(() -> paintThumbDot(r));
    });
  }

  private FieldRules.Status statusOf(JSONObject r) {
    return FieldRules.status(
      r,
      signedIn(),
      prefs().getBoolean("cloud", false),
      prefs().getBoolean("wifi_only", false)
    );
  }

  // --------------------------------------------------------- location

  private void locate() {
    locate(false);
  }

  /** quiet=true for automatic refreshes: no toasts, capture never waits. */
  private void locate(boolean quiet) {
    try {
      LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
      Location best = null;
      for (String name : lm.getProviders(true)) {
        Location l = lm.getLastKnownLocation(name);
        if (
          l != null &&
          (best == null ||
            l.getElapsedRealtimeNanos() > best.getElapsedRealtimeNanos())
        ) best = l;
      }
      boolean stale =
        best != null &&
        (SystemClock.elapsedRealtimeNanos() - best.getElapsedRealtimeNanos()) /
          1000000 >
        STALE_GPS_MS;
      if (best != null) applyLocation(best);
      if (best == null || stale) {
        if (Build.VERSION.SDK_INT >= 30 && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
          android.os.CancellationSignal signal =
            new android.os.CancellationSignal();
          lm.getCurrentLocation(
            LocationManager.GPS_PROVIDER,
            signal,
            ContextCompat.getMainExecutor(this),
            location -> {
              if (location != null) applyLocation(location);
              else if (!quiet) message(
                "Location unavailable; you can still take photos."
              );
            }
          );
          new Handler(Looper.getMainLooper()).postDelayed(
            signal::cancel,
            10000
          );
        } else if (best == null && !quiet) message(
          "No location fix yet. Turn on device location and try again."
        );
      }
    } catch (Exception e) {
      if (!quiet) message("Location unavailable");
    }
  }

  @SuppressWarnings("deprecation")
  private void applyLocation(Location best) {
    try {
      long age = Math.max(
        0,
        (SystemClock.elapsedRealtimeNanos() - best.getElapsedRealtimeNanos()) /
          1000000
      );
      // Raw GPS is stored exactly as reported; a chosen address never edits it.
      lastGps = new JSONObject()
        .put("latitude", best.getLatitude())
        .put("longitude", best.getLongitude())
        .put("accuracy", best.getAccuracy())
        .put("age_ms", age);
      lastGpsNanos = best.getElapsedRealtimeNanos();
      checkAddressChoice(best);
      lastAddress = "";
      if (Geocoder.isPresent()) io.execute(() -> {
        try {
          var addresses = new Geocoder(this, Locale.US).getFromLocation(
            best.getLatitude(),
            best.getLongitude(),
            1
          );
          if (addresses != null && !addresses.isEmpty()) {
            lastAddress = addresses.get(0).getAddressLine(0);
            runOnUiThread(this::updateOverlay);
          }
        } catch (Exception ignored) {}
      });
      updateOverlay();
    } catch (Exception e) {
      message("Location unavailable");
    }
  }

  // ------------------------------------------------- address chooser

  private JSONObject addressChoice() {
    try {
      String raw = prefs().getString("address_choice", "");
      return raw.isEmpty() ? null : new JSONObject(raw);
    } catch (Exception e) {
      return null;
    }
  }

  private void checkAddressChoice(Location fix) throws JSONException {
    JSONObject choice = addressChoice();
    switch (
      FieldRules.addressDecision(
        choice,
        fix.getLatitude(),
        fix.getLongitude(),
        fix.getAccuracy()
      )
    ) {
      case ANCHOR:
        choice.put("lat", fix.getLatitude()).put("lon", fix.getLongitude());
        prefs().edit().putString("address_choice", choice.toString()).apply();
        break;
      case RESET:
        prefs().edit().remove("address_choice").apply();
        if (tab.equals("Camera")) message(
          "You moved more than 150 m · address is automatic again"
        );
        break;
      default:
    }
  }

  /** Display address for the watermark/record: the person's choice wins. */
  private String currentAddress() {
    JSONObject c = addressChoice();
    if (c != null && !c.optString("text").isEmpty()) return c.optString("text");
    return lastAddress;
  }

  private String addressSource() {
    JSONObject c = addressChoice();
    if (c != null && !c.optString("text").isEmpty()) return c.optString(
      "source",
      "picked"
    );
    return lastAddress.isEmpty() ? "none" : "auto";
  }

  private void setAddressChoice(String text, String source) {
    try {
      JSONObject c = new JSONObject().put("text", text).put("source", source);
      if (lastGps != null) c
        .put("lat", lastGps.getDouble("latitude"))
        .put("lon", lastGps.getDouble("longitude"));
      prefs().edit().putString("address_choice", c.toString()).apply();
      updateOverlay();
      message("Address set · stays until you move 150 m");
    } catch (Exception e) {
      message(e.getMessage());
    }
  }

  @SuppressWarnings("deprecation")
  private void chooseAddress() {
    LinearLayout box = Ui.vertical(this);
    box.setPadding(dp(20), dp(8), dp(20), dp(8));
    TextView hint = Ui.text(
      this,
      lastGps == null
        ? "No GPS fix yet. You can type the address."
        : "Looking up nearby addresses…",
      15,
      Ui.MUTED
    );
    box.addView(hint);
    LinearLayout options = Ui.vertical(this);
    box.addView(options, Ui.full(this, 8));
    ScrollView scroll = new ScrollView(this);
    scroll.addView(box);
    android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(this)
      .setTitle("Where are you?")
      .setView(scroll)
      .setNegativeButton("Cancel", null)
      .create();
    Runnable typeIt = () -> {
      dialog.dismiss();
      typeAddress();
    };
    JSONObject choice = addressChoice();
    if (choice != null) {
      Button auto = Ui.button(this, "Use automatic address", false, () -> {
        prefs().edit().remove("address_choice").apply();
        updateOverlay();
        dialog.dismiss();
      });
      box.addView(auto, Ui.full(this, 8));
    }
    box.addView(Ui.button(this, "✎  Type address", false, typeIt), Ui.full(this, 8));
    TextView raw = Ui.text(
      this,
      "GPS coordinates are always saved exactly as measured.",
      13,
      Ui.MUTED
    );
    box.addView(raw, Ui.full(this, 12));
    dialog.show();
    if (lastGps == null || !Geocoder.isPresent()) {
      if (lastGps != null) hint.setText("Address lookup is not available on this phone. Type it instead.");
      return;
    }
    double lat = lastGps.optDouble("latitude"), lon = lastGps.optDouble("longitude");
    io.execute(() -> {
      List<String> lines = new ArrayList<>();
      try {
        var found = new Geocoder(this, Locale.US).getFromLocation(lat, lon, 6);
        if (found != null) for (Address a : found) lines.add(a.getAddressLine(0));
      } catch (Exception ignored) {}
      List<String> top = FieldRules.distinctAddresses(lines, 3);
      runOnUiThread(() -> {
        if (!dialog.isShowing()) return;
        hint.setText(
          top.isEmpty()
            ? "No nearby addresses found. Type it instead."
            : "Tap the right address:"
        );
        String current = currentAddress();
        for (String line : top) {
          TextView opt = Ui.text(
            this,
            (line.equals(current) ? "✓  " : "📍  ") + line,
            16,
            Ui.INK
          );
          opt.setBackground(Ui.pressable(this, Ui.BG, 12));
          opt.setPadding(dp(14), dp(14), dp(14), dp(14));
          opt.setOnClickListener(v -> {
            setAddressChoice(line, "picked");
            dialog.dismiss();
          });
          options.addView(opt, Ui.full(this, 6));
        }
      });
    });
  }

  private void typeAddress() {
    EditText e = Ui.input(this, "Street, city", currentAddress(), false);
    FrameLayout box = new FrameLayout(this);
    box.setPadding(dp(20), dp(8), dp(20), 0);
    box.addView(e);
    new android.app.AlertDialog.Builder(this)
      .setTitle("Type address")
      .setView(box)
      .setPositiveButton("Use this address", (d, w) -> {
        String t = e.getText().toString().trim();
        if (t.length() > 300) t = t.substring(0, 300);
        if (t.isEmpty()) {
          prefs().edit().remove("address_choice").apply();
          updateOverlay();
        } else setAddressChoice(t, "typed");
      })
      .setNegativeButton("Cancel", null)
      .show();
  }

  // ------------------------------------------------- template switch

  private JSONArray teamTemplates(String space) {
    try {
      return new JSONArray(getSharedPreferences("template_lists", 0).getString(space, "[]"));
    } catch (Exception e) {
      return new JSONArray();
    }
  }

  private JSONObject myTemplate(String space) {
    try {
      String raw = getSharedPreferences("my_templates", 0).getString(space, "");
      if (!raw.isEmpty()) return new JSONObject(raw);
      return new JSONObject(
        "{\"name\":\"My watermark\",\"fields\":[\"date\",\"time\",\"address\"],\"locked_fields\":[],\"position\":\"bottom-left\",\"font_size\":24,\"opacity\":0.6,\"version\":1,\"local\":true}"
      );
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  private void chooseTemplate() {
    String space = prefs().getString("space", "local");
    JSONObject current = Watermark.selected(this, space);
    JSONArray team = teamTemplates(space);
    JSONObject def = FieldRules.defaultTemplate(team);
    List<String> names = new ArrayList<>();
    List<JSONObject> picks = new ArrayList<>();
    for (int i = 0; i < team.length(); i++) {
      JSONObject t = team.optJSONObject(i);
      if (t == null) continue;
      boolean on = !current.optBoolean("local") && t.optString("id").equals(current.optString("id"));
      names.add((on ? "✓  " : "") + t.optString("name", "Team template") + (t.optBoolean("is_default") ? "  · team default" : ""));
      picks.add(t);
    }
    JSONObject mine = myTemplate(space);
    names.add((current.optBoolean("local") ? "✓  " : "") + "My watermark");
    picks.add(mine);
    names.add("✎  Edit my watermark fields…");
    picks.add(null);
    if (signedIn() && !space.equals("local")) {
      names.add("↻  Get latest team templates");
      picks.add(new JSONObject());
    }
    new android.app.AlertDialog.Builder(this)
      .setTitle("Watermark for new photos")
      .setItems(names.toArray(new String[0]), (d, i) -> {
        JSONObject t = picks.get(i);
        if (t == null) {
          editWatermark();
          return;
        }
        if (t.length() == 0) {
          refreshTemplate(true);
          return;
        }
        try {
          prefsTemplate(space, FieldRules.withTeamLocks(t, def));
          updateOverlay();
        } catch (Exception e) {
          message(e.getMessage());
        }
      })
      .show();
  }

  // ------------------------------------------------------------ capture

  private boolean cameraPermanentlyDenied() {
    if (
      checkSelfPermission(Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED
    ) return false;
    if (
      shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
    ) return false;
    return prefs().getBoolean("camera_denied_before", false);
  }

  private void openAppSettings() {
    try {
      Intent intent = new Intent(
        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        android.net.Uri.parse("package:" + getPackageName())
      );
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivity(intent);
    } catch (Exception e) {
      message("Open Settings and enable the camera for Snapoto.");
    }
  }

  private void reportSaveFailure(Exception e) {
    if (CaptureStore.isNoSpace(e)) message(
      "Storage full: no space left on device. Free space and retry. Photo not confirmed saved."
    );
    else message(
      "Save failed: " + e.getMessage() + ". Photo not confirmed saved."
    );
  }

  private boolean storageReady(long needBytes) {
    try {
      CaptureStore.requireSpace(CaptureStore.directory(this), needBytes);
      return true;
    } catch (Exception e) {
      message(
        "Storage full: no space left on device. Free space and retry. Photo not confirmed saved."
      );
      return false;
    }
  }

  private void takePhoto() {
    if (
      checkSelfPermission(Manifest.permission.CAMERA) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      if (cameraPermanentlyDenied()) {
        message("Camera is blocked. Open Settings to re-enable it.");
        show("Camera");
      } else requestPermissions(
        new String[] { Manifest.permission.CAMERA },
        10
      );
      return;
    }
    if (capture == null || taking) return;
    if (!storageReady(CaptureStore.MIN_FREE_PHOTO)) return;
    taking = true;
    String cid = UUID.randomUUID().toString(),
      timestamp = Instant.now().toString(),
      space = prefs().getString("space", "local"),
      user = prefs().getString("user", "local"),
      notes = noteText,
      address = currentAddress(),
      addressSource = addressSource();
    JSONObject gps = gpsAtCapture();
    if (
      checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
    ) locate(true); // refreshes the fix for the next photo; never awaited
    String audio = pendingAudio, audioHash = pendingAudioHash;
    pendingAudio = "";
    pendingAudioHash = "";
    if (voicePill != null) voicePill.setText("🎙  Voice note");
    JSONObject watermark = Watermark.selected(this, space);
    boolean dual = prefs().getBoolean("dual", false);
    File output = new File(CaptureStore.directory(this), cid + ".jpg");
    status("Saving…", 0xCC000000, false);
    capture.takePicture(
      new ImageCapture.OutputFileOptions.Builder(output).build(),
      captureIo,
      new ImageCapture.OnImageSavedCallback() {
        public void onImageSaved(ImageCapture.OutputFileResults result) {
          JSONObject record;
          try {
            JSONObject extra = new JSONObject()
              .put("address", address)
              .put("address_source", addressSource)
              .put("state", dual ? "awaiting_selfie" : "processing");
            if (!audio.isEmpty()) extra
              .put("audio_file", audio)
              .put("audio_sha256", audioHash);
            // Original + metadata are durable when this returns; everything
            // after it (watermark, selfie) is optional post-processing.
            record = CaptureStore.save(
              MainActivity.this,
              output,
              cid,
              space,
              user,
              timestamp,
              gps,
              notes,
              extra
            );
          } catch (Exception e) {
            runOnUiThread(() -> {
              taking = false;
              status("Photo NOT saved", Ui.RED, false);
              reportSaveFailure(e);
            });
            return;
          }
          runOnUiThread(() -> {
            status("Saved ✓  " + localTime(timestamp, "HH:mm:ss"), Ui.GREEN, true);
            if (dual) captureSelfie(record, watermark);
            else taking = false;
          });
          io.execute(() -> showThumb(record));
          if (!dual) renderer.execute(() -> renderAndQueue(cid, watermark));
        }

        public void onError(ImageCaptureException e) {
          runOnUiThread(() -> {
            taking = false;
            status("Photo NOT saved", Ui.RED, false);
            message("Capture failed: " + e.getMessage());
          });
        }
      }
    );
  }

  /** Render the shareable copy, then release the record to the upload queue. */
  private void renderAndQueue(String cid, JSONObject watermark) {
    Context app = getApplicationContext();
    File recordFile = CaptureStore.recordFile(app, cid);
    try {
      CaptureStore.update(recordFile, r -> {
        try {
          r.put(
            "rendered",
            Watermark.render(
              app,
              new File(CaptureStore.directory(app), r.getString("file")),
              watermark,
              r
            )
          );
          r.remove("render_error");
        } catch (Exception renderError) {
          r.put("render_error", String.valueOf(renderError.getMessage()));
        }
        r.put("state", SyncPolicy.PENDING);
      });
    } catch (Exception e) {
      // The original and its metadata are already durable; recovery on next
      // launch moves the record to pending.
    }
    SyncWorker.enqueue(app);
  }

  private String localTime(String isoInstant, String pattern) {
    try {
      return Instant.parse(isoInstant)
        .atZone(java.time.ZoneId.systemDefault())
        .format(
          java.time.format.DateTimeFormatter.ofPattern(pattern, Locale.US)
        );
    } catch (Exception e) {
      return isoInstant;
    }
  }

  /** GPS for this capture with age measured now, not when the fix arrived. */
  private JSONObject gpsAtCapture() {
    if (lastGps == null || lastGpsNanos == 0) return null;
    try {
      long age = Math.max(
        0,
        (SystemClock.elapsedRealtimeNanos() - lastGpsNanos) / 1000000
      );
      return new JSONObject(lastGps.toString()).put("age_ms", age);
    } catch (Exception e) {
      return null;
    }
  }

  @SuppressWarnings("deprecation")
  private int displayRotation() {
    try {
      Display d = Build.VERSION.SDK_INT >= 30
        ? getDisplay()
        : getWindowManager().getDefaultDisplay();
      return d == null ? Surface.ROTATION_0 : d.getRotation();
    } catch (Exception e) {
      return Surface.ROTATION_0;
    }
  }

  /**
   * The activity handles rotation itself (manifest configChanges) so an
   * in-flight capture, video or voice note is not torn down by recreation;
   * only the output rotation (EXIF) needs updating.
   */
  @Override
  public void onConfigurationChanged(android.content.res.Configuration c) {
    super.onConfigurationChanged(c);
    int rotation = displayRotation();
    if (capture != null) capture.setTargetRotation(rotation);
    if (videoCapture != null) videoCapture.setTargetRotation(rotation);
  }

  // ------------------------------------------------------------ photos

  private void photos() {
    LinearLayout page = Ui.vertical(this);
    content.addView(page, new FrameLayout.LayoutParams(-1, -1));
    LinearLayout head = Ui.row(this);
    head.setPadding(dp(20), dp(16), dp(16), dp(8));
    LinearLayout titles = Ui.vertical(this);
    titles.addView(Ui.title(this, "Photos", 28));
    titles.addView(Ui.text(this, spaceLabel(), 14, Ui.MUTED));
    head.addView(titles, new LinearLayout.LayoutParams(0, -2, 1));
    page.addView(head);
    List<JSONObject> records = new ArrayList<>();
    for (JSONObject r : CaptureStore.all(this)) if (mine(r)) records.add(r);
    int problems = 0;
    for (JSONObject r : records) if (statusOf(r).kind == FieldRules.StatusKind.PROBLEM) problems++;
    if (problems > 0) {
      Button retry = Ui.colored(
        this,
        "↻  Retry " + problems,
        Ui.RED,
        Color.WHITE,
        () -> {
          SyncWorker.enqueue(this, true);
          message(
            prefs().getBoolean("cloud", false)
              ? "Retrying uploads now"
              : "Cloud backup is off. Turn it on in Me."
          );
        }
      );
      head.addView(retry, new LinearLayout.LayoutParams(-2, dp(48)));
    }
    if (records.isEmpty()) {
      LinearLayout card = Ui.card(this);
      card.addView(Ui.title(this, "No photos yet", 20));
      card.addView(
        Ui.text(
          this,
          "Photos you take in " + spaceLabel() + " show up here, with their upload status.",
          15,
          Ui.MUTED
        ),
        Ui.full(this, 6)
      );
      card.addView(Ui.button(this, "Take a photo", true, () -> show("Camera")), Ui.full(this, 16));
      LinearLayout.LayoutParams cp = Ui.full(this, 8);
      cp.leftMargin = cp.rightMargin = dp(16);
      page.addView(card, cp);
      return;
    }
    List<Object> items = FieldRules.groupByDay(
      records,
      java.time.ZoneId.systemDefault(),
      java.time.LocalDate.now()
    );
    ListView list = new ListView(this);
    list.setDivider(null);
    list.setSelector(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
    list.setClipToPadding(false);
    list.setPadding(dp(12), 0, dp(12), dp(16));
    page.addView(list, new LinearLayout.LayoutParams(-1, 0, 1));
    BaseAdapter adapter = new BaseAdapter() {
      public int getCount() {
        return items.size();
      }

      public Object getItem(int position) {
        return items.get(position);
      }

      public long getItemId(int position) {
        return position;
      }

      @Override
      public int getViewTypeCount() {
        return 2;
      }

      @Override
      public int getItemViewType(int position) {
        return items.get(position) instanceof String ? 0 : 1;
      }

      @Override
      public boolean isEnabled(int position) {
        return getItemViewType(position) == 1;
      }

      public View getView(int position, View old, ViewGroup parent) {
        Object item = items.get(position);
        if (item instanceof String) {
          TextView h = old instanceof TextView ? (TextView) old : Ui.title(MainActivity.this, "", 15);
          h.setText((String) item);
          h.setTextColor(Ui.MUTED);
          h.setPadding(dp(8), dp(18), dp(8), dp(8));
          return h;
        }
        return photoRow((JSONObject) item, old);
      }
    };
    list.setAdapter(adapter);
    list.setOnItemClickListener((p, v, pos, id) -> {
      Object item = items.get(pos);
      if (item instanceof JSONObject) detail((JSONObject) item);
    });
    refreshCloud(items, adapter);
  }

  private View photoRow(JSONObject r, View old) {
    LinearLayout row;
    if (old instanceof FrameLayout && "photo-wrap".equals(old.getTag())) row = (LinearLayout) ((FrameLayout) old).getChildAt(0);
    else {
      row = Ui.row(this);
      row.setTag("photo-row");
      row.setBackground(Ui.outlined(this, Ui.CARD, Ui.LINE, 16));
      row.setPadding(dp(10), dp(10), dp(12), dp(10));
      row.setGravity(Gravity.TOP);
      ImageView image = new ImageView(this);
      image.setScaleType(ImageView.ScaleType.CENTER_CROP);
      image.setBackground(Ui.round(this, Ui.LINE, 12));
      image.setClipToOutline(true);
      row.addView(image, new LinearLayout.LayoutParams(dp(84), dp(84)));
      LinearLayout col = Ui.vertical(this);
      col.setPadding(dp(12), 0, 0, 0);
      row.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
      AbsListView.LayoutParams lp = new AbsListView.LayoutParams(-1, -2);
      row.setLayoutParams(lp);
    }
    ImageView image = (ImageView) row.getChildAt(0);
    LinearLayout col = (LinearLayout) row.getChildAt(1);
    col.removeAllViews();
    String when = localTime(r.optString("captured_at_device"), "h:mm a");
    TextView top = Ui.title(this, when + (r.optString("kind").equals("video") ? "  · Video" : ""), 16);
    col.addView(top);
    String address = r.optString("address", "");
    if (!address.isEmpty()) {
      TextView a = Ui.text(this, address, 13, Ui.MUTED);
      a.setSingleLine();
      a.setEllipsize(android.text.TextUtils.TruncateAt.END);
      col.addView(a);
    }
    FieldRules.Status s = statusOf(r);
    int color = Ui.statusColor(s.kind);
    LinearLayout chip = Ui.statusChip(this, color, s.label, false);
    LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(-2, -2);
    cp.topMargin = dp(6);
    col.addView(chip, cp);
    if (!s.reason.isEmpty()) {
      TextView reason = Ui.text(this, s.reason, 13, s.kind == FieldRules.StatusKind.PROBLEM ? Ui.RED : Ui.MUTED);
      reason.setMaxLines(2);
      reason.setEllipsize(android.text.TextUtils.TruncateAt.END);
      col.addView(reason, Ui.full(this, 4));
    }
    String caption = FieldRules.caption(r.optJSONObject("cloud"));
    if (!caption.isEmpty()) {
      TextView c = Ui.text(this, "✦  " + caption, 14, Ui.AI);
      c.setMaxLines(2);
      c.setEllipsize(android.text.TextUtils.TruncateAt.END);
      col.addView(c, Ui.full(this, 4));
    }
    int open = 0;
    for (FieldRules.Finding f : aiFindings(r)) if (f.proposed()) open++;
    if (open > 0 && FieldRules.canReview(r, prefs().getString("user", ""), signedIn())) {
      TextView f = Ui.title(this, "✦  AI found " + open + " · tap to confirm", 13);
      f.setTextColor(Ui.AI);
      f.setBackground(Ui.round(this, Ui.AI_SOFT, 10));
      f.setPadding(dp(8), dp(3), dp(8), dp(3));
      LinearLayout.LayoutParams fp = new LinearLayout.LayoutParams(-2, -2);
      fp.topMargin = dp(6);
      col.addView(f, fp);
    }
    String id = r.optString("id");
    image.setImageDrawable(null);
    image.setTag(id);
    io.execute(() -> {
      JSONObject rendered = r.optJSONObject("rendered");
      String filename = rendered == null ? r.optString("file") : rendered.optString("file");
      Bitmap thumbnail = Watermark.thumbnail(
        new File(CaptureStore.directory(this), filename).getPath(),
        240
      );
      runOnUiThread(() -> {
        if (id.equals(image.getTag())) image.setImageBitmap(thumbnail);
        else if (thumbnail != null) thumbnail.recycle();
      });
    });
    // Spacing between cards inside the ListView. A recycled row is already
    // inside its wrapper (and carries FrameLayout params), so reuse it.
    if (row.getParent() instanceof FrameLayout) return (View) row.getParent();
    FrameLayout wrap = new FrameLayout(this);
    wrap.setLayoutParams(new AbsListView.LayoutParams(-1, -2));
    wrap.setTag("photo-wrap");
    wrap.setPadding(0, dp(4), 0, dp(4));
    row.setLayoutParams(new FrameLayout.LayoutParams(-1, -2));
    wrap.addView(row);
    return wrap;
  }

  private List<FieldRules.Finding> aiFindings(JSONObject r) {
    JSONObject cloud = r.optJSONObject("cloud");
    return FieldRules.findings(cloud == null ? null : cloud.optJSONObject("ai"));
  }

  /**
   * Fetch the server copy (AI caption/findings) of the person's own uploaded
   * photos and cache it in the local record. Missing endpoint (404) or AI off
   * (503) just leaves the row as it is.
   */
  private void refreshCloud(List<Object> items, BaseAdapter adapter) {
    if (!signedIn()) return;
    String user = prefs().getString("user", "");
    long now = System.currentTimeMillis();
    List<Integer> todo = new ArrayList<>();
    for (int i = 0; i < items.size() && todo.size() < 25; i++) {
      Object o = items.get(i);
      if (
        o instanceof JSONObject &&
        FieldRules.canReview((JSONObject) o, user, true) &&
        FieldRules.shouldRefreshCloud((JSONObject) o, now, 60000)
      ) todo.add(i);
    }
    if (todo.isEmpty()) return;
    net.execute(() -> {
      for (int i : todo) {
        if (!tab.equals("Photos")) return;
        JSONObject r = (JSONObject) items.get(i);
        JSONObject updated = fetchCloud(r);
        if (updated == null) continue;
        runOnUiThread(() -> {
          if (i < items.size() && items.get(i) == r) {
            items.set(i, updated);
            adapter.notifyDataSetChanged();
          }
        });
      }
    });
  }

  /** GET the capture and cache it; null on any failure. Worker thread only. */
  private JSONObject fetchCloud(JSONObject r) {
    try {
      JSONObject cap = Api.request(
        this,
        "/api/spaces/" + r.getString("space_id") + "/captures/" + r.getString("id"),
        "GET",
        null
      );
      return cacheCloud(r.getString("id"), cap);
    } catch (Exception e) {
      return null;
    }
  }

  private JSONObject cacheCloud(String cid, JSONObject capture) throws Exception {
    JSONObject cache = FieldRules.cloudCache(capture, System.currentTimeMillis());
    return CaptureStore.update(
      CaptureStore.recordFile(this, cid),
      cur -> cur.put("cloud", cache)
    );
  }

  // ------------------------------------------------------------ detail

  private android.app.Dialog detailDialog;

  @SuppressWarnings("deprecation")
  private void detail(JSONObject r) {
    if (detailDialog != null && detailDialog.isShowing()) detailDialog.dismiss();
    android.app.Dialog d = new android.app.Dialog(
      this,
      android.R.style.Theme_Material_Light_NoActionBar
    );
    detailDialog = d;
    ScrollView scroll = new ScrollView(this);
    scroll.setBackgroundColor(Ui.BG);
    scroll.setFitsSystemWindows(true);
    LinearLayout page = Ui.vertical(this);
    page.setPadding(dp(16), dp(8), dp(16), dp(32));
    scroll.addView(page);
    d.setContentView(scroll);
    fillDetail(d, page, r);
    d.show();
    // Pull the freshest AI result when it is the person's own cloud photo.
    if (FieldRules.canReview(r, prefs().getString("user", ""), signedIn())) net.execute(() -> {
      JSONObject updated = fetchCloud(r);
      if (updated != null) runOnUiThread(() -> {
        if (d.isShowing()) fillDetail(d, page, updated);
      });
    });
  }

  private void fillDetail(android.app.Dialog d, LinearLayout page, JSONObject r) {
    page.removeAllViews();
    LinearLayout bar = Ui.row(this);
    Button back = Ui.button(this, "←  Back", false, d::dismiss);
    bar.addView(back, new LinearLayout.LayoutParams(-2, dp(48)));
    TextView when = Ui.title(this, localTime(r.optString("captured_at_device"), "EEE, MMM d · h:mm a"), 16);
    when.setPadding(dp(14), 0, 0, 0);
    bar.addView(when, new LinearLayout.LayoutParams(0, -2, 1));
    page.addView(bar);

    ImageView image = new ImageView(this);
    image.setScaleType(ImageView.ScaleType.FIT_CENTER);
    image.setBackground(Ui.round(this, Color.BLACK, 16));
    image.setClipToOutline(true);
    page.addView(image, new LinearLayout.LayoutParams(-1, dp(320)) {
      {
        topMargin = dp(12);
      }
    });
    io.execute(() -> {
      JSONObject rendered = r.optJSONObject("rendered");
      String filename = rendered == null ? r.optString("file") : rendered.optString("file");
      Bitmap bm = Watermark.thumbnail(new File(CaptureStore.directory(this), filename).getPath(), 1400);
      runOnUiThread(() -> {
        if (bm != null && d.isShowing()) image.setImageBitmap(bm);
      });
    });

    FieldRules.Status s = statusOf(r);
    LinearLayout statusRow = Ui.row(this);
    statusRow.addView(Ui.statusChip(this, Ui.statusColor(s.kind), s.label, false));
    page.addView(statusRow, Ui.full(this, 12));
    if (!s.reason.isEmpty()) page.addView(
      Ui.text(this, s.reason, 14, s.kind == FieldRules.StatusKind.PROBLEM ? Ui.RED : Ui.MUTED),
      Ui.full(this, 4)
    );
    if (s.kind == FieldRules.StatusKind.PROBLEM) page.addView(
      Ui.button(this, "↻  Retry upload", true, () -> {
        SyncWorker.enqueue(this, true);
        message("Retrying now");
      }),
      Ui.full(this, 8)
    );
    if (r.has("render_error")) page.addView(
      Ui.text(this, "Watermarked copy failed · the original is safe", 13, Ui.MUTED),
      Ui.full(this, 4)
    );

    aiSection(d, page, r);

    LinearLayout info = Ui.card(this);
    info.addView(Ui.title(this, "Details", 17));
    infoRow(info, "Taken", localTime(r.optString("captured_at_device"), "yyyy-MM-dd HH:mm:ss") + " (phone time)");
    String addr = r.optString("address", "");
    String src = r.optString("address_source", "");
    infoRow(
      info,
      "Address",
      addr.isEmpty()
        ? "—"
        : addr + (src.equals("picked") || src.equals("typed") ? "  (" + src + " by you)" : "")
    );
    JSONObject gps = r.optJSONObject("gps");
    infoRow(
      info,
      "GPS",
      gps == null
        ? "No fix"
        : String.format(Locale.US, "%.5f, %.5f · ±%d m", gps.optDouble("latitude"), gps.optDouble("longitude"), gps.optInt("accuracy"))
    );
    if (!r.optString("note").isEmpty()) infoRow(info, "Note", r.optString("note"));
    JSONObject cloud = r.optJSONObject("cloud");
    if (cloud != null && !cloud.optString("order_number").isEmpty()) infoRow(
      info,
      "Order #",
      cloud.optString("order_number") + (cloud.optBoolean("order_confirmed") ? "  ✓ confirmed" : "")
    );
    String sha = r.optString("sha256");
    infoRow(info, "Fingerprint", sha.length() > 16 ? sha.substring(0, 16) + "…" : sha);
    page.addView(info, Ui.full(this, 16));
    page.addView(Ui.button(this, "Share a copy", false, () -> shareLocal(r)), Ui.full(this, 12));
  }

  private void infoRow(LinearLayout box, String label, String value) {
    LinearLayout row = Ui.row(this);
    row.setGravity(Gravity.TOP);
    TextView l = Ui.text(this, label, 14, Ui.MUTED);
    row.addView(l, new LinearLayout.LayoutParams(dp(100), -2));
    TextView v = Ui.text(this, value, 14, Ui.INK);
    v.setTextIsSelectable(true);
    row.addView(v, new LinearLayout.LayoutParams(0, -2, 1));
    box.addView(row, Ui.full(this, 8));
  }

  private void aiSection(android.app.Dialog d, LinearLayout page, JSONObject r) {
    String user = prefs().getString("user", "");
    boolean review = FieldRules.canReview(r, user, signedIn());
    JSONObject cloud = r.optJSONObject("cloud");
    JSONObject ai = cloud == null ? null : cloud.optJSONObject("ai");
    if (!review && cloud == null) {
      if (!FieldRules.isLocalOnly(r)) page.addView(
        Ui.text(this, "✦  AI suggestions appear here after the photo is in the cloud.", 14, Ui.AI),
        Ui.full(this, 14)
      );
      return;
    }
    LinearLayout card = Ui.vertical(this);
    card.setBackground(Ui.round(this, Ui.AI_SOFT, 18));
    card.setPadding(dp(16), dp(14), dp(16), dp(16));
    TextView head = Ui.title(this, "✦  AI", 17);
    head.setTextColor(Ui.AI);
    card.addView(head);
    // Captures without an "ai" block: AI is off for them.
    String state = ai == null ? "off" : ai.optString("state");
    String caption = FieldRules.caption(cloud);
    if (!caption.isEmpty()) card.addView(Ui.text(this, caption, 16, Ui.INK), Ui.full(this, 6));
    else if (state.equals("pending") || state.isEmpty()) card.addView(
      Ui.text(this, "Reading this photo… (usually under 20 seconds; reopen to refresh)", 14, Ui.MUTED),
      Ui.full(this, 6)
    );
    else if (state.equals("failed")) card.addView(Ui.text(this, "AI could not read this photo.", 14, Ui.MUTED), Ui.full(this, 6));
    else if (state.equals("off")) card.addView(Ui.text(this, "AI is off for this space.", 14, Ui.MUTED), Ui.full(this, 6));
    JSONArray tags = ai == null ? null : ai.optJSONArray("tags");
    if (tags != null && tags.length() > 0) {
      StringBuilder t = new StringBuilder();
      for (int i = 0; i < tags.length() && i < 6; i++) t.append(i == 0 ? "" : "  ").append("#").append(FieldRules.clip(tags.optString(i), 24));
      card.addView(Ui.text(this, t.toString(), 13, Ui.AI), Ui.full(this, 6));
    }
    for (FieldRules.Finding f : aiFindings(r)) {
      if (f.status.equals("dismissed")) continue;
      LinearLayout fc = Ui.card(this);
      TextView label = Ui.text(this, "AI found · " + FieldRules.fieldLabel(f.field), 13, Ui.AI);
      fc.addView(label);
      fc.addView(Ui.title(this, f.value, 22), Ui.full(this, 2));
      String meta = (f.where.isEmpty() ? "" : f.where + " · ") + Math.round(f.confidence * 100) + "% sure";
      fc.addView(Ui.text(this, meta, 13, Ui.MUTED));
      if (f.status.equals("accepted")) {
        TextView ok = Ui.title(this, "✓  Confirmed", 15);
        ok.setTextColor(Ui.GREEN);
        fc.addView(ok, Ui.full(this, 8));
      } else if (review) {
        LinearLayout actions = Ui.row(this);
        Button yes = Ui.colored(this, "✓  Confirm", Ui.GREEN, Color.WHITE, () -> reviewFinding(d, page, r, f, "accept"));
        actions.addView(yes, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button no = Ui.button(this, "Dismiss", false, () -> reviewFinding(d, page, r, f, "dismiss"));
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(0, dp(52), 1);
        np.leftMargin = dp(10);
        actions.addView(no, np);
        fc.addView(actions, Ui.full(this, 10));
      }
      card.addView(fc, Ui.full(this, 10));
    }
    JSONArray issues = ai == null ? null : ai.optJSONArray("issues");
    if (issues != null) for (int i = 0; i < issues.length() && i < 5; i++) {
      String issue = FieldRules.clip(issues.optString(i).trim(), 160);
      if (!issue.isEmpty()) card.addView(Ui.text(this, "⚠  Worth checking: " + issue, 14, Ui.AMBER), Ui.full(this, 8));
    }
    card.addView(
      Ui.text(this, "AI suggestions are never used until you confirm them.", 12, Ui.MUTED),
      Ui.full(this, 10)
    );
    page.addView(card, Ui.full(this, 16));
  }

  private void reviewFinding(
    android.app.Dialog d,
    LinearLayout page,
    JSONObject r,
    FieldRules.Finding f,
    String action
  ) {
    JSONObject cloud = r.optJSONObject("cloud");
    if (
      action.equals("accept") &&
      f.field.equals("order_number") &&
      cloud != null &&
      cloud.optBoolean("order_confirmed") &&
      !cloud.optString("order_number").isEmpty() &&
      !cloud.optString("order_number").equals(f.value)
    ) {
      message("Already confirmed: " + cloud.optString("order_number") + ". Nothing changed.");
      return;
    }
    String sid = r.optString("space_id"), cid = r.optString("id");
    net.execute(() -> {
      try {
        JSONObject body = new JSONObject().put("action", action);
        // A person tapping Confirm is the human confirmation of the order #.
        if (action.equals("accept") && f.field.equals("order_number")) body.put("confirm", true);
        JSONObject cap = Api.request(
          this,
          "/api/spaces/" + sid + "/captures/" + cid + "/findings/" + android.net.Uri.encode(f.id),
          "POST",
          body
        );
        JSONObject updated = cacheCloud(cid, cap);
        runOnUiThread(() -> {
          message(action.equals("accept") ? "Confirmed" : "Dismissed");
          if (d.isShowing()) fillDetail(d, page, updated);
        });
      } catch (Api.HttpException e) {
        String msg;
        if (e.status == 409) msg = cloud != null && !cloud.optString("order_number").isEmpty()
          ? "Already confirmed: " + cloud.optString("order_number") + ". Nothing changed."
          : "A different order # is already confirmed. Nothing changed.";
        else if (e.status == 404 || e.status == 503) msg = "AI review is not available on this server yet.";
        else if (e.status == 403) msg = "You can only review your own photos.";
        else if (e.status == 401) msg = "Session expired. Sign in again in Me.";
        else msg = e.getMessage();
        runOnUiThread(() -> message(msg));
      } catch (Exception e) {
        runOnUiThread(() -> message("No connection. Try again when online."));
      }
    });
  }

  // ---------------------------------------------------------------- Me

  private boolean validBase(String base) {
    if (!Api.allowedBase(base, Api.debuggable(this))) {
      message("Enter a valid HTTPS server URL");
      return false;
    }
    return true;
  }

  private void storeMe(JSONObject me) throws Exception {
    JSONArray spaces = me.getJSONArray("spaces");
    prefs()
      .edit()
      .putString("user", me.getString("id"))
      .putString("name", me.optString("name", ""))
      .putString("spaces", spaces.toString())
      .commit();
  }

  private void finishSignIn(String base, String mail, String token)
    throws Exception {
    prefs()
      .edit()
      .putString("server", base)
      .putString("token", token)
      .putString("email", mail)
      .commit();
    JSONObject me = Api.request(this, "/api/me", "GET", null);
    JSONArray spaces = me.getJSONArray("spaces");
    if (!prefs().getString("user", "").equals(me.getString("id"))) prefs()
      .edit()
      .putBoolean("cloud", false)
      .commit();
    storeMe(me);
    prefs()
      .edit()
      .putString("space", spaces.getJSONObject(0).getString("id"))
      .putString("space_name", spaces.getJSONObject(0).getString("name"))
      .commit();
    runOnUiThread(() -> {
      message("Signed in");
      show("Me");
      refreshTemplate(true);
      SyncWorker.enqueue(this);
    });
  }

  private LinearLayout section(LinearLayout form, String heading) {
    TextView h = Ui.title(this, heading, 14);
    h.setTextColor(Ui.MUTED);
    h.setPadding(dp(4), 0, 0, 0);
    form.addView(h, Ui.full(this, 20));
    LinearLayout card = Ui.card(this);
    form.addView(card, Ui.full(this, 8));
    return card;
  }

  private void account() {
    ScrollView scroll = new ScrollView(this);
    LinearLayout form = Ui.vertical(this);
    form.setPadding(dp(16), dp(16), dp(16), dp(32));
    scroll.addView(form);
    content.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
    form.addView(Ui.title(this, "Me", 28));
    boolean in = signedIn();

    LinearLayout acct = section(form, "ACCOUNT");
    if (in) {
      String name = prefs().getString("name", "");
      acct.addView(Ui.title(this, name.isEmpty() ? prefs().getString("email", "") : name, 18));
      if (!name.isEmpty()) acct.addView(Ui.text(this, prefs().getString("email", ""), 14, Ui.MUTED));
      acct.addView(Ui.text(this, "Server: " + Api.base(this).replaceFirst("^https?://", ""), 13, Ui.MUTED), Ui.full(this, 4));
      acct.addView(Ui.button(this, "Sign out", false, () -> {
        prefs()
          .edit()
          .remove("token")
          .remove("user")
          .remove("space")
          .remove("space_name")
          .remove("spaces")
          .putBoolean("cloud", false)
          .apply();
        show("Me");
      }), Ui.full(this, 12));
    } else {
      acct.addView(Ui.title(this, "Sign in to back up photos", 18));
      acct.addView(
        Ui.text(this, "You can take photos without an account. Photos taken while signed out stay on this phone, even after you sign in.", 14, Ui.MUTED),
        Ui.full(this, 4)
      );
      String base = Api.base(this);
      EditText server = Ui.input(this, "Server URL (https://…)", base, false);
      server.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
      TextView serverRow = Ui.text(this, "Server: " + base.replaceFirst("^https?://", "") + "   Change", 13, Ui.PRIMARY);
      serverRow.setPadding(0, dp(10), 0, dp(10));
      serverRow.setOnClickListener(v -> {
        serverRow.setVisibility(View.GONE);
        server.setVisibility(View.VISIBLE);
      });
      boolean hasBase = !base.isEmpty();
      serverRow.setVisibility(hasBase ? View.VISIBLE : View.GONE);
      server.setVisibility(hasBase ? View.GONE : View.VISIBLE);
      acct.addView(serverRow);
      acct.addView(server);
      EditText email = Ui.input(this, "Email", prefs().getString("email", ""), false);
      email.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
      acct.addView(email, Ui.full(this, 4));
      EditText password = Ui.input(this, "Password (12+ characters)", "", true);
      acct.addView(password);
      EditText name = Ui.input(this, "Your name (only for a new account)", "", false);
      acct.addView(name);
      LinearLayout buttons = Ui.row(this);
      Button signIn = Ui.button(this, "Sign in", true, () -> {
        String b = server.getText().toString().trim().replaceAll("/+$", "");
        String mail = email.getText().toString().trim(), pass = password.getText().toString();
        if (!validBase(b)) return;
        if (mail.isEmpty() || pass.isEmpty()) {
          message("Enter your email and password");
          return;
        }
        prefs().edit().putString("server", b).apply();
        message("Signing in…");
        io.execute(() -> {
          try {
            JSONObject login = Api.request(this, "/api/auth/login", "POST", new JSONObject().put("email", mail).put("password", pass));
            finishSignIn(b, mail, login.getString("token"));
          } catch (Exception e) {
            runOnUiThread(() -> message(e.getMessage()));
          }
        });
      });
      buttons.addView(signIn, new LinearLayout.LayoutParams(0, dp(52), 1));
      Button create = Ui.button(this, "Create account", false, () -> {
        String b = server.getText().toString().trim().replaceAll("/+$", "");
        String who = name.getText().toString().trim(), mail = email.getText().toString().trim(), pass = password.getText().toString();
        if (!validBase(b)) return;
        if (who.isEmpty()) {
          message("Enter your name to create an account");
          name.requestFocus();
          return;
        }
        if (pass.length() < 12) {
          message("Password needs at least 12 characters");
          return;
        }
        prefs().edit().putString("server", b).apply();
        message("Creating account…");
        io.execute(() -> {
          try {
            JSONObject reg = Api.request(this, "/api/auth/register", "POST", new JSONObject().put("name", who).put("email", mail).put("password", pass));
            finishSignIn(b, mail, reg.getString("token"));
          } catch (Exception e) {
            runOnUiThread(() -> message(e.getMessage()));
          }
        });
      });
      LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, dp(52), 1);
      cp.leftMargin = dp(10);
      buttons.addView(create, cp);
      acct.addView(buttons, Ui.full(this, 12));
    }

    LinearLayout space = section(form, "NEW PHOTOS GO TO");
    String sid = prefs().getString("space", "local");
    space.addView(Ui.title(this, spaceLabel(), 18));
    String role = in ? spaceRole(sid) : "";
    String kind = in ? spaceKind(sid) : "";
    space.addView(
      Ui.text(
        this,
        !in
          ? "Sign in to choose a team. Photos stay on this phone."
          : (kind.equals("personal") ? "Personal · only you see these" : "Team" + (role.isEmpty() ? "" : " · you are " + role)) +
          "\nEach photo stays in the space it was taken in.",
        14,
        Ui.MUTED
      ),
      Ui.full(this, 4)
    );
    LinearLayout spaceButtons = Ui.row(this);
    Button switchSpace = Ui.button(this, "Switch", false, this::chooseSpace);
    switchSpace.setEnabled(in);
    spaceButtons.addView(switchSpace, new LinearLayout.LayoutParams(0, dp(52), 1));
    Button join = Ui.button(this, "Join a team", true, this::joinTeam);
    LinearLayout.LayoutParams jp = new LinearLayout.LayoutParams(0, dp(52), 1);
    jp.leftMargin = dp(10);
    spaceButtons.addView(join, jp);
    space.addView(spaceButtons, Ui.full(this, 12));

    LinearLayout up = section(form, "CLOUD BACKUP");
    List<JSONObject> all = CaptureStore.all(this);
    int[] c = FieldRules.counts(all);
    LinearLayout stats = Ui.row(this);
    stat(stats, c[0], "In cloud", Ui.GREEN);
    stat(stats, c[1] + c[2], "Waiting", c[1] > 0 ? Ui.BLUE : Ui.GRAY);
    stat(stats, c[3], "Problems", c[3] > 0 ? Ui.RED : Ui.GRAY);
    stat(stats, c[4], "Phone only", Ui.GRAY);
    up.addView(stats);
    Switch cloud = Ui.toggle(this, "Back up my work photos", prefs().getBoolean("cloud", false));
    cloud.setEnabled(in);
    final String consentSpace = sid;
    final boolean canConsent = in && (role.equals("Owner") || role.equals("Admin"));
    cloud.setOnCheckedChangeListener((b, checked) -> {
      prefs().edit().putBoolean("cloud", checked).apply();
      if (!checked) return;
      if (!canConsent || consentSpace.equals("local")) {
        SyncWorker.enqueue(this);
        if (in && !consentSpace.equals("local")) message("Ask your team owner to turn on cloud storage.");
        return;
      }
      // Owner/Admin: this switch is the space's upload consent (PRD §4.1).
      net.execute(() -> {
        try {
          Api.request(this, "/api/spaces/" + consentSpace + "/cloud-consent", "POST",
            new JSONObject().put("enabled", true));
          runOnUiThread(() -> {
            message("Backup on. Uploading now.");
            SyncWorker.enqueue(this, true);
          });
        } catch (Exception e) {
          runOnUiThread(() -> {
            message("Backup on, but cloud storage could not be enabled yet. Will retry.");
            SyncWorker.enqueue(this);
          });
        }
      });
    });
    up.addView(cloud, Ui.full(this, 8));
    Switch wifi = Ui.toggle(this, "Upload on Wi-Fi only", prefs().getBoolean("wifi_only", false));
    wifi.setOnCheckedChangeListener((b, checked) -> {
      prefs().edit().putBoolean("wifi_only", checked).apply();
      SyncWorker.reschedule(this);
      message(checked ? "Uploads wait for Wi-Fi" : "Uploads use any connection");
    });
    up.addView(wifi);
    up.addView(
      Ui.text(this, "Turning this on allows uploads for this space. Originals stay on this phone after upload.", 13, Ui.MUTED),
      Ui.full(this, 4)
    );
    if (c[3] > 0) up.addView(
      Ui.colored(this, "↻  Retry problem uploads", Ui.RED, Color.WHITE, () -> {
        SyncWorker.enqueue(this, true);
        message("Retrying now");
      }),
      Ui.full(this, 12)
    );

    LinearLayout cam = section(form, "CAMERA");
    Switch dual = Ui.toggle(this, "Also take a front-camera photo", prefs().getBoolean("dual", false));
    dual.setOnCheckedChangeListener((b, checked) -> {
      try {
        if (
          checked &&
          (provider == null ||
            !provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) ||
            !provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA))
        ) {
          message("Two cameras are not available on this device");
          b.setChecked(false);
          return;
        }
        prefs().edit().putBoolean("dual", checked).apply();
      } catch (Exception e) {
        b.setChecked(false);
      }
    });
    cam.addView(dual);
    cam.addView(Ui.text(this, "Taken right after the main photo. Not identity verification.", 13, Ui.MUTED));

    if (in) form.addView(
      Ui.button(this, "Open the team website", false, () -> {
        String url = Api.base(this);
        if (!url.isEmpty()) try {
          startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)));
        } catch (Exception e) {
          message("No browser available");
        }
      }),
      Ui.full(this, 20)
    );
  }

  private void stat(LinearLayout row, int value, String label, int color) {
    LinearLayout box = Ui.vertical(this);
    box.setGravity(Gravity.CENTER_HORIZONTAL);
    TextView v = Ui.title(this, String.valueOf(value), 24);
    v.setTextColor(color);
    box.addView(v);
    TextView l = Ui.text(this, label, 12, Ui.MUTED);
    l.setGravity(Gravity.CENTER);
    box.addView(l);
    row.addView(box, new LinearLayout.LayoutParams(0, -2, 1));
  }

  private void joinTeam() {
    if (!signedIn()) {
      message("Sign in or create an account first, then join your team.");
      return;
    }
    EditText e = Ui.input(this, "Paste invite link or code", "", false);
    FrameLayout box = new FrameLayout(this);
    box.setPadding(dp(20), dp(8), dp(20), 0);
    box.addView(e);
    new android.app.AlertDialog.Builder(this)
      .setTitle("Join a team")
      .setMessage("Ask your manager for the invite link. Photos you already took stay where they are.")
      .setView(box)
      .setPositiveButton("Join", (d, w) -> {
        String token = FieldRules.inviteToken(e.getText().toString());
        if (token == null) {
          message("That doesn't look like an invite link or code.");
          return;
        }
        io.execute(() -> {
          try {
            JSONObject res = Api.request(this, "/api/invites/accept", "POST", new JSONObject().put("token", token));
            String joined = res.getString("space_id");
            JSONObject me = Api.request(this, "/api/me", "GET", null);
            storeMe(me);
            String name = "your team";
            JSONArray spaces = me.getJSONArray("spaces");
            for (int i = 0; i < spaces.length(); i++) if (spaces.getJSONObject(i).getString("id").equals(joined)) name = spaces.getJSONObject(i).getString("name");
            String spaceName = name;
            prefs().edit().putString("space", joined).putString("space_name", spaceName).commit();
            lastCid = "";
            runOnUiThread(() -> {
              message("Joined " + spaceName + ". New photos go to this team; earlier photos stay where they were.");
              show("Me");
              refreshTemplate(false);
            });
          } catch (Api.HttpException ex) {
            String msg = ex.status == 410 ? "This invite has expired or was already used. Ask for a new one." : ex.getMessage();
            runOnUiThread(() -> message(msg));
          } catch (Exception ex) {
            runOnUiThread(() -> message("Could not join: " + ex.getMessage()));
          }
        });
      })
      .setNegativeButton("Cancel", null)
      .show();
  }

  private void chooseSpace() {
    if (!signedIn()) {
      message("Sign in to choose a team. Until then photos stay on this phone.");
      if (!tab.equals("Me")) show("Me");
      return;
    }
    try {
      JSONArray spaces = new JSONArray(prefs().getString("spaces", "[]"));
      String current = prefs().getString("space", "local");
      String[] names = new String[spaces.length()];
      for (int i = 0; i < names.length; i++) {
        JSONObject s = spaces.getJSONObject(i);
        names[i] = (s.getString("id").equals(current) ? "✓  " : "") +
          (s.optString("kind").equals("personal") ? "Personal (only you)" : s.getString("name") + " · team");
      }
      if (names.length == 0) {
        show("Me");
        return;
      }
      new android.app.AlertDialog.Builder(this)
        .setTitle("New photos go to…")
        .setItems(names, (d, i) -> {
          try {
            JSONObject s = spaces.getJSONObject(i);
            prefs()
              .edit()
              .putString("space", s.getString("id"))
              .putString("space_name", s.getString("name"))
              .apply();
            lastCid = "";
            show(tab);
            refreshTemplate(false);
            message("New photos go to " + spaceLabel() + ". Earlier photos stay where they were.");
          } catch (Exception ignored) {}
        })
        .show();
    } catch (Exception e) {
      message(e.getMessage());
    }
  }

  private void recoverInterrupted() {
    for (JSONObject r : CaptureStore.all(this))
      if (
        r.optString("state").equals("awaiting_selfie") ||
        r.optString("state").equals("processing")
      ) try {
        if (r.optString("state").equals("awaiting_selfie")) r.put(
          "selfie_error",
          "Front capture interrupted; original preserved"
        );
        else if (!r.has("rendered")) r.put(
          "render_error",
          "Watermark copy interrupted; original preserved"
        );
        r.put("state", "pending");
        CaptureStore.atomic(
          new File(CaptureStore.directory(this), r.getString("id") + ".json"),
          r
        );
      } catch (Exception ignored) {}
  }

  private void video() {
    if (recording != null) {
      recording.stop();
      return;
    }
    if (videoCapture == null) return;
    if (!storageReady(CaptureStore.MIN_FREE_VIDEO)) return;
    String cid = UUID.randomUUID().toString(),
      timestamp = Instant.now().toString(),
      space = prefs().getString("space", "local"),
      user = prefs().getString("user", "local"),
      notes = noteText,
      address = currentAddress(),
      addressSource = addressSource();
    JSONObject gps = gpsAtCapture();
    File file = new File(CaptureStore.directory(this), cid + ".mp4");
    androidx.camera.video.FileOutputOptions options =
      new androidx.camera.video.FileOutputOptions.Builder(file)
        .setFileSizeLimit(20 * 1024 * 1024)
        .setDurationLimitMillis(30000)
        .build();
    recording = videoCapture
      .getOutput()
      .prepareRecording(this, options)
      .start(ContextCompat.getMainExecutor(this), event -> {
        if (event instanceof androidx.camera.video.VideoRecordEvent.Start) {
          styleShutter();
          status("● Recording · max 30 s · no sound", Ui.RED, false);
        }
        if (event instanceof androidx.camera.video.VideoRecordEvent.Finalize) {
          recording = null;
          styleShutter();
          androidx.camera.video.VideoRecordEvent.Finalize done =
            (androidx.camera.video.VideoRecordEvent.Finalize) event;
          if (
            done.hasError() &&
            done.getError() !=
              androidx.camera.video.VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED &&
            done.getError() !=
              androidx.camera.video.VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED
          ) {
            status("Video NOT saved", Ui.RED, false);
            message("Video could not be saved");
            return;
          }
          captureIo.execute(() -> {
            try {
              JSONObject r = CaptureStore.save(
                this,
                file,
                cid,
                space,
                user,
                timestamp,
                gps,
                notes,
                new JSONObject()
                  .put("address", address)
                  .put("address_source", addressSource)
              );
              r.put("kind", "video").put("state", "pending");
              CaptureStore.atomic(
                new File(CaptureStore.directory(this), cid + ".json"),
                r
              );
              runOnUiThread(() -> {
                lastCid = cid;
                if (thumb != null) thumb.setImageDrawable(null);
                paintThumbDot(r);
                status("Video saved ✓", Ui.GREEN, true);
                SyncWorker.enqueue(this);
              });
            } catch (Exception e) {
              runOnUiThread(() -> {
                status("Video NOT saved", Ui.RED, false);
                if (CaptureStore.isNoSpace(e)) message(
                  "Storage full: no space left on device. Free space and retry. Video not confirmed saved."
                );
                else message("Video save failed: " + e.getMessage());
              });
            }
          });
        }
      });
  }

  private void captureSelfie(JSONObject record, JSONObject template) {
    if (provider == null || !tab.equals("Camera")) {
      finishSelfie(record, null, template, "Front capture interrupted");
      return;
    }
    try {
      taking = true;
      status("Front photo…", 0xCC000000, false);
      provider.unbindAll();
      ImageCapture front = new ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .build();
      Preview p = new Preview.Builder().build();
      p.setSurfaceProvider(cameraPreview.getSurfaceProvider());
      provider.bindToLifecycle(
        this,
        CameraSelector.DEFAULT_FRONT_CAMERA,
        p,
        front
      );
      new Handler(Looper.getMainLooper()).postDelayed(() -> {
        File selfie = new File(
          CaptureStore.directory(this),
          record.optString("id") + "-selfie.jpg"
        );
        front.takePicture(
          new ImageCapture.OutputFileOptions.Builder(selfie).build(),
          captureIo,
          new ImageCapture.OnImageSavedCallback() {
            public void onImageSaved(ImageCapture.OutputFileResults result) {
              finishSelfie(record, selfie, template, null);
            }

            public void onError(ImageCaptureException e) {
              finishSelfie(record, null, template, e.getMessage());
            }
          }
        );
      }, 700);
    } catch (Exception e) {
      finishSelfie(record, null, template, e.getMessage());
    }
  }

  private void finishSelfie(
    JSONObject record,
    File selfie,
    JSONObject template,
    String error
  ) {
    captureIo.execute(() -> {
      try {
        if (selfie != null) {
          CaptureStore.syncFile(selfie);
          String timestamp = Instant.now().toString();
          record
            .put("selfie_file", selfie.getName())
            .put("selfie_sha256", CaptureStore.digest(selfie))
            .put("selfie_captured_at", timestamp)
            .put(
              "camera_time_delta_ms",
              java.time.Duration.between(
                Instant.parse(record.getString("captured_at_device")),
                Instant.parse(timestamp)
              ).toMillis()
            );
        } else record.put("selfie_error", error);
        // The shareable copy is optional: its failure never hides the originals.
        try {
          record.put(
            "rendered",
            Watermark.render(
              this,
              new File(CaptureStore.directory(this), record.getString("file")),
              template,
              record
            )
          );
        } catch (Exception renderError) {
          record.put("render_error", String.valueOf(renderError.getMessage()));
        }
        record.put("state", "pending");
        CaptureStore.atomic(
          new File(
            CaptureStore.directory(this),
            record.getString("id") + ".json"
          ),
          record
        );
        runOnUiThread(() -> {
          taking = false;
          if (tab.equals("Camera")) show("Camera");
          message(
            selfie == null
              ? "Original saved; front photo failed. Check the record."
              : "Both photos saved ✓"
          );
          SyncWorker.enqueue(this);
        });
      } catch (Exception e) {
        runOnUiThread(() -> {
          taking = false;
          message("Original kept; metadata save failed: " + e.getMessage());
        });
      }
    });
  }

  private void updateOverlay() {
    if (overlay == null) return;
    try {
      String address = currentAddress();
      JSONObject r = new JSONObject()
        .put("captured_at_device", Instant.now().toString())
        .put("gps", lastGps == null ? JSONObject.NULL : lastGps)
        .put("address", address);
      String space = prefs().getString("space", "local");
      JSONObject t = Watermark.selected(this, space);
      overlay.setText(Watermark.lines(this, t, r));
      if (templateChip != null) templateChip.setText("▦  " + t.optString("name", "Watermark") + "  ▾");
      if (addressPill != null) {
        boolean chosen = addressChoice() != null;
        addressPill.setText(
          (chosen ? "📌  " : "📍  ") +
          (address.isEmpty()
            ? (lastGps == null ? "No location · tap to type address" : "Finding address… · tap to choose")
            : address) +
          "   ✎"
        );
        addressPill.setContentDescription("Address: " + (address.isEmpty() ? "none" : address) + ". Tap to change.");
      }
      if (gpsChip != null && gpsDot != null) {
        long ageMs = lastGpsNanos == 0 ? 0 : Math.max(0, SystemClock.elapsedRealtimeNanos() - lastGpsNanos) / 1000000;
        Double acc = lastGps == null ? null : lastGps.optDouble("accuracy");
        FieldRules.GpsQuality q = FieldRules.gpsQuality(acc, ageMs);
        gpsDot.setBackground(Ui.dot(Ui.gpsColor(q)));
        String label;
        if (q == FieldRules.GpsQuality.NONE) label = "No GPS";
        else if (ageMs > STALE_GPS_MS) label = "GPS old";
        else label = "±" + Math.round(acc) + " m";
        gpsChip.setText(label);
        gpsChip.setContentDescription("GPS quality " + q.name().toLowerCase(Locale.US) + ", " + label + ". Tap to refresh.");
      }
      String pos = t.optString("position", "bottom-left");
      FrameLayout.LayoutParams p =
        (FrameLayout.LayoutParams) overlay.getLayoutParams();
      if (p != null) {
        p.gravity =
          (pos.startsWith("top") ? Gravity.TOP : Gravity.BOTTOM) |
          (pos.endsWith("right") ? Gravity.END : Gravity.START);
        overlay.setLayoutParams(p);
      }
    } catch (Exception ignored) {}
  }

  private void editWatermark() {
    String space = prefs().getString("space", "local");
    JSONObject current = Watermark.selected(this, space);
    // Edits always produce the person's own template; team locks still apply.
    JSONObject t = myTemplate(space);
    try {
      t = FieldRules.withTeamLocks(t, FieldRules.defaultTemplate(teamTemplates(space)));
      if (!current.optBoolean("local")) t = FieldRules.withTeamLocks(t, current);
    } catch (Exception ignored) {}
    JSONObject edit = t;
    boolean[] checked = new boolean[Watermark.FIELDS.length];
    List<String> on = Watermark.effectiveFields(edit);
    for (int i = 0; i < checked.length; i++) checked[i] = on.contains(Watermark.FIELDS[i]);
    new android.app.AlertDialog.Builder(this)
      .setTitle("My watermark fields")
      .setMultiChoiceItems(
        Watermark.FIELDS,
        checked,
        (dialog, which, isChecked) -> {
          if (Watermark.isLocked(edit, Watermark.FIELDS[which])) {
            ((android.app.AlertDialog) dialog)
              .getListView()
              .setItemChecked(which, true);
            checked[which] = true;
            message("Required by your team");
          } else checked[which] = isChecked;
        }
      )
      .setPositiveButton("Save", (dialog, which) -> {
        try {
          JSONArray fields = new JSONArray();
          for (int i = 0; i < checked.length; i++) if (checked[i]) fields.put(
            Watermark.FIELDS[i]
          );
          edit.put("fields", fields);
          edit.put("name", "My watermark");
          edit.put("local", true);
          edit.remove("id");
          edit.remove("is_default");
          edit.put("version", edit.optInt("version", 1) + 1);
          getSharedPreferences("my_templates", 0).edit().putString(space, edit.toString()).apply();
          prefsTemplate(space, edit);
          updateOverlay();
        } catch (Exception e) {
          message(e.getMessage());
        }
      })
      .setNegativeButton("Cancel", null)
      .show();
  }

  private void prefsTemplate(String space, JSONObject t) {
    getSharedPreferences("templates", 0)
      .edit()
      .putString(space, t.toString())
      .apply();
  }

  private void refreshTemplate(boolean announce) {
    String space = prefs().getString("space", "local");
    if (space.equals("local")) return;
    io.execute(() -> {
      try {
        JSONObject response = Api.request(
          this,
          "/api/spaces/" + space + "/templates",
          "GET",
          null
        );
        JSONArray rows = response.getJSONArray("items");
        getSharedPreferences("template_lists", 0).edit().putString(space, rows.toString()).apply();
        JSONObject current = getSharedPreferences("templates", 0).getString(space, "").isEmpty()
          ? null
          : Watermark.selected(this, space);
        JSONObject pick = FieldRules.afterRefresh(current, rows);
        if (pick != null) prefsTemplate(space, pick);
        boolean updated = FieldRules.defaultTemplate(rows) != null;
        runOnUiThread(() -> {
          updateOverlay();
          if (announce) message(
            updated
              ? "Team templates updated"
              : "This space has no team template yet"
          );
        });
      } catch (Exception e) {
        if (announce) runOnUiThread(() -> message(e.getMessage()));
      }
    });
  }

  private void voiceNote() {
    if (audioRecorder != null) {
      try {
        try {
          audioRecorder.stop();
        } finally {
          // stop() throws when almost nothing was recorded; the recorder and
          // the microphone must still be released.
          audioRecorder.release();
          audioRecorder = null;
        }
        CaptureStore.syncFile(audioFile);
        pendingAudioHash = CaptureStore.digest(audioFile);
        pendingAudio = audioFile.getName();
        if (voicePill != null) voicePill.setText("🎙  Voice ✓");
        message("Voice note saved. It attaches to your next photo.");
      } catch (Exception e) {
        if (voicePill != null) voicePill.setText("🎙  Voice note");
        message("Voice note too short or not saved; record again.");
      }
      return;
    }
    if (
      checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, 12);
      return;
    }
    try {
      audioFile = new File(
        CaptureStore.directory(this),
        UUID.randomUUID() + ".m4a"
      );
      audioRecorder = new android.media.MediaRecorder();
      audioRecorder.setAudioSource(android.media.MediaRecorder.AudioSource.MIC);
      audioRecorder.setOutputFormat(
        android.media.MediaRecorder.OutputFormat.MPEG_4
      );
      audioRecorder.setAudioEncoder(
        android.media.MediaRecorder.AudioEncoder.AAC
      );
      audioRecorder.setMaxDuration(60000);
      audioRecorder.setOutputFile(audioFile.getPath());
      audioRecorder.prepare();
      audioRecorder.start();
      audioRecorder.setOnInfoListener((m, what, extra) -> {
        if (
          what ==
          android.media.MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED
        ) voiceNote();
      });
      if (voicePill != null) voicePill.setText("■  Stop voice");
      message("Recording voice note · tap Stop when done (60 s max)");
    } catch (Exception e) {
      message("Microphone unavailable: " + e.getMessage());
      if (audioRecorder != null) {
        audioRecorder.release();
        audioRecorder = null;
      }
    }
  }

  private void shareLocal(JSONObject record) {
    try {
      JSONObject rendered = record.optJSONObject("rendered");
      String name =
        rendered != null
          ? rendered.getString("file")
          : record.getString("file");
      File file = new File(CaptureStore.directory(this), name);
      android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
        this,
        getPackageName() + ".files",
        file
      );
      Intent intent = new Intent(Intent.ACTION_SEND);
      intent.setType(name.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
      intent.putExtra(Intent.EXTRA_STREAM, uri);
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      startActivity(Intent.createChooser(intent, "Share a copy"));
    } catch (Exception e) {
      message("Cannot share this file: " + e.getMessage());
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    overlayHandler.removeCallbacks(overlayTick);
    overlayHandler.post(overlayTick);
    // Returning from system Settings after granting the camera.
    if (
      cameraWaitingForPermission &&
      tab.equals("Camera") &&
      checkSelfPermission(Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED
    ) show("Camera");
  }

  @Override
  protected void onPause() {
    overlayHandler.removeCallbacks(overlayTick);
    super.onPause();
  }

  @Override
  protected void onStop() {
    super.onStop();
    if (recording != null) recording.stop();
    if (audioRecorder != null) voiceNote();
  }

  private void message(String msg) {
    Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
  }

  @Override
  public void onRequestPermissionsResult(
    int code,
    String[] permissions,
    int[] results
  ) {
    super.onRequestPermissionsResult(code, permissions, results);
    if (code == 10) {
      if (
        results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
      ) prefs().edit().remove("camera_denied_before").apply();
      else prefs().edit().putBoolean("camera_denied_before", true).apply();
      show("Camera");
    }
    else if (code == 11) {
      boolean any = false;
      for (int r : results) any |= r == PackageManager.PERMISSION_GRANTED;
      if (any) locate();
      else message("Location not allowed. Photos still save, without GPS.");
    } else if (code == 12) {
      if (
        results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
      ) message("Microphone allowed. Tap Voice note to record.");
      else message("Microphone not allowed. Photos still save without voice notes.");
    }
  }

  @Override
  protected void onDestroy() {
    super.onDestroy();
    if (detailDialog != null && detailDialog.isShowing()) detailDialog.dismiss();
    if (recording != null) {
      recording.stop();
      recording = null;
    }
    if (audioRecorder != null) {
      audioRecorder.release();
      audioRecorder = null;
    }
    io.shutdown();
    net.shutdown();
    renderer.shutdown();
    captureIo.shutdown();
  }
}
