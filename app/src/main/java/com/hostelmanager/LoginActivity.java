package com.hostelmanager;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.firebase.FirebaseApp;
import com.google.firebase.auth.AuthCredential;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.GoogleAuthProvider;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.Source;

import java.util.HashMap;
import java.util.Map;

public class LoginActivity extends Activity {
    static final String EXTRA_HOSTEL_ID = "com.hostelmanager.HOSTEL_ID";
    static final String EXTRA_SIGN_OUT = "com.hostelmanager.SIGN_OUT";
    static final String ANONYMOUS_DATA_NOTICE =
            "Demo Mode uses a temporary anonymous account. Your data is not automatically deleted, but it may become inaccessible after signing out or clearing app data. Create a permanent account and keep a backup.";
    private static final int GOOGLE_SIGN_IN_REQUEST = 1001;
    private static final int INK = Color.rgb(31, 41, 55);
    private static final int MUTED = Color.rgb(100, 116, 139);
    private static final int BORDER = Color.rgb(226, 232, 240);
    private static final int WARNING = Color.rgb(239, 68, 68);

    private FirebaseAuth auth;
    private FirebaseFirestore firestore;
    private GoogleSignInClient googleSignInClient;
    private LinearLayout content;
    private TextView status;
    private EditText hostelName;
    private EditText hostelAddress;
    private static final String SESSION_PREFS = "hostel_manager_session";
    private static final String SESSION_HOSTEL_ID = "hostel_id";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (FirebaseApp.initializeApp(this) == null) {
            showMessage("Firebase is not configured. Add app/google-services.json from your Firebase project.");
            return;
        }

        com.google.firebase.appcheck.FirebaseAppCheck.getInstance()
                .installAppCheckProviderFactory(
                        com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory.getInstance());
        firestore = FirestoreSetup.configure();
        auth = FirebaseAuth.getInstance();
        int clientIdResource = getResources().getIdentifier(
                "default_web_client_id", "string", getPackageName());
        if (clientIdResource == 0) {
            showMessage("Google sign-in is not configured. Add a valid app/google-services.json.");
            return;
        }

        GoogleSignInOptions options = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(getString(clientIdResource))
                .requestEmail()
                .build();
        googleSignInClient = GoogleSignIn.getClient(this, options);

        if (getIntent().getBooleanExtra(EXTRA_SIGN_OUT, false)) {
            clearHostelSession();
            auth.signOut();
            googleSignInClient.signOut().addOnCompleteListener(this, unused -> showSignIn());
            return;
        }
        if (auth.getCurrentUser() == null) {
            showSignIn();
        } else {
            loadManagerProfile();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != GOOGLE_SIGN_IN_REQUEST) {
            return;
        }
        if (resultCode != RESULT_OK || data == null) {
            showSignIn();
            status.setText("Google sign-in was cancelled.");
            return;
        }

