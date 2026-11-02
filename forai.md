# Hostel Manager PWA — Project Memory and Rebuild Guide

This document records the project state verified in the workspace on 2026-10-30. Treat the checked-in source and configuration as authoritative; do not assume earlier proposed changes were successfully applied.

## Project overview

- **Web app:** React 18, TypeScript, Vite 6.
- **Offline/PWA:** `vite-plugin-pwa` with Workbox `generateSW`; IndexedDB is the local source of truth.
- **Cloud:** Optional Firebase Authentication (Google) and Cloud Firestore sync. The Firebase Web app configuration is client configuration, not a service-account credential.
- **Other:** Zustand, `idb`, Zod, React Hook Form, and Framer Motion.
- **Android companion:** Java/Gradle project under `app/`, package `com.hostelmanager`.
- **Firebase project:** `hostelmanager-79bab` (from `.firebaserc`).
- **Hosting:** Firebase Hosting serves `dist`; Firestore rules are in `firestore.rules`.

The app's web data must remain usable offline. Cloud sync is opt-in. Never put service-account JSON, private keys, or other server credentials in the client or this file.

## Verified fixes and important gotchas

### Google Auth and the Content Security Policy

Firebase/Google sign-in requires the relevant Google and Firebase origins to be permitted by the Hosting CSP. The current policy is configured in `firebase.json` as a Hosting response header. If auth is blocked, inspect the browser console and the deployed response headers before weakening the policy. Keep the policy restrictive and update only the required origins.

Current exact CSP value:

```text
default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' https://apis.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.firebaseio.com https://*.firebaseapp.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://accounts.google.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com; form-action 'self' https://accounts.google.com; worker-src 'self' blob:; frame-ancestors 'none'; upgrade-insecure-requests
```

In `firebase.json`, the header entry is:

```json
{
  "key": "Content-Security-Policy",
  "value": "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' https://apis.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.firebaseio.com https://*.firebaseapp.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://accounts.google.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com; form-action 'self' https://accounts.google.com; worker-src 'self' blob:; frame-ancestors 'none'; upgrade-insecure-requests"
}
```

### Service worker and Firebase auth redirect loop

The PWA navigation fallback must not serve the SPA shell for Firebase's reserved auth callback paths. Otherwise, Firebase redirect sign-in can loop or fail because the service worker intercepts `/__/auth/...`.

The current verified Workbox configuration in `vite.config.ts` is:

```ts
workbox: {
  globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
  navigateFallbackDenylist: [/^\/__\/auth\//, /^\/__\/firebase\//],
},
```

Keep both exclusions when changing PWA navigation fallback behavior. The surrounding PWA plugin also uses `registerType: 'autoUpdate'`, `injectRegister: 'auto'`, and `strategies: 'generateSW'`.

### Firebase config UI: verified state differs from the requested cleanup

**Do not record that the Firebase configuration input boxes have already been removed or that the app hardcodes Firebase config.** That claim does not match the current code:

- `src/services/firebase.ts` calls `getSyncSettings()` and reads `settings.firebaseConfig`.
- If `apiKey`, `authDomain`, `projectId`, or `appId` are missing, sign-in asks the user to enter and save them.
- `README.md` documents entering those four values under **Settings → Cloud Sync Settings**.
- The config is stored locally through sync settings; it is not hardcoded in the current `firebase.ts`.

If simplifying this UX is a future requirement, first choose a source for the Web app config (for example build-time `VITE_FIREBASE_*` variables or a carefully reviewed public config module), update validation and settings UI consistently, and verify offline-only use still works. Firebase Web config is public client configuration, but do not confuse it with a service-account private key.

### Sign-in and hosting setup

- `src/services/firebase.ts` supports Google popup sign-in and redirect sign-in for installed PWAs (and popup-blocked fallback).
- Firebase Auth persists in IndexedDB.
- Enable Google in Firebase Console under **Authentication → Sign-in method**.
- Add the deployed hostname (currently `hostelmanager-79bab.web.app`) under **Authentication → Settings → Authorized domains**.
- Confirm the Web app configuration belongs to project `hostelmanager-79bab`.

### Offline sync / data safety

