# App Store Submission Checklist

This checklist is for the first App Store / TestFlight submission of `阅藏`.

## Already Prepared In This Repo

- Expo app config: `app.json`
- iOS bundle identifier: `com.xipanxiao.sutrareader`
- iOS build number: `1`
- App icon: `assets/icon.png`
- Splash image: `assets/splash.png`
- EAS build config: `eas.json`
- App Store metadata draft: `store/metadata.md`
- Privacy policy: `PRIVACY.md`

## Required After Apple Developer Account Is Active

1. Create an App Store Connect app record.
   - Name: `阅藏`
   - Bundle ID: `com.xipanxiao.sutrareader`
   - SKU: `sutrareader`
   - Primary language: Chinese Simplified or English, depending on the storefront metadata you prefer.

2. Confirm App Store metadata.
   - Copy fields from `store/metadata.md`.
   - Use category `Books`, optional secondary category `Reference`.
   - Use privacy policy URL: `https://github.com/XipanXiao/sutrareader/blob/main/PRIVACY.md`

3. Fill privacy answers.
   - This build should be `Data Not Collected`.
   - No tracking.
   - No account creation.
   - No analytics.
   - No advertising.

4. Answer encryption/export compliance.
   - The app config declares `usesNonExemptEncryption: false`.
   - The expected answer is that the app does not use non-exempt encryption.

5. Upload screenshots.
   - Required iPhone screenshot sizes are easiest to satisfy from App Store Connect by uploading current accepted device screenshots.
   - Capture screens for: home/progress, library search, reader, bookmarks/progress.
   - Put final screenshots in `store/screenshots/`.

6. Build and upload the binary.
   - See `store/build-and-submit.md`.

7. App Review notes.
   - Use the review notes from `store/metadata.md`.

## Important Review Risk

The app is mainly a reader for CBETA Buddhist texts. Keep the app free unless CBETA licensing and any required permissions are reviewed. The in-app text attribution should remain visible.
