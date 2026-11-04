# Snapoto

Follow /home/dz/AGENTS.md and the user's session instructions. Work on main; do not commit unless explicitly requested.

The product authority is docs/Snapoto_PRD_V2.0.docx. Read docs/ACCEPTANCE.md before reporting completion: configured adapters and a successful APK build are not evidence of live integration or physical-camera acceptance.

Keep original assets immutable. Never mark a photo saved before persistent local storage completes. Space ownership is fixed at capture; do not migrate Personal photos into Team implicitly. Always enforce server-side membership and roles.

AI output is untrusted proposed data. Never overwrite a confirmed order number with OCR, infer a recipient, send on ambiguous lookup, or automatically retry an uncertain outbound result. Freeze approved rule/template versions. Do not send real test messages without explicit authorization.

Run npm test and npm run check for backend/web changes. For Android changes run ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug under android/. Android emulator use must go through heavy and respect other sessions' ComfyUI ownership.

No Python dependencies are needed. Do not create Python environments. Keep data/, .env, SDK paths, APK outputs and credentials out of Git.
