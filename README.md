# Hostel Manager (Android / Java / Firebase)

Hostel Manager is an Android app for a hostel manager to record tenants, rooms, rent received offline, and expenses. **Rent entries are manual records only**; this project does not integrate a bank, card, wallet, or online payment gateway.

## Firebase setup

1. Create an Android app in Firebase with package name `com.hostelmanager`.
2. Download the matching `google-services.json` into `app/google-services.json` (this file is intentionally not included in the project archive).
3. Enable Google authentication in Firebase Authentication.
4. Create a Cloud Firestore database.
5. Publish the rules in `firestore.rules` to the project's Firestore database.
6. Open the project in Android Studio and sync Gradle.

## Optional PWA cloud sync

The PWA uses IndexedDB as its source of truth. On first launch, create a local hostel profile or sign in with Google from the front-page onboarding screen. A first-time Google account must confirm a hostel name and address; this links the profile and existing local records to that account and enables cloud sync. Returning accounts with an existing linked hostel profile go directly to the Dashboard. Offline-only users continue to keep data locally, and users can disable cloud sync in Settings. Local record changes and their queue entries are committed together, and network failures leave queued changes available for retry.

To connect the PWA:

1. In Firebase Console, register a Web app in the same Firebase project used by the Android app.
2. Enable Google as an Authentication provider and add the PWA's deployed domain to Firebase Authentication's authorized domains. `localhost` is suitable for local development.
3. Ensure Cloud Firestore is enabled and publish the current `firestore.rules` from this project. The rules permit the signed-in owner to create/check their own hostel profile, validate sync timestamps and records, and prohibit hard deletes.
4. The current Hostel Manager Firebase Web app's public values are built into `src/firebaseConfig.ts`, so the normal sign-in screen works without entering configuration. For a different Firebase project, copy `.env.example` to `.env` and replace `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` using Firebase Console → Project settings → Your apps → Web app. Optionally set `VITE_FIREBASE_APPCHECK_SITE_KEY` to the reCAPTCHA v3 site key registered for Firebase App Check. These Vite values are embedded into the client bundle; use only public Web app identifiers, never service-account credentials.
5. Run `npm install` and `npm run dev`, then open the printed local URL. The sign-in screen and Settings page do not show config fields by default. **Advanced: Configure custom Firebase backend** on the sign-in screen reveals an optional per-device override saved in encrypted IndexedDB. Google sign-in is optional; **Skip for now (Offline Mode)** opens local profile setup. A hostel name and address are still required before the dashboard can open.
6. For App Check, register the Firebase Web app in Firebase Console → App Check, choose reCAPTCHA v3, and set its site key in `.env`. Confirm `firebase.json` permits the required reCAPTCHA/App Check origins. Verify valid traffic before enabling enforcement; cloud sync failures must not prevent offline local use.
7. For a first-time signed-in account, confirm the Hostel Setup screen to link the hostel and sync existing local records. For returning accounts, use **Settings → Cloud Sync Settings** to check the sync preference and use **Force Full Sync** when needed. Conflicts use each record's ISO `updatedAt` timestamp (falling back to `createdAt`); later timestamps win.

Firebase Web app configuration values are identifiers intended for client applications, not service-account credentials. Do not enter or deploy a service-account JSON file or private key in the PWA. Pending operations retry using exponential backoff; permanent permission/validation failures are retained for review in Settings. Deletions are retained as timestamped tombstones, not hard-deleted. A force full sync reconciles those tombstones across devices.

Run `npm test` for offline/schema coverage. Firestore rule tests require a local Firestore Emulator: start it with Firebase CLI (`firebase emulators:start --only firestore`), then in another PowerShell terminal set `$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"` and run `npm run test:rules`.

### Firebase and hosting hardening

- Restrict the Android Firebase API key in Google Cloud Console to Android apps using package name `com.hostelmanager` and the release signing certificate SHA-1. Restrict its API allowlist to only the Firebase APIs the app uses. Use a separate key for the web app, restricted to the deployed HTTPS referrers; never put service-account credentials in either client.
- In Firebase Console, register the Android app with App Check and Play Integrity, and the Web app with reCAPTCHA v3. Verify valid traffic first, then enable App Check enforcement for the relevant Firebase products. Do not use the debug provider in production. Web App Check initializes only when `VITE_FIREBASE_APPCHECK_SITE_KEY` is present at build time.
- Anonymous/demo Android records are not subject to a five-day TTL; the app now states this accurately. An anonymous account can become inaccessible after sign-out/app-data removal, so create a permanent account and keep backups.
- Firebase Hosting uses the repository `firebase.json` CSP response header. If deploying elsewhere, configure an equivalent HTTPS-only Content-Security-Policy and test Google redirect auth under that policy.

## Current data structure

- `users/{uid}`: signed-in manager profile.
- `hostels/{uid}`: hostel profile.
- `hostels/{uid}/Tenants/{recordId}`: tenant details and monthly rent; soft deletion uses `deletedAt`.
- `hostels/{uid}/Rooms/{recordId}`: floor, room number, and bed capacity; room keys use `floor_room`.
- `hostels/{uid}/Payments/{recordId}`: manually entered rent receipts, not online transactions; soft deletion uses `deletedAt`.
- `hostels/{uid}/Expenses/{recordId}`: expenses; soft deletion uses `deletedAt`.

New records use a client-generated stable document ID for the lifetime of the form, preventing a repeated tap on the same form from creating a second record with a different ID. Existing records keep their existing document IDs.

## Room assignments

A room must be registered with its capacity before adding tenants to it. New tenant assignments are checked against the number of active tenants currently assigned to that room. For reliable administration, keep room and tenant floor/room labels consistent.

## Money and rent balance

Amounts continue to use the existing Firestore `amount` and `rent` numeric fields to preserve compatibility with saved records. New input is limited to two decimal places, and totals and monthly unpaid calculations use decimal arithmetic internally. The unpaid calculation uses each tenant's current rent for every month since their join month; rent history and automatic carry-forward of overpayments are not implemented in this version.

## Configuration

`app/google-services.json`, `local.properties`, and `.env` are machine/project-specific and excluded from version control. `.env.example` contains variable names only. Do not commit service-account credentials or private keys. Browser-hosted custom Web app identifiers are stored encrypted locally; this encryption does not protect against scripts executing in the same origin.

Offline-only operators should download a JSON backup regularly from **Settings → Offline backup and reports** and store it outside the browser profile. Restoring replaces local records and clears pending sync operations; it does not automatically upload records or remove cloud-only records.

`shared/validation-limits.json` is the source for PWA validation and generated Android Java limits. Firestore Security Rules mirror those values because the rules language cannot import application JSON; the rule tests cover the server-side constraints.
