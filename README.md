# Sutra Reader

Mobile sutra reader prototype focused on precise reading progress.

## Current MVP

- Expo React Native app, iOS-first with Android support.
- Simplified Chinese sample sutra content.
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
