# Hostel Manager

Hostel Manager is a web app for hostel owners to manage tenants, rooms, rent, payments, and expenses. It also provides offline-first records, optional Firebase cloud sync, and a rent-assistance workflow.

## PayPal

The server creates and captures payments with PayPal Orders v2, and an order is created only after the owner clicks the payment request action. The tenant approves the Sandbox order, and the app records a payment only after PayPal confirms the full capture; Pay in 4 is between the buyer and PayPal, so the merchant capture and the app's recorded rent remain the full order amount.

## AI

Gemini drafts rent explanations and reminders only; it cannot rank tenants, create orders, capture money, or send messages. The server independently ranks tenants from the submitted snapshot and verifies every amount Gemini writes before returning the draft.

## Run locally

In the first PowerShell terminal, run these commands from the repository root:

```powershell
Copy-Item server\.env.example server\.env
Set-Location server
npm install
```

Edit `server\.env` with PayPal Sandbox credentials, the Firebase project ID and owner UID, `PUBLIC_BASE_URL=http://localhost:3000`, and `ALLOWED_ORIGIN=http://localhost:5173`; optionally add `GOOGLE_GENERATIVE_AI_API_KEY` for Gemini drafts. Then start the API from the `server` directory:

```powershell
npm start
```

In a second PowerShell terminal, run these commands from the PWA root, which is the repository root:

```powershell
npm install
npm run dev
```

Set the PWA `.env` value `VITE_API_BASE_URL=http://localhost:3000` and the Firebase Web app values when using Firebase sign-in. Open the local URL printed by Vite. For offline use, skip sign-in and create a local hostel profile; the PayPal flow requires the configured Firebase owner account.

## Deploy the PWA

From the PWA root, run these commands in order:

```powershell
npm run build
firebase deploy --only hosting
```

Set the deployed PWA origin in the server's `ALLOWED_ORIGIN`, and configure `VITE_API_BASE_URL` to point to a separately deployed server before building. Firebase Hosting deploys the PWA only; deploy and configure the API server separately with its Sandbox and Firebase credentials.

## Trigger a Sandbox payment

A judge can configure a PayPal Sandbox app and buyer account, set the server environment values above, and sign in to the PWA with the Firebase owner account whose UID is in `OWNER_UID`. Load `?demo=1` in an empty browser profile, click **Request** for a tenant with overdue rent, and open the approval link shown by the app. Approve the order using the Sandbox buyer, return to the owner profile, and click **Sync with PayPal**; a payment is recorded only after the server verifies the completed full capture.
