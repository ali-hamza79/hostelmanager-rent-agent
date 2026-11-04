# Hostel Manager (Android / Java / Firebase + PWA)

Hostel Manager includes an Android app and a PWA for hostel managers to record tenants, rooms, rent, and expenses. The PWA includes an approval-gated, **PayPal Sandbox-only** rent collection flow; it does not process real payments.

## Hackathon demo status (November 5, 2026)

The local end-to-end happy path was rehearsed: the signed-in owner ran Rent Agent, Gemini ranked Daniel ($700) before Mina ($380), the reminder copy action worked, and only the owner's Request click created the PayPal Sandbox order. The buyer paid the $700 order in full; PayPal Sync returned `COMPLETED`, recorded the payment locally, and reduced the displayed outstanding balance from $1,080 to Mina's $380. This rehearsal used the existing **Xyz** workspace, not a clean Maple House demo profile. After local payment recording, the sync indicator showed **Offline · 4 pending changes**; local payment recording and Firebase cloud sync are separate.

The deployed judge-facing PWA/API flow has not yet been verified. Treat this as a local Sandbox rehearsal, not proof of a production deployment or real-money payment.

## What it does

Rent Agent ranks overdue tenants from the current app snapshot and drafts factual explanations and reminders. The owner chooses whether to request payment; the tenant authorizes checkout with PayPal Sandbox; the app records a payment only after PayPal confirms `COMPLETED`.

**Agent proposes; owner requests; PayPal captures; the app records only after PayPal confirms `COMPLETED`.** The agent does not message tenants, create orders, or capture funds.

### Stack and demo boundaries

- React/Vite PWA with local IndexedDB storage and optional Firebase Authentication/Firestore sync.
- Node/Express server using PayPal Orders v2 and Gemini Flash (`gemini-3.6-flash` by default).
- Firebase owner ID-token verification protects rent-order and agent endpoints.
- PayPal Sandbox only; no real payment processing is enabled.
- The server validates and ranks the browser-provided rent snapshot, but does not independently load an authoritative ledger from Firebase. Snapshot values are demo input, not bank-grade accounting truth.
- Gemini output is validated server-side; when the model is unavailable the agent returns ranked rules-based proposals instead.

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

### PayPal Sandbox rent requests (PWA)

The PWA can request rent from a tenant with an outstanding balance. The owner must be signed in with the Firebase account whose UID is configured on the server. The owner reviews the PayPal approval link; the tenant completes checkout in a separate browser profile. A payment is written locally only after the server confirms the PayPal order is `COMPLETED`. The charge is split into monthly payment records so the existing rent calculation reduces the correct arrears. If the tenant chooses Pay in 4, PayPal pays the merchant the full captured order upfront; the buyer repays PayPal in installments. The app therefore records the full captured rent amount, not the buyer's first installment.

1. Copy `server/.env.example` to `server/.env`. Add the PayPal **Sandbox** client ID and secret, `PUBLIC_BASE_URL` (locally `http://localhost:3000`), `ALLOWED_ORIGIN` (the PWA origin), `FIREBASE_PROJECT_ID`, and `OWNER_UID` (the owner account UID from Firebase Authentication). Never put PayPal or Firebase Admin credentials in a `VITE_` variable.
2. From `server/`, run `npm install`, then `npm start` to start the API. The server verifies Firebase ID tokens and accepts owner actions only from `OWNER_UID`.
3. Set `VITE_API_BASE_URL=http://localhost:3000` in the PWA `.env`, run `npm run dev`, sign in with the configured owner account, and load `?demo=1` in an empty browser profile.
4. On the dashboard, request rent for an overdue tenant. The app displays—but does not automatically open—the PayPal approval link. Complete the Sandbox payment in a second browser profile, then use **Sync with PayPal** in the owner profile. Cancelled or incomplete orders are never saved as payments.
5. To use Rent Agent, set `GOOGLE_GENERATIVE_AI_API_KEY` in `server/.env` (and optionally `GOOGLE_GENERATIVE_AI_MODEL`; the default is `gemini-3.6-flash`). **Run Rent Agent** ranks overdue tenants by months overdue, then balance, and drafts explanations/reminders from the current browser snapshot. If Gemini is unavailable, the server returns ranked template proposals. The owner must separately click **Request** to start a PayPal order; Rent Agent never sends reminders or moves money. `POST /api/agent/analyze` is owner-authenticated, caps snapshot sizes, and forces proposal IDs, ranks, and amounts from the snapshot. The browser-provided snapshot is not an authoritative production rent ledger.

For local development, the usual endpoints are `http://localhost:5173` (PWA) and `http://localhost:3000` (API). For a hosted demo, configure server-side `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE`, `PUBLIC_BASE_URL`, `ALLOWED_ORIGIN`, `PORT`, `FIREBASE_PROJECT_ID`, `OWNER_UID`, `GOOGLE_GENERATIVE_AI_API_KEY`, and `GOOGLE_GENERATIVE_AI_MODEL`; set the PWA build variable `VITE_API_BASE_URL` to the hosted API URL. Set PayPal return/cancel URLs and CORS to the exact deployed origins. Keep all secrets on the server. Hosting and deployed end-to-end checkout must be tested separately; local success does not imply deployment.

`server/.env` is ignored by Git. Do not define `VITE_OWNER_ACTION_SECRET`: Vite variables are bundled into browser code and are not secrets. Use `npm test` at the repository root for PWA tests, `npm test` from `server/` for rent-order and Rent Agent tests, and `npm run test:gemini` from `server/` for the separate Gemini provider check.

Firebase Web app configuration values are identifiers intended for client applications, not service-account credentials. Do not enter or deploy a service-account JSON file or private key in the PWA. Pending operations retry using exponential backoff; permanent permission/validation failures are retained for review in Settings. Deletions are retained as timestamped tombstones, not hard-deleted. A force full sync reconciles those tombstones across devices. If legacy Firestore data contains duplicate room documents with the same floor and room labels, tenant sync uses the active matching room with the largest capacity (stable document-ID tie-break) and retains the duplicate documents; clean up duplicates in Firestore separately when convenient.

Run `npm test` for offline/schema coverage. Firestore rule tests require a local Firestore Emulator: start it with Firebase CLI (`firebase emulators:start --only firestore`), then in another PowerShell terminal set `$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"` and run `npm run test:rules`.

### Known data and sync limitations

- A browser-provided rent snapshot is not server-verified against an authoritative rent ledger. Keep the demo restricted to the configured owner and PayPal Sandbox.
- Duplicate Firestore room records are handled non-destructively: sync selects a canonical matching room and retains the duplicates for review.
- Firebase cloud sync is separate from PayPal status sync and local payment recording. Permission/validation failures remain visible for review; do not weaken Firestore rules to hide them.
- One unresolved local payment record references a tenant ID that is absent from both local and cloud tenant data. Its original tenant/capture association is unknown. Do not reassign it to another tenant or delete it without first identifying the receipt; it is not part of the clean demo story. If verified as a test-only orphan, remove only that specific payment through the app and clear/retry its queue item.
- To keep the demo simple, use a fresh browser profile with `?demo=1` for the Maple House story (Daniel $700, Mina $380, other seeded tenants paid). The seed refuses to overwrite a non-empty profile.

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
- `hostels/{uid}/Payments/{recordId}`: rent receipts, including confirmed PayPal Sandbox captures; soft deletion uses `deletedAt`.
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
