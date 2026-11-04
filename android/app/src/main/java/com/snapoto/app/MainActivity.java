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

  private LinearLayout root, body;
  private TextView state;
  private ImageCapture capture;
  private ProcessCameraProvider provider;
  private final ExecutorService io = Executors.newSingleThreadExecutor();
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
  /** Location fixes older than this are flagged as stale in the UI. */
  private static final long STALE_GPS_MS = 2 * 60 * 1000;
  private boolean cameraWaitingForPermission = false;
  private String tab = "Camera";
  private EditText note;
  private JSONObject lastGps;
  private long lastGpsNanos = 0;
  private TextView locationState;
  private String lastAddress = "";
  private boolean taking = false;
  private boolean videoMode = false;
  private androidx.camera.video.VideoCapture<androidx.camera.video.Recorder> videoCapture;
  private androidx.camera.video.Recording recording;
  private PreviewView cameraPreview;
  private TextView overlay;
  private final Handler overlayHandler = new Handler(Looper.getMainLooper());
  private final Runnable overlayTick = new Runnable() {
    @Override
    public void run() {
      if (tab.equals("Camera")) updateOverlay();
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

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    if (recovered.compareAndSet(false, true)) recoverInterrupted();
    show("Camera");
    // New members pick up the team's published template without opening Me.
    if (!prefs().getString("token", "").isEmpty()) refreshTemplate(false);
    if (
      checkSelfPermission(Manifest.permission.CAMERA) !=
      PackageManager.PERMISSION_GRANTED
    ) requestPermissions(new String[] { Manifest.permission.CAMERA }, 10);
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private TextView text(String value, int size) {
    TextView v = new TextView(this);
    v.setText(value);
    v.setTextSize(size);
    v.setTextColor(Color.rgb(25, 48, 75));
    v.setPadding(8, 12, 8, 12);
    return v;
  }

  private Button button(String value, Runnable action) {
    Button b = new Button(this);
    b.setText(value);
    b.setAllCaps(false);
    b.setOnClickListener(v -> action.run());
    return b;
  }

  private void show(String page) {
    tab = page;
    if (provider != null) provider.unbindAll();
    capture = null;
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(20, 40, 20, 20);
    root.setBackgroundColor(Color.rgb(243, 246, 250));
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      root.setPadding(
        dp(16),
        insets.getSystemWindowInsetTop() + dp(8),
        dp(16),
        insets.getSystemWindowInsetBottom() + dp(8)
      );
      return insets;
    });
    setContentView(root);
    TextView title = text(
      "snapoto   /   " + prefs().getString("space_name", "On this device"),
      23
    );
    root.addView(title);
    title.setOnClickListener(v -> chooseSpace());
    body = new LinearLayout(this);
    body.setOrientation(LinearLayout.VERTICAL);
    root.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));
    LinearLayout nav = new LinearLayout(this);
    for (String t : new String[] { "Camera", "Photos", "Me" })
      nav.addView(
        button(t, () -> {
          if (recording != null) {
            message("Stop the video recording first");
            return;
          }
          show(t);
        }),
        new LinearLayout.LayoutParams(0, dp(58), 1)
      );
    root.addView(nav);
    if (page.equals("Camera")) camera();
    else if (page.equals("Photos")) photos();
    else account();
  }

  private void camera() {
    PreviewView preview = new PreviewView(this);
    cameraPreview = preview;
    FrameLayout frame = new FrameLayout(this);
    frame.addView(preview, new FrameLayout.LayoutParams(-1, -1));
    overlay = text("", 15);
    overlay.setTextColor(Color.WHITE);
    overlay.setBackgroundColor(0x99000000);
    FrameLayout.LayoutParams overlayParams = new FrameLayout.LayoutParams(
      -2,
      -2,
      Gravity.BOTTOM | Gravity.LEFT
    );
    frame.addView(overlay, overlayParams);
    body.addView(frame, new LinearLayout.LayoutParams(-1, 0, 1));
    updateOverlay();
    state = text("Ready · originals stay on this device", 14);
    body.addView(state);
    note = new EditText(this);
    note.setHint("Optional photo note");
    note.setSingleLine();
    body.addView(note);
    LinearLayout options = new LinearLayout(this);
    options.addView(
      button("Location", () -> {
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
        else locate();
      })
    );
    options.addView(
      button("Retry sync", () -> {
        SyncWorker.enqueue(this, true);
        message(
          prefs().getBoolean("cloud", false)
            ? "Background sync queued"
            : "Background upload is off. Turn it on in Me."
        );
      })
    );
    body.addView(options);
    locationState = text("No GPS fix — photos save without location", 14);
    body.addView(locationState);
    LinearLayout tools = new LinearLayout(this);
    tools.addView(
      button(videoMode ? "Photo mode" : "Video mode", () -> {
        if (recording != null) {
          recording.stop();
          return;
        }
        videoMode = !videoMode;
        show("Camera");
      })
    );
    tools.addView(button("Watermark", this::editWatermark));
    tools.addView(button("Voice note", this::voiceNote));
    body.addView(tools);
    Button shutter = button(
      videoMode ? "●  Record / stop" : "●  Take photo",
      () -> {
        if (videoMode) video();
        else takePhoto();
      }
    );
    shutter.setTextSize(23);
    shutter.setTextColor(Color.WHITE);
    shutter.setBackgroundTintList(
      android.content.res.ColorStateList.valueOf(Color.rgb(35, 94, 219))
    );
    body.addView(shutter, new LinearLayout.LayoutParams(-1, dp(80)));
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
      if (
        cameraPermanentlyDenied() &&
        !prefs().getBoolean("camera_guide_shown", false)
      ) {
        body.addView(
          text(
            "Camera access is blocked. Photos stay on this device; enable the camera in Settings to take photos.",
            15
          )
        );
        body.addView(button("Open Settings", this::openAppSettings));
        prefs().edit().putBoolean("camera_guide_shown", true).apply();
        state.setText("Camera blocked. Open Settings to re-enable access.");
      } else if (cameraPermanentlyDenied()) {
        body.addView(button("Open Settings", this::openAppSettings));
        state.setText("Camera blocked. Open Settings to re-enable access.");
      } else state.setText(
        "Allow camera access to take photos. Tap Take photo to grant access."
      );
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
        state.setText("Camera unavailable: " + e.getMessage());
      }
    }, ContextCompat.getMainExecutor(this));
  }

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
          if (best == null && locationState != null) locationState.setText(
            "Getting location; you can still take photos."
          );
          android.os.CancellationSignal signal =
            new android.os.CancellationSignal();
          lm.getCurrentLocation(
            LocationManager.GPS_PROVIDER,
            signal,
            ContextCompat.getMainExecutor(this),
            location -> {
              if (location != null) applyLocation(location);
              else if (!quiet) message(
                "Location unavailable; capture can continue."
              );
            }
          );
          new Handler(Looper.getMainLooper()).postDelayed(
            signal::cancel,
            10000
          );
        } else if (best == null && !quiet) message(
          "No location fix yet. Enable device location and try again."
        );
      }
    } catch (Exception e) {
      if (!quiet) message("Location unavailable");
    }
  }

  private void applyLocation(Location best) {
    try {
      long age = Math.max(
        0,
        (SystemClock.elapsedRealtimeNanos() - best.getElapsedRealtimeNanos()) /
          1000000
      );
      lastGps = new JSONObject()
        .put("latitude", best.getLatitude())
        .put("longitude", best.getLongitude())
        .put("accuracy", best.getAccuracy())
        .put("age_ms", age);
      lastGpsNanos = best.getElapsedRealtimeNanos();
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
      // Only the location line changes: the status line may be showing
      // "Saving…/Saved" for a capture and must not be overwritten.
      updateOverlay();
    } catch (Exception e) {
      message("Location unavailable");
    }
  }

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
      notes = note.getText().toString(),
      address = lastAddress;
    JSONObject gps = gpsAtCapture();
    if (
      checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
    ) locate(true); // refreshes the fix for the next photo; never awaited
    String audio = pendingAudio, audioHash = pendingAudioHash;
    pendingAudio = "";
    pendingAudioHash = "";
    JSONObject watermark = Watermark.selected(this, space);
    boolean dual = prefs().getBoolean("dual", false);
    File output = new File(CaptureStore.directory(this), cid + ".jpg");
    state.setText("Saving original…");
    capture.takePicture(
      new ImageCapture.OutputFileOptions.Builder(output).build(),
      captureIo,
      new ImageCapture.OnImageSavedCallback() {
        public void onImageSaved(ImageCapture.OutputFileResults result) {
          JSONObject record;
          try {
            JSONObject extra = new JSONObject()
              .put("address", address)
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
              if (state != null) state.setText("Photo NOT saved");
              reportSaveFailure(e);
            });
            return;
          }
          runOnUiThread(() -> {
            if (state != null) state.setText(
              "Saved on device · " + localTime(timestamp, "HH:mm:ss")
            );
            if (dual) captureSelfie(record, watermark);
            else taking = false;
          });
          if (!dual) renderer.execute(() -> renderAndQueue(cid, watermark));
        }

        public void onError(ImageCaptureException e) {
          runOnUiThread(() -> {
            taking = false;
            if (state != null) state.setText("Photo NOT saved");
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

  private void photos() {
    List<JSONObject> records = new ArrayList<>();
    for (JSONObject r : CaptureStore.all(this))
      if (
        r.optString("space_id").equals(prefs().getString("space", "local")) &&
        r.optString("user_id").equals(prefs().getString("user", "local"))
      ) records.add(r);
    if (records.isEmpty()) {
      body.addView(
        text(
          "No photos in this space yet. Your first photo starts a record.",
          18
        )
      );
      return;
    }
    ListView list = new ListView(this);
    body.addView(list, new LinearLayout.LayoutParams(-1, 0, 1));
    list.setAdapter(
      new BaseAdapter() {
        public int getCount() {
          return records.size();
        }

        public Object getItem(int position) {
          return records.get(position);
        }

        public long getItemId(int position) {
          return position;
        }

        public View getView(
          int position,
          View old,
          android.view.ViewGroup parent
        ) {
          JSONObject r = records.get(position);
          LinearLayout row;
          if (old instanceof LinearLayout) row = (LinearLayout) old;
          else {
            row = new LinearLayout(MainActivity.this);
            row.setOrientation(LinearLayout.VERTICAL);
            ImageView image = new ImageView(MainActivity.this);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            row.addView(image, new LinearLayout.LayoutParams(-1, dp(220)));
            row.addView(text("", 14));
          }
          ImageView image = (ImageView) row.getChildAt(0);
          image.setImageDrawable(null);
          image.setTag(r.optString("id"));
          TextView label = (TextView) row.getChildAt(1);
          label.setText(
            localTime(r.optString("captured_at_device"), "yyyy-MM-dd HH:mm:ss") +
              "\n" +
              SyncPolicy.label(r, prefs().getBoolean("cloud", false)) +
              (r.has("render_error")
                ? "\nWatermark copy failed; original is safe"
                : "")
          );
          io.execute(() -> {
            JSONObject rendered = r.optJSONObject("rendered");
            String filename =
              rendered == null
                ? r.optString("file")
                : rendered.optString("file");
            Bitmap thumbnail = Watermark.thumbnail(
              new File(
                CaptureStore.directory(MainActivity.this),
                filename
              ).getPath(),
              600
            );
            runOnUiThread(() -> {
              if (
                r.optString("id").equals(image.getTag())
              ) image.setImageBitmap(thumbnail);
              else if (thumbnail != null) thumbnail.recycle();
            });
          });
          row.setOnClickListener(v ->
            new android.app.AlertDialog.Builder(MainActivity.this)
              .setTitle("Original record")
              .setMessage(
                "SHA-256\n" +
                  r.optString("sha256") +
                  "\n\n" +
                  r.optString("note") +
                  "\nDevice time: " +
                  r.optString("captured_at_device")
              )
              .setNeutralButton("Share copy", (d, w) -> shareLocal(r))
              .setPositiveButton("Done", null)
              .show()
          );
          return row;
        }
      }
    );
    body.addView(
      button("Retry pending uploads", () -> {
        SyncWorker.enqueue(this, true);
        message("Retrying uploads in the background");
      })
    );
  }

  private EditText field(
    LinearLayout box,
    String hint,
    String value,
    boolean secret
  ) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setText(value);
    e.setSingleLine();
    if (secret) e.setInputType(129);
    box.addView(e);
    return e;
  }

  private boolean validBase(String base) {
    if (!Api.allowedBase(base, Api.debuggable(this))) {
      message("Enter a valid HTTPS server URL");
      return false;
    }
    return true;
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
    prefs()
      .edit()
      .putString("user", me.getString("id"))
      .putString("spaces", spaces.toString())
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

  private void account() {
    ScrollView scroll = new ScrollView(this);
    LinearLayout form = new LinearLayout(this);
    form.setOrientation(LinearLayout.VERTICAL);
    scroll.addView(form);
    body.addView(scroll);
    form.addView(text("Your account & sync", 24));
    String signedInAs = prefs().getString("email", "");
    form.addView(
      text(
        (prefs().getString("token", "").isEmpty()
            ? "Not signed in · photos stay on this device"
            : "Signed in as " + signedInAs + " · space: " + prefs().getString("space_name", "")) +
          "\n" +
          SyncPolicy.summary(CaptureStore.all(this)),
        15
      )
    );
    form.addView(
      text(
        "Capture offline without an account. Local-only photos stay local; signing in never transfers them to a team automatically.",
        15
      )
    );
    EditText server = field(
      form,
      "Server URL (https://…)",
      prefs().getString("server", ""),
      false
    );
    EditText name = field(
      form,
      "Name (new accounts only)",
      "",
      false
    );
    EditText email = field(
      form,
      "Email",
      prefs().getString("email", ""),
      false
    );
    EditText password = field(form, "Password (12+ characters)", "", true);
    form.addView(
      button("Sign in", () -> {
        String base = server.getText().toString().replaceAll("/+$", "");
        String mail = email.getText().toString(),
          pass = password.getText().toString();
        if (!validBase(base)) return;
        prefs().edit().putString("server", base).apply();
        io.execute(() -> {
          try {
            JSONObject login = Api.request(
              this,
              "/api/auth/login",
              "POST",
              new JSONObject().put("email", mail).put("password", pass)
            );
            finishSignIn(base, mail, login.getString("token"));
          } catch (Exception e) {
            runOnUiThread(() -> message(e.getMessage()));
          }
        });
      })
    );
    form.addView(
      button("Create account", () -> {
        String base = server.getText().toString().replaceAll("/+$", "");
        String who = name.getText().toString().trim(),
          mail = email.getText().toString(),
          pass = password.getText().toString();
        if (!validBase(base)) return;
        if (who.isEmpty()) {
          message("Enter your name to create an account");
          return;
        }
        if (pass.length() < 12) {
          message("Password needs at least 12 characters");
          return;
        }
        prefs().edit().putString("server", base).apply();
        io.execute(() -> {
          try {
            JSONObject reg = Api.request(
              this,
              "/api/auth/register",
              "POST",
              new JSONObject()
                .put("name", who)
                .put("email", mail)
                .put("password", pass)
            );
            finishSignIn(base, mail, reg.getString("token"));
          } catch (Exception e) {
            runOnUiThread(() -> message(e.getMessage()));
          }
        });
      })
    );
    CheckBox cloud = new CheckBox(this);
    cloud.setText("Allow background upload of my work photos");
    cloud.setChecked(prefs().getBoolean("cloud", false));
    cloud.setOnCheckedChangeListener((b, checked) -> {
      prefs().edit().putBoolean("cloud", checked).apply();
      if (checked) SyncWorker.enqueue(this);
    });
    form.addView(cloud);
    CheckBox dual = new CheckBox(this);
    dual.setText(
      "Include a front-camera photo (optional, not identity verification)"
    );
    dual.setChecked(prefs().getBoolean("dual", false));
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
    form.addView(dual);
    form.addView(
      text(
        "The space owner must also enable cloud storage. Originals stay local after upload. Deleting the app deletes local files.",
        14
      )
    );
    form.addView(button("Choose space", this::chooseSpace));
    form.addView(
      button("Open management website", () -> {
        String url = prefs().getString("server", "");
        if (!url.isEmpty()) startActivity(
          new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))
        );
      })
    );
    form.addView(
      button("Sign out", () -> {
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
      })
    );
  }

  private void chooseSpace() {
    try {
      JSONArray spaces = new JSONArray(prefs().getString("spaces", "[]"));
      String[] names = new String[spaces.length()];
      for (int i = 0; i < names.length; i++) names[i] = spaces
        .getJSONObject(i)
        .getString("name");
      if (names.length == 0) {
        show("Me");
        return;
      }
      new android.app.AlertDialog.Builder(this)
        .setTitle("Photos belong to this space at capture")
        .setItems(names, (d, i) -> {
          try {
            JSONObject s = spaces.getJSONObject(i);
            prefs()
              .edit()
              .putString("space", s.getString("id"))
              .putString("space_name", s.getString("name"))
              .apply();
            show(tab);
            refreshTemplate(true);
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
      notes = note.getText().toString();
    JSONObject gps = lastGps;
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
        if (
          event instanceof androidx.camera.video.VideoRecordEvent.Start
        ) state.setText(
          "Recording video · 30 seconds / 20 MB maximum · no audio"
        );
        if (event instanceof androidx.camera.video.VideoRecordEvent.Finalize) {
          recording = null;
          androidx.camera.video.VideoRecordEvent.Finalize done =
            (androidx.camera.video.VideoRecordEvent.Finalize) event;
          if (
            done.hasError() &&
            done.getError() !=
              androidx.camera.video.VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED &&
            done.getError() !=
              androidx.camera.video.VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED
          ) {
            if (state != null) state.setText("Video NOT saved");
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
                notes
              );
              r.put("kind", "video").put("state", "pending");
              CaptureStore.atomic(
                new File(CaptureStore.directory(this), cid + ".json"),
                r
              );
              runOnUiThread(() -> {
                state.setText("Video saved on device");
                SyncWorker.enqueue(this);
              });
            } catch (Exception e) {
              runOnUiThread(() -> {
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
      state.setText("Taking optional front photo…");
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
              : "Both originals saved; capture time difference recorded."
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
      JSONObject r = new JSONObject()
        .put("captured_at_device", Instant.now().toString())
        .put("gps", lastGps == null ? JSONObject.NULL : lastGps)
        .put("address", lastAddress);
      JSONObject t = Watermark.selected(
        this,
        prefs().getString("space", "local")
      );
      overlay.setText(Watermark.lines(this, t, r));
      if (locationState != null) {
        if (lastGps == null || lastGpsNanos == 0) locationState.setText(
          "No GPS fix — photos save without location"
        );
        else {
          long ageSec =
            Math.max(
              0,
              SystemClock.elapsedRealtimeNanos() - lastGpsNanos
            ) /
            1000000000;
          locationState.setText(
            "GPS ±" +
              lastGps.optInt("accuracy", 0) +
              " m · " +
              (ageSec < 120 ? ageSec + " s old" : (ageSec / 60) + " min old") +
              (ageSec * 1000 > STALE_GPS_MS ? " · STALE, tap Location" : "")
          );
        }
      }
      String pos = t.optString("position", "bottom-left");
      FrameLayout.LayoutParams p =
        (FrameLayout.LayoutParams) overlay.getLayoutParams();
      if (p != null) {
        p.gravity =
          (pos.startsWith("top") ? Gravity.TOP : Gravity.BOTTOM) |
          (pos.endsWith("right") ? Gravity.RIGHT : Gravity.LEFT);
        overlay.setLayoutParams(p);
      }
    } catch (Exception ignored) {}
  }

  private void editWatermark() {
    String space = prefs().getString("space", "local");
    JSONObject t = Watermark.selected(this, space);
    boolean[] checked = new boolean[Watermark.FIELDS.length];
    String selected = t.optJSONArray("fields") == null
      ? ""
      : t.optJSONArray("fields").toString();
    for (int i = 0; i < checked.length; i++) checked[i] =
      selected.contains("\"" + Watermark.FIELDS[i] + "\"") ||
      Watermark.isLocked(t, Watermark.FIELDS[i]);
    new android.app.AlertDialog.Builder(this)
      .setTitle("Watermark fields")
      .setMultiChoiceItems(
        Watermark.FIELDS,
        checked,
        (dialog, which, isChecked) -> {
          if (Watermark.isLocked(t, Watermark.FIELDS[which])) {
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
          t.put("fields", fields);
          t.put("version", t.optInt("version", 1) + 1);
          prefsTemplate(space, t);
          updateOverlay();
        } catch (Exception e) {
          message(e.getMessage());
        }
      })
      .setNeutralButton("Get team default", (d, w) -> refreshTemplate(true))
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
        boolean found = false;
        for (int i = 0; i < rows.length(); i++) {
          JSONObject t = rows.getJSONObject(i);
          if (t.optBoolean("is_default")) {
            prefsTemplate(space, t);
            found = true;
            break;
          }
        }
        boolean updated = found;
        runOnUiThread(() -> {
          updateOverlay();
          if (announce) message(
            updated
              ? "Team template updated"
              : "This space has no default template yet"
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
        message("Audio saved. It will attach to your next photo.");
        message(
          "You can add editable text in the photo note field. Transcription is available after cloud sync."
        );
      } catch (Exception e) {
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
      message("Recording. Tap Voice note again to stop (60 seconds max).");
    } catch (Exception e) {
      message("Microphone unavailable: " + e.getMessage());
      if (audioRecorder != null) {
        audioRecorder.release();
        audioRecorder = null;
      }
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 30 && result == RESULT_OK && data != null) {
      ArrayList<String> words = data.getStringArrayListExtra(
        android.speech.RecognizerIntent.EXTRA_RESULTS
      );
      if (words != null && !words.isEmpty() && note != null) note.setText(
        words.get(0)
      );
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
    if (recording != null) {
      recording.stop();
      recording = null;
    }
    if (audioRecorder != null) {
      audioRecorder.release();
      audioRecorder = null;
    }
    io.shutdown();
    renderer.shutdown();
    captureIo.shutdown();
  }
}
