# Build And Submit

These commands should be run after the Apple Developer Program account is active and App Store Connect has an app record for `com.xipanxiao.sutrareader`.

## 1. Install / Use EAS

Prefer `npx` so a global install is not required:

```bash
cd /Users/xipanxiao/Source/sutrareader
npx eas login
```

## 2. Verify Project

```bash
npm run typecheck
npm run export:web
npx expo config --type public
```

## 3. Build iOS App Store Binary

```bash
npx eas build --platform ios --profile production
```

During the first build, EAS will ask for Apple credentials and can create/manage signing certificates and provisioning profiles.

## 4. Submit To App Store Connect

After the production build finishes:

```bash
npx eas submit --platform ios --profile production --latest
```

Alternatively, download the `.ipa` from EAS and upload it manually using Transporter.

## 5. Optional Auto Submit

Once the App Store Connect app id is known, you can add `ascAppId` to `eas.json` under `submit.production.ios`. Then future builds can use:

```bash
npx eas build --platform ios --profile production --auto-submit
```

## Notes

- The binary cannot be fully prepared for App Store upload before the Apple Developer account/signing setup exists.
- Keep `app.json` bundle identifier as `com.xipanxiao.sutrareader` unless you create a different Bundle ID in Apple Developer.
- If App Store Connect asks for a privacy policy URL, use the public GitHub URL for `PRIVACY.md`.