        try {
            String idToken = GoogleSignIn.getSignedInAccountFromIntent(data)
                    .getResult(ApiException.class)
                    .getIdToken();
            if (idToken == null || idToken.trim().isEmpty()) {
                showSignIn();
                status.setText("Google did not return an ID token. Check the Firebase OAuth configuration.");
                return;
            }
            AuthCredential credential = GoogleAuthProvider.getCredential(idToken, null);
            auth.signInWithCredential(credential).addOnCompleteListener(this, task -> {
                if (!task.isSuccessful()) {
                    showSignIn();
                    status.setText(errorMessage(task.getException()));
                    return;
                }
                loadManagerProfile();
            });
        } catch (ApiException exception) {
            showSignIn();
            status.setText("Google sign-in failed: " + errorMessage(exception));
        }
    }

    private void showSignIn() {
        beginPage("HostelManager");
        status = statusText("");
        addButton("Continue with Google", () -> {
            status.setText("Opening Google sign-in...");
            startActivityForResult(googleSignInClient.getSignInIntent(), GOOGLE_SIGN_IN_REQUEST);
        });
        addDemoDataNotice();
        TextView demoButton = text("Try Demo Mode (No account needed)");
        demoButton.setTextSize(14);
        demoButton.setTextColor(Color.rgb(66, 133, 244));
        demoButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        demoButton.setGravity(Gravity.CENTER);
        demoButton.setPadding(dp(16), dp(8), dp(16), dp(8));
        demoButton.setOnClickListener(view -> signInAnonymously());
        LinearLayout.LayoutParams demoParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        demoParams.topMargin = dp(16);
        content.addView(demoButton, demoParams);
        addStatus();
    }

    private void addDemoDataNotice() {
        TextView notice = text(ANONYMOUS_DATA_NOTICE);
        notice.setTextSize(14);
        notice.setTextColor(Color.rgb(120, 53, 15));
        notice.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(255, 251, 235));
        background.setCornerRadius(dp(10));
        background.setStroke(dp(1), Color.rgb(253, 230, 138));
        notice.setBackground(background);
        content.addView(notice, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    private void signInAnonymously() {
        status.setText("Starting demo mode...");
        FirebaseAuth.getInstance().signInAnonymously().addOnCompleteListener(this, task -> {
            if (task.isSuccessful()) {
                loadManagerProfile();
                return;
            }
            status.setText("Could not start demo mode. " + errorMessage(task.getException()));
        });
    }

    private void loadManagerProfile() {
        if (auth.getCurrentUser() == null) {
            showSignIn();
            return;
        }
        statusMessage("Loading your hostel profile...");
        String uid = auth.getCurrentUser().getUid();
        firestore.collection("users").document(uid).get(Source.DEFAULT)
                .addOnSuccessListener(this, snapshot -> {
                    if (!snapshot.exists()) {
                        showHostelSetup();
                        return;
                    }
                    String hostelId = snapshot.getString("hostelId");
                    if (hostelId == null || hostelId.trim().isEmpty()) {
                        showMessage("Your account has an invalid hostel profile. Contact your administrator.");
                        return;
                    }
                    openHostel(hostelId);
                })
                .addOnFailureListener(this, error -> {
                    showSignIn();
                    status.setText("Could not load your profile. Connect to the internet and try again. "
                            + errorMessage(error));
                });
    }

    private void showHostelSetup() {
        beginPage("Create your hostel");
        status = statusText("Create a hostel profile to start managing your data.");
        addStatus();
        hostelName = field("Hostel name");
        hostelAddress = field("Address");
        content.addView(hostelName);
        content.addView(hostelAddress);
        addButton("Create hostel", this::createHostel);
        addButton("Sign out", this::signOut);
    }

    private void createHostel() {
        String name = hostelName.getText().toString().trim();
        String address = hostelAddress.getText().toString().trim();
        if (name.isEmpty() || address.isEmpty()) {
            status.setText("Enter both the hostel name and address.");
            return;
        }
        if (name.length() > ValidationLimits.HOSTEL_NAME) {
            status.setText("Hostel name is too long (maximum 120 characters).");
            return;
        }
        if (address.length() > ValidationLimits.HOSTEL_ADDRESS) {
            status.setText("Address is too long (maximum 250 characters).");
            return;
        }
        if (auth.getCurrentUser() == null) {
            showSignIn();
            status.setText("Your session expired. Sign in again.");
            return;
        }

        status.setText("Creating your hostel...");
        String uid = auth.getCurrentUser().getUid();
        Map<String, Object> profile = new HashMap<>();
        profile.put("uid", uid);
        profile.put("email", auth.getCurrentUser().getEmail() == null ? "" : auth.getCurrentUser().getEmail());
        profile.put("hostelId", uid);

        Map<String, Object> hostel = new HashMap<>();
        hostel.put("name", name);
        hostel.put("address", address);
        hostel.put("ownerId", uid);

        firestore.runBatch(batch -> {
            batch.set(firestore.collection("users").document(uid), profile);
            batch.set(firestore.collection("hostels").document(uid), hostel);

        }).addOnSuccessListener(this, unused -> openHostel(uid))
                .addOnFailureListener(this, error -> status.setText(
                        "Could not create the hostel profile. " + errorMessage(error)));
    }

    private void openHostel(String hostelId) {
        saveHostelSession(hostelId);
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra(EXTRA_HOSTEL_ID, hostelId);
        startActivity(intent);
        finish();
    }

    private void signOut() {
        clearHostelSession();
        auth.signOut();
        googleSignInClient.signOut().addOnCompleteListener(this, unused -> showSignIn());
    }

    private android.content.SharedPreferences sessionPreferences() {
        return getSharedPreferences(SESSION_PREFS, MODE_PRIVATE);
    }

    private void saveHostelSession(String hostelId) {
        sessionPreferences().edit().putString(SESSION_HOSTEL_ID, hostelId).apply();
    }

    private void clearHostelSession() {
        sessionPreferences().edit().remove(SESSION_HOSTEL_ID).apply();
    }

    private void showMessage(String message) {
        beginPage("HostelManager");
        status = statusText(message);
        addStatus();
    }

    private void statusMessage(String message) {
        beginPage("HostelManager");
        status = text(message);
        status.setTextSize(14);
        status.setTextColor(MUTED);
        status.setGravity(Gravity.CENTER);
        addStatus();
    }

    private void beginPage(String title) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL | Gravity.CENTER_VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(view.getPaddingLeft(), insets.getSystemWindowInsetTop(),
                    view.getPaddingRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });

        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);

        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL | Gravity.CENTER_VERTICAL);
        content.setPadding(dp(32), dp(24), dp(32), dp(24));

        TextView heading = text(title);
        heading.setTextSize(32);
        heading.setTextColor(INK);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.setGravity(Gravity.CENTER);
        content.addView(heading, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView subtitle = text("HostelManager".equals(title)
                ? "Manage your hostel, seamlessly."
                : "Set up your hostel to get started.");
        subtitle.setTextSize(16);
        subtitle.setTextColor(MUTED);
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subtitleParams.topMargin = dp(8);
        content.addView(subtitle, subtitleParams);

        scrollView.addView(content, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(scrollView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    private TextView text(String value) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(16);
        return view;
    }

    private EditText field(String hint) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setSingleLine(true);
        return input;
    }

    private void addButton(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(16);
        button.setTextColor(INK);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(24), dp(16), dp(24), dp(16));
        GradientDrawable buttonBackground = new GradientDrawable();
        buttonBackground.setColor(Color.WHITE);
        buttonBackground.setCornerRadius(dp(12));
        buttonBackground.setStroke(dp(1), BORDER);
        button.setBackground(new RippleDrawable(
                ColorStateList.valueOf(Color.rgb(241, 245, 249)), buttonBackground, null));
        button.setOnClickListener(view -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(40);
        content.addView(button, params);
    }

    private TextView statusText(String value) {
        TextView view = text(value);
        view.setTextSize(14);
        view.setTextColor(WARNING);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private void addStatus() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(16);
        content.addView(status, params);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String errorMessage(Exception error) {
        return ErrorMessages.forFirebase(error);
    }
}