- IndexedDB is primary; optional cloud sync must not block local saves.
- Sync configuration and queue behavior are described in `README.md` and implemented under `src/services/` and `src/db/`.
- Deletions use tombstones (`deletedAt`), not hard deletes.
- Regularly export a backup from **Settings → Offline backup and reports** and store it outside the browser profile. Browser storage can be cleared.

## Build, tests, and current verification

Run commands from the web project root (`HostelManager_Phase2_Complete_Project`):

```powershell
npm install
npm test
npm run build
```

The last verified run in this workspace passed the production build and all 13 unit tests. Firestore rules tests are separate and need a running Firestore Emulator:

```powershell
firebase emulators:start --only firestore
```

In a second PowerShell terminal:

```powershell
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
npm run test:rules
```

## Deployment and cache-refresh workflow

Prerequisites: Firebase CLI installed, authenticated with the account that can deploy, and `.firebaserc` selecting `hostelmanager-79bab`.

From the project root:

```powershell
npm install
npm test
npm run build
firebase deploy --only hosting
```

Deploy Firestore rules separately when they changed:

```powershell
firebase deploy --only firestore:rules
```

After Hosting reports a successful deployment:

1. Open `https://hostelmanager-79bab.web.app/`.
2. Do a hard refresh (`Ctrl+Shift+R`).
3. If an installed PWA still shows old assets, close all app tabs/windows, then in Chrome open **DevTools → Application → Service Workers → Unregister** for this origin and clear that origin's site data. Reopen the URL so the newly deployed service worker and assets install.
4. Recheck the Hosting CSP response header and test sign-in. Do not ask users to clear all browser data unless the targeted service-worker refresh fails; clearing site data can remove offline records.

Never deploy before `npm run build` succeeds. The configured Hosting `public` directory is `dist`.

## Rebuild from a blank folder (PowerShell)

These commands create a React/Vite/TypeScript scaffold and install the core libraries. **They do not recreate Hostel Manager's application behavior or data model.** To reproduce this app, also copy the project's source/config files (`src`, `app`, `shared`, `public`, `firestore.rules`, `firebase.json`, `vite.config.ts`, and the other project configuration) from a trusted copy before building.

```powershell
cd D:\
npm create vite@latest HostelManager_Phase2_Complete_Project -- --template react-ts
cd .\HostelManager_Phase2_Complete_Project
npm install
npm install firebase idb zustand zod react-hook-form @hookform/resolvers date-fns framer-motion lucide-react
npm install -D vite-plugin-pwa vitest fake-indexeddb @firebase/rules-unit-testing tailwindcss postcss autoprefixer
npm run build
```

Then copy the complete application source and project configuration into this scaffold. Review `package.json` scripts and dependency versions against the source project; do not overwrite existing working source with an empty scaffold.

Install and initialize Firebase CLI if needed:

```powershell
npm install --global firebase-tools
firebase login
firebase init
```

In the interactive `firebase init` flow, select **Hosting** and **Firestore**, choose existing project `hostelmanager-79bab`, set the Hosting public directory to `dist`, and configure as a single-page app if prompted. Preserve this project's existing `firebase.json`, `.firebaserc`, and `firestore.rules` rather than accepting generated replacements blindly. For an already initialized project, skip `firebase init`.

After copying the real app and verifying Firebase settings:

```powershell
npm test
npm run build
firebase deploy --only hosting
```

## Key files

- `vite.config.ts` — PWA manifest and Workbox routing exclusions.
- `firebase.json` — Hosting output, CSP/security headers, and Firestore rules path.
- `.firebaserc` — default Firebase project selection.
- `src/services/firebase.ts` — Firebase app/Auth setup and Google sign-in.
- `src/services/sync.ts` — opt-in sync queue behavior.
- `src/db/` — IndexedDB/repository implementation and tests.
- `src/screens/Settings.tsx` — cloud sync settings and offline backup/report actions.
- `firestore.rules` — server-side Firestore validation and access rules.
- `README.md` — setup and operational notes.

## Session Log

### 2026-10-30 — Bug found: Auth state is invisible in Settings, and first-time Google sign-in skips hostel setup if local data exists.

