# Sutra Reader

Mobile sutra reader prototype focused on precise reading progress.

## Current MVP

- Expo React Native app, iOS-first with Android support.
- Searchable CBETA XML P5 catalog with 5,005 works.
- On-demand CBETA text download and offline cache.
- Simplified Chinese reader text converted at import time.
- Home progress map with full and partial dot states.
- Outline view for linear navigation.
- Reader with `Start`, `Mark Here`, and bookmark actions.
- Persisted read ranges and arbitrary reading positions using local storage.

## Run

```bash
npm install
npm run ios
```

Use `npm start` to choose another target from Expo.

## Verification

```bash
npm run typecheck
npm run export:web
```

If `npm run ios` says there are no simulator devices, install the iOS Simulator runtime from Xcode or run:

```bash
xcodebuild -downloadPlatform iOS
```

This project expects Expo SDK-compatible package versions. Run `npx expo install --fix` after dependency upgrades.

## Refresh CBETA Catalog

```bash
npm run generate:catalog
```

The app stores a generated catalog in `src/data/cbetaCatalog.ts`. Full sutra XML files are downloaded from CBETA on demand and cached locally after a reader opens them.

## App Store Build Prep

The repo includes app icons, iOS bundle id, build number, EAS config, and draft App Store metadata.

```bash
npm install -g eas-cli
eas login
eas build --platform ios --profile production
eas submit --platform ios --profile production
```

Actual upload requires access to the Apple Developer account and App Store Connect app record for `com.xipanxiao.sutrareader`.
