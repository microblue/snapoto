# Android 运行验收（2026-11-02）

环境：Android 16，AVD `OkText_A16`，应用 `com.snapoto.app.debug`。通过 `heavy` 启停；本次测试结束已停止模拟器。使用独立 QA 账号和模拟相机图案，没有真实客户照片或消息。

通过项目：

1. 首次相机权限授权后预览正常；拍照保存原图及独立水印图。
2. 登录前照片强制结束应用后仍保留；登录、授权云同步后该照片仍仅在本机，没有被自动归属或上传。
3. 登录后照片经 WorkManager 同步；本地文件 SHA-256 与服务端原图一致。
4. 关闭 Wi-Fi 和移动数据后拍照，状态 pending 且云端无记录；强制停止并重启应用，文件与队列仍在；恢复网络后变为 synced，哈希相同。前后证据：`android-offline-before-restart.json`、`android-offline-after-restart.json`、`android-online-restored.json`。
5. 视频录制约 8.99 秒、1280×720、244430 字节，无音频轨，已同步且哈希一致，媒体检查见 `android-video.json`。
6. 初始无前摄配置时拒绝启用双摄。随后用 `heavy start emu OkText_A16 --minutes 20 -- -camera-front emulated -no-snapshot-load` 临时启用前摄，未修改共享 AVD 配置；勾选后顺序拍摄两张原图，实际间隔 1282ms，自拍原图哈希与云端一致，独立画中画检查通过。见 `android-dual.json`、`android-dual-render.jpg`。
7. AndroidRuntime 日志没有崩溃记录。

本次发现并修复：

- 预览时钟原先只在打开相机时更新；改为前台每秒刷新，后台暂停回调。复测两次 UI dump 时间由 15:07:48 推进至 15:07:59。
- 视频固定选择 SD 导致不支持该档位的相机初始化失败；增加设备支持档位回退。重新安装后录制、保存、同步通过。
- 修复后的 APK 已重新构建、运行 3 项持久化单测及 lint，并复制到 `dist/snapoto-debug.apk`。

边界：以上是模拟器运行证据，不能替代物理摄像头、真实定位、低存储、30 秒自动停止边界、长期续航、厂商后台限制、前后摄中断恢复和真实试点验收。当前视频没有烧录水印。