- **Task completed:** New or unlinked Google accounts must confirm hostel name/address, link the local profile and records to their UID, then continue. Returning linked accounts go directly to the Dashboard. Settings now displays live Google account status and sign-out/sign-in controls.
- **Files modified:** `src/App.tsx`, `src/screens/Onboarding.tsx`, `src/screens/Settings.tsx`, `src/services/firebase.ts`, `src/services/sync.ts`, `src/screens/authRouting.ts`, `src/screens/authRouting.test.ts`, `tsconfig.app.json`, `README.md`, and `forai.md`.
- **Exact account-link detection:** `getCloudHostelProfile(user)` now reads both `users/{uid}` and `hostels/{uid}`. It returns a valid profile only when both exist, `user.uid` matches the document's `uid`, `user.hostelId === uid`, and `hostel.ownerId === uid`; otherwise it returns null and auth routing requires setup. `resolveAuthDestination(authenticated, linkedUser, hostelProfile)` routes to Dashboard only when both remote documents are valid and linked; local IndexedDB profile presence does not affect this decision.
- **Exact new-user routing:** `App.tsx` subscribes to Firebase Auth in `useEffect`, exposes the current `User` to Settings, and checks cloud linkage on each signed-in state. A confirmed missing/unlinked cloud profile sets route `onboarding`, even when local `meta` exists. A ref prevents initial IndexedDB loading from overwriting this auth-driven route. If Firestore cannot be checked, the app reports the auth error and falls back to local Dashboard when an offline profile exists rather than falsely treating a network failure as a new account.
- **Exact setup/link behavior:** `Onboarding.tsx` seeds the Setup fields from any existing local `meta`, then requires the user to confirm/save them. It writes `users/{uid}` and `hostels/{uid}` in a single Firestore batch to satisfy the existing `getAfter` rules relationship, saves the local profile, enables sync without starting a racing queue worker, calls `forceFullSync()` to reconcile/upload existing local records under `hostels/{uid}`, and only then navigates to Dashboard. A cloud sync failure leaves the user in setup and local data remains saved for retry.
- **Exact Settings account UI:** `Settings.tsx` receives `accountEmail`, `accountLoading`, `accountError`, `onOpenSignIn`, and `onSignOut` props from `App.tsx`. It renders a green checked “Signed in as: [email]” row and a Sign Out action when authenticated; otherwise it renders “Sign In to Sync”. The previous always-visible “Open sign-in screen” button was removed. Sign out invokes the Firebase `signOutFromFirebase()` helper; the App Auth listener updates Settings state.
- **Focused tests:** Updated `authRouting.test.ts` to require both a linked user document and hostel profile for Dashboard, and to force setup when either is missing.
- **Documentation:** Updated `README.md` to describe first-time account confirmation, local-data linking, and sync activation.
- **Validation failure/fix:** Initial build failed before source type-check because the workspace's TypeScript 5.9.3 rejected the pre-existing `ignoreDeprecations: "6.0"` in `tsconfig.app.json`. Changed it to `"5.0"`, which is compatible with the installed compiler; a Vite warning about a dynamic import of statically imported `sync.ts` was avoided by using the existing static sync import.
- **Final verification:** `npm run build` passed (TypeScript, Vite, and PWA generation); `npm test` passed (4 test files, 18 tests). Browser QA created a temporary offline profile and confirmed Settings shows the signed-out “Sign In to Sync” action. Unit tests cover returning linked user → Dashboard and new/unlinked user → Setup. A real Google sign-in, Firestore document write, and authenticated Settings email/Sign Out click were not performed; those require a live account and Firebase access.

### 2026-10-30 — Bug found: App UI does not transition after successful Google Sign-In. Stuck on login screen.

- **Task completed:** Fixed the authenticated route transition so successful Google sign-in sends users with an existing Firestore hostel profile to Dashboard and users without one to a dedicated Hostel Setup view. The login screen is no longer rendered for an authenticated user.
- **Files modified:** `src/screens/Onboarding.tsx`, `src/services/firebase.ts`, `src/screens/authRouting.ts` (new), `src/screens/authRouting.test.ts` (new), and `forai.md`.
- **Root cause:** `Onboarding.tsx` only set `email` and showed an offline form after popup success. It kept the login view mounted and never listened for Firebase Auth state changes or checked for a remote hostel profile.
- **Exact listener/state logic:** `Onboarding.tsx` now installs `onAuthStateChanged(auth, ...)` inside a `useEffect`, cleans up its unsubscribe callback on unmount, and resolves redirect sign-in in that same effect. The listener sets `authUser`, enters a `checking` state, and calls `getCloudHostelProfile(user)`. The pure `resolveAuthDestination(isAuthenticated, hasCloudHostelProfile)` in `authRouting.ts` returns `login`, `setup`, or `dashboard`; the component renders a separate setup-only view for an authenticated user without a remote profile. When the cloud profile exists, it is saved to IndexedDB and passed to `onComplete`, which takes the app to Dashboard. Duplicate auth callbacks for the same UID are ignored.
- **Exact profile persistence logic:** `getCloudHostelProfile` reads `hostels/{uid}`, validates `name` and `address` with `hostelSchema`, and returns null for a missing document. `saveCloudHostelProfile` uses one Firestore `writeBatch` to write `users/{uid}` (`uid`, `email`, `hostelId`) and `hostels/{uid}` (`name`, `address`, `ownerId`), satisfying the existing rules' `getAfter` relationship. Authenticated setup saves this cloud profile, then IndexedDB, then invokes `onComplete`. A secondary “Continue offline instead” saves local data without cloud writes.
- **Exact offline/login UI logic:** Unauthenticated users see Google first and a small “Skip for now (Offline Mode)” link beneath it. Skipping opens the existing required local hostel setup. Once authenticated, the Google/login card and sign-out controls are absent; users see only Hostel Setup (or are routed directly to Dashboard if the remote profile exists).
- **Tests added:** `authRouting.test.ts` covers unauthenticated→login, authenticated/no-profile→setup, and authenticated/with-profile→dashboard.
- **Validation:** `npm run build` passed. `npm test` passed: 4 test files, 16 tests. A production-preview browser check confirmed the login loads unauthenticated and Skip opens offline setup. Authenticated Firestore integration was not live-tested because it requires a real Google account/Firebase session; the state routing cases are covered by unit tests.

### 2026-10-30 — Fixed: UI stuck on login after Google sign-in

- **Reported cause:** "Bug found: App stuck on Onboarding screen after successful Google Sign-In due to `!meta` condition in App.tsx overriding auth state."
- **Actual root cause:** `App.tsx` mounts `Onboarding` while no local `meta` exists, but that is also the component responsible for switching from Login to Setup. Its Firebase `onAuthStateChanged` listener existed. The popup success path received a non-null `User` but discarded it and relied entirely on the listener callback to update UI state, so a missed/delayed callback could leave the login screen rendered. The `!meta` guard alone does not force the login subview; onboarding has an authenticated setup view.
- **Files modified for this fix:** `src/screens/Onboarding.tsx` and `forai.md`. The earlier implementation's `src/services/firebase.ts`, `src/screens/authRouting.ts`, and `src/screens/authRouting.test.ts` continue to provide cloud profile lookup/write and tested destination mapping.
- **Exact code logic:** Moved auth transition handling to a shared `handleAuthState(user)` function and stored its current function in `authStateHandlerRef`. Both the `onAuthStateChanged` listener inside `useEffect` and the immediate user returned by `signInToFirebase()` call `authStateHandlerRef.current(user)`. The redirect-result user also calls the same handler. `handledAuthUidRef` deduplicates listener/popup delivery. The handler sets `authDestination` to `checking`, loads `hostels/{uid}`, then maps an existing profile to dashboard (persisting it locally and invoking `onComplete`) or a missing profile to the dedicated setup screen. Login UI therefore is not dependent on a later listener event after popup success.
- **UI clutter:** The login view continues to omit “Signed in as” and “Sign out”; signed-in users render the Hostel Setup screen or Dashboard route. Offline mode remains a smaller secondary link under Google.
- **App.tsx decision:** No duplicate Firebase listener was added to `App.tsx`; doing so would create two competing auth/profile-routing owners. The `if (!meta || route === 'onboarding')` guard remains responsible for deciding whether the app shell or onboarding/auth flow is mounted. The auth flow inside onboarding now deterministically handles authenticated users.
- **Tests/verification:** `npm run build` passed. `npm test` passed: 4 test files, 16 tests, including login/setup/dashboard destination cases. Source verification confirms both popup result and listener call the same handler. Live authenticated Firestore sign-in was not run in this environment.
