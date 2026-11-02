package com.hostelmanager;

import android.app.Activity;
import android.app.DatePickerDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import com.google.firebase.FirebaseApp;
import com.google.firebase.auth.FirebaseAuth;
import com.google.android.material.snackbar.Snackbar;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.time.YearMonth;
import java.util.Date;
import java.util.Calendar;
import java.util.UUID;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int INK = Color.rgb(31, 41, 55);
    private static final int MUTED = Color.rgb(100, 116, 139);
    private static final int PALE = Color.rgb(241, 245, 249);
    private static final int PRIMARY = Color.rgb(74, 144, 226);
    private static final int BACKGROUND = Color.rgb(248, 250, 252);
    private static final int BORDER = Color.rgb(226, 232, 240);
    private static final int WHITE = Color.WHITE;

    private ApiClient api;
    private JSONObject data = new JSONObject();
    private LinearLayout content;
    private TextView connectionIndicator;
    private final java.util.Map<String, String> operationIds = new java.util.HashMap<>();
    private final java.util.Map<Button, android.widget.ProgressBar> saveSpinners = new java.util.HashMap<>();
    private static final String STATE_OPERATION_IDS = "operation_ids";
    private static final String TAG_PENDING_BACK = "pending_back_home_button";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (FirebaseApp.initializeApp(this) == null
                || FirebaseAuth.getInstance().getCurrentUser() == null) {
            startActivity(new android.content.Intent(this, LoginActivity.class));
            finish();
            return;
        }
        FirestoreSetup.configure();
        if (savedInstanceState != null) {
            java.util.HashMap<String, String> restored = (java.util.HashMap<String, String>)
                    savedInstanceState.getSerializable(STATE_OPERATION_IDS);
            if (restored != null) operationIds.putAll(restored);
        }
        api = new ApiClient(getIntent().getStringExtra(LoginActivity.EXTRA_HOSTEL_ID));
        registerNetworkStatusCallback();
        showHome();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putSerializable(STATE_OPERATION_IDS, new java.util.HashMap<>(operationIds));
        super.onSaveInstanceState(outState);
    }

    private String operationIdFor(String form) {
        String existing = operationIds.get(form);
        if (existing == null || existing.isEmpty()) {
            existing = UUID.randomUUID().toString();
            operationIds.put(form, existing);
        }
        return existing;
    }

    private android.net.ConnectivityManager.NetworkCallback networkCallback;

    private void registerNetworkStatusCallback() {
        if (android.os.Build.VERSION.SDK_INT < 24) return;
        android.net.ConnectivityManager manager = (android.net.ConnectivityManager)
                getSystemService(CONNECTIVITY_SERVICE);
        if (manager == null) return;
        networkCallback = new android.net.ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(android.net.Network network) {
                runOnUiThread(MainActivity.this::updateConnectionIndicator);
            }
            @Override public void onLost(android.net.Network network) {
                runOnUiThread(MainActivity.this::updateConnectionIndicator);
            }
            @Override public void onCapabilitiesChanged(android.net.Network network,
                    android.net.NetworkCapabilities capabilities) {
                runOnUiThread(MainActivity.this::updateConnectionIndicator);
            }
        };
        try { manager.registerDefaultNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
    }

    @Override
    protected void onDestroy() {
        if (networkCallback != null) {
            android.net.ConnectivityManager manager = (android.net.ConnectivityManager)
                    getSystemService(CONNECTIVITY_SERVICE);
            if (manager != null) {
                try { manager.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
            }
        }
        super.onDestroy();
    }

    private void showHome() {
        beginPage("HostelManager", false);
        TextView greeting = text(greeting(), 26, true, INK);
        content.addView(greeting);
        TextView intro = text("Hostel overview", 15, false, MUTED);
        LinearLayout.LayoutParams introParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        introParams.topMargin = dp(3);
        content.addView(intro, introParams);
        if (FirebaseAuth.getInstance().getCurrentUser() != null
                && FirebaseAuth.getInstance().getCurrentUser().isAnonymous()) {
            addDemoDataNotice();
        }
        TextView status = text("Loading saved hostel data...", 14, false, MUTED);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusParams.topMargin = dp(14);
        content.addView(status);
        status.setLayoutParams(statusParams);
        LinearLayout dashboard = new LinearLayout(this);
        dashboard.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams dashboardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dashboardParams.topMargin = dp(4);
        content.addView(dashboard, dashboardParams);
        addMenuButtons();

        if (!api.isConfigured()) {
            status.setText("Your hostel profile is unavailable. Sign out and sign in again.");
            return;
        }
        api.post("getData", new JSONObject(), new ApiClient.Callback() {
            @Override
            public void onSuccess(JSONObject result) {
                data = result;
                JSONArray invalidRows = result.optJSONArray("invalidRows");
                if (invalidRows != null && invalidRows.length() > 0) {
                    StringBuilder warning = new StringBuilder("Loaded; skipped invalid amounts in ");
                    for (int index = 0; index < invalidRows.length(); index++) {
                        JSONObject row = invalidRows.optJSONObject(index);
                        if (row == null) continue;
                        if (warning.charAt(warning.length() - 1) != ' ') warning.append(", ");
                        warning.append(row.optString("id")).append(" (").append(row.optString("field")).append(')');
                    }
                    status.setText(warning.toString());
                } else {
                    status.setText("Hostel data loaded from Firebase");
                }
                showDashboardCards(dashboard, result);
            }

            @Override
            public void onError(String message) {
                status.setText("Could not load cloud data.");
                showError(message);
            }
        });
    }

    private void addDemoDataNotice() {
        TextView notice = text(LoginActivity.ANONYMOUS_DATA_NOTICE, 14, false,
                Color.rgb(120, 53, 15));
        notice.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(255, 251, 235));
        background.setCornerRadius(dp(10));
        background.setStroke(dp(1), Color.rgb(253, 230, 138));
        notice.setBackground(background);
        LinearLayout.LayoutParams noticeParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        noticeParams.topMargin = dp(12);
        content.addView(notice, noticeParams);
    }

    private void showDashboardCards(LinearLayout dashboard, JSONObject result) {
        JSONObject totals = result.optJSONObject("totals");
        JSONArray unpaid = result.optJSONArray("unpaid");
        JSONArray tenants = result.optJSONArray("tenants");
        JSONArray rooms = result.optJSONArray("rooms");

        addSectionTitle(dashboard, "At a glance");
        LinearLayout primaryMetrics = new LinearLayout(this);
        primaryMetrics.setOrientation(LinearLayout.HORIZONTAL);
        if (getResources().getDisplayMetrics().widthPixels / getResources().getDisplayMetrics().density < 360) {
            primaryMetrics.setOrientation(LinearLayout.VERTICAL);
        }
        dashboard.addView(primaryMetrics);
        String outstanding = unpaid == null ? "Unavailable" : money(totalUnpaid(unpaid));
        addDashboardMetric(primaryMetrics, "Outstanding rent", outstanding, true);
        addDashboardMetric(primaryMetrics, "Room occupancy", occupancySummary(tenants, rooms), true);

        addSectionTitle(dashboard, "Financial summary");
        LinearLayout financialMetrics = dashboardRow(dashboard);
        addDashboardMetric(financialMetrics, "Rent collected", totalValue(totals, "rentCollected"), false);
        addDashboardMetric(financialMetrics, "Expenses", totalValue(totals, "expenses"), false);
        LinearLayout activityMetrics = dashboardRow(dashboard);
        addDashboardMetric(activityMetrics, "Active tenants",
                tenants == null ? "Unavailable" : String.valueOf(activeTenantCount(tenants)), false);
        addDashboardMetric(activityMetrics, "Payments to review",
                unpaid == null ? "Unavailable" : String.valueOf(unpaid.length()), false);
        addDashboardMetric(dashboard, "Balance", totalValue(totals, "balance"), false);

    }

    private void addMenuButtons() {
        addSectionTitle(content, "Quick actions");
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.VERTICAL);
        content.addView(actions);
        addActionRow(actions, "Add tenant", this::showAddTenant,
                "Record rent", this::showAddPayment);
        addActionRow(actions, "Manage rooms", this::showRooms,
                "Add expense", this::showAddExpense);

        addSectionTitle(content, "More tools");
        LinearLayout moreActions = new LinearLayout(this);
        moreActions.setOrientation(LinearLayout.VERTICAL);
        content.addView(moreActions);
        addActionRow(moreActions, "View tenants", this::showTenants,
                "Payment history", this::showPaymentHistory);
        addActionRow(moreActions, "Unpaid list", this::showUnpaid,
                "Change rent", this::showChangeRent);
        addButton(moreActions, "Sign out", () -> {
            android.content.Intent intent = new android.content.Intent(this, LoginActivity.class);
            intent.putExtra(LoginActivity.EXTRA_SIGN_OUT, true);
            startActivity(intent);
            finish();
        });
    }

    private void showTenants() {
        beginPage("Tenants", true);
        EditText search = field("Search by name, phone, room, or status", false);
        content.addView(search);
        LinearLayout results = new LinearLayout(this);
        results.setOrientation(LinearLayout.VERTICAL);
        content.addView(results);
        loadData(response -> {
            data = response;
            JSONArray tenants = response.optJSONArray("tenants");
            Runnable filter = () -> {
                results.removeAllViews();
                String query = search.getText().toString().trim().toLowerCase(Locale.ROOT);
                int count = 0;
                if (tenants != null) {
                    for (int i = 0; i < tenants.length(); i++) {
                        JSONObject tenant = tenants.optJSONObject(i);
                        if (tenant == null) {
                            continue;
                        }
                        String summary = tenant.optString("name") + "  •  Room "
                                + tenant.optString("room") + "  •  " + money(tenant.optDouble("rent", 0))
                                + "  •  " + tenant.optString("status");
                        String haystack = (summary + " " + tenant.optString("phone")).toLowerCase(Locale.ROOT);
                        if (haystack.contains(query)) {
                            View tenantView = tenantCard(tenant);
                            LinearLayout tenantCard = (LinearLayout) tenantView;
                            Button deleteButton = smallDeleteButton("Delete");
                            deleteButton.setOnClickListener(view -> confirmDeleteTenant(tenant));
                            tenantCard.addView(deleteButton);
                            results.addView(tenantCard);
                            count++;
                        }
                    }
                }
                if (count == 0) {
                    results.addView(text("No matching tenants.", 15, false, MUTED));
                }
            };
            search.addTextChangedListener(new TextWatcher() {
                @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
                @Override public void onTextChanged(CharSequence s, int start, int before, int count) { filter.run(); }
                @Override public void afterTextChanged(Editable s) { }
            });
            filter.run();
        });
    }

    private void showAddTenant() {
        beginPage("Add tenant", true);
        EditText name = field("Full name", false);
        EditText phone = field("Phone number", false);
        EditText floor = field("Floor", false);
        EditText room = field("Room number", false);
        EditText joinDate = field("Join date (YYYY-MM-DD)", false);
        joinDate.setText(today());
        EditText billingStartDate = monthPicker("Start billing month", currentMonth());
        Spinner occupation = spinner(new String[]{"Student", "Jobholder", "Other"});
        Spinner mess = spinner(new String[]{"No", "Yes"});
        EditText rent = field("Monthly rent", true);
        Spinner status = spinner(new String[]{"Active", "Inactive"});

        addLabeledField("Name", name);
        addLabeledField("Phone", phone);
        addLabeledField("Floor", floor);
        addLabeledField("Room", room);
        addLabeledField("Join date", joinDate);
        addLabeledField("Start Billing From (YYYY-MM)", billingStartDate);
        addLabeledField("Occupation", occupation);
        addLabeledField("Mess", mess);
        addLabeledField("Monthly rent", rent);
        addLabeledField("Status", status);
        final String operationId = operationIdFor("tenant");
        addSaveButton(content, "Save tenant", saveButton -> {
            JSONObject payload = new JSONObject();
            putRequestId(payload, operationId);
            put(payload, "name", name);
            put(payload, "phone", phone);
            put(payload, "floor", floor);
            put(payload, "room", room);
            put(payload, "joinDate", joinDate);
            put(payload, "billingStartDate", billingStartDate);
            put(payload, "occupation", occupation);
            put(payload, "mess", mess);
            put(payload, "rent", rent);
            put(payload, "status", status);
            submit("addTenant", payload, "Tenant", saveButton, () -> { saveButton.setEnabled(true); saveButton.setText("Save tenant"); });
        });
    }

    private void showPaymentHistory() {
        beginPage("Payment history", true);
        LinearLayout results = new LinearLayout(this);
        results.setOrientation(LinearLayout.VERTICAL);
        content.addView(results);
        loadData(response -> {
            data = response;
            results.removeAllViews();
            JSONArray payments = response.optJSONArray("payments");
            if (payments == null || payments.length() == 0) {
                results.addView(text("No payments recorded.", 15, false, MUTED));
                return;
            }
            for (int i = 0; i < payments.length(); i++) {
                JSONObject payment = payments.optJSONObject(i);
                if (payment == null) {
                    continue;
                }
                String amount = money(payment.optDouble("amount", 0));
                String month = payment.optString("month", "");
                LinearLayout paymentCard = (LinearLayout) card(
                        payment.optString("tenantName", "Tenant") + "  •  " + amount,
                        "Month: " + month + "  •  Date: " + payment.optString("date", ""));
                String note = payment.optString("note", "");
                if (!note.isEmpty()) {
                    TextView noteView = text(note, 13, false, MUTED);
                    LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    noteParams.topMargin = dp(4);
                    paymentCard.addView(noteView, noteParams);
                }
                Button deleteButton = smallDeleteButton("Delete");
                deleteButton.setOnClickListener(view -> confirmDeletePayment(
                        payment.optString("id"), amount, month));
                paymentCard.addView(deleteButton);
                results.addView(paymentCard);
            }
        });
    }

    private void confirmDeleteTenant(JSONObject tenant) {
        String tenantId = tenant.optString("id", "");
        String name = tenant.optString("name", "this tenant");
        new android.app.AlertDialog.Builder(this)
                .setMessage("Are you sure you want to delete " + name
                        + "? This will remove them from the active list but keep their historical payments for your records.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Delete", (dialog, which) -> api.deleteTenant(tenantId,
                        new ApiClient.Callback() {
                            @Override
                            public void onSuccess(JSONObject result) {
                                showTenants();
                                showUndoSnackbar("Tenant deleted", () -> api.restoreTenant(tenantId,
                                        new ApiClient.Callback() {
                                            @Override public void onSuccess(JSONObject restored) {
                                                showTenants();
                                                Toast.makeText(MainActivity.this, "Tenant restored.", Toast.LENGTH_SHORT).show();
                                            }
                                            @Override public void onError(String message) { showError(message); }
                                        }));
                            }

                            @Override
                            public void onError(String message) {
                                showError(message);
                            }
                        }))
                .show();
    }

    private void confirmDeletePayment(String paymentId, String amount, String month) {
        new android.app.AlertDialog.Builder(this)
                .setMessage("Are you sure you want to delete this payment of " + amount
                        + " for " + month + "? This will increase the tenant's outstanding balance.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Delete", (dialog, which) -> api.deletePayment(paymentId,
                        new ApiClient.Callback() {
                            @Override
                            public void onSuccess(JSONObject result) {
                                showPaymentHistory();
                                showUndoSnackbar("Payment deleted", () -> api.restorePayment(paymentId,
                                        new ApiClient.Callback() {
                                            @Override public void onSuccess(JSONObject restored) {
                                                showPaymentHistory();
                                                Toast.makeText(MainActivity.this, "Payment restored.", Toast.LENGTH_SHORT).show();
                                            }
                                            @Override public void onError(String message) { showError(message); }
                                        }));
                            }

                            @Override
                            public void onError(String message) {
                                showError(message);
                            }
                        }))
                .show();
    }

    private void showUndoSnackbar(String message, Runnable undoAction) {
        Snackbar.make(content, message, Snackbar.LENGTH_LONG)
                .setAction("UNDO", view -> undoAction.run())
                .setActionContentColor(PRIMARY)
                .show();
    }

    private void showAddPayment() {
        beginPage("Record rent", true);
        LinearLayout form = content;
        loadData(response -> {
            data = response;
            JSONArray tenants = response.optJSONArray("tenants");
            TenantChoiceAdapter choices = new TenantChoiceAdapter(tenants);
            Spinner tenant = new Spinner(this);
            tenant.setAdapter(choices);
            EditText month = monthPicker("Rent month", currentMonth());
            EditText amount = field("Amount paid", true);
            EditText date = field("Payment date (YYYY-MM-DD)", false);
            date.setText(today());
            EditText note = field("Note (optional)", false);

            addLabeledField(form, "Tenant", tenant);
            addLabeledField(form, "Month", month);
            addLabeledField(form, "Amount", amount);
            addLabeledField(form, "Date", date);
            addLabeledField(form, "Note", note);
            final String operationId = operationIdFor("payment");
            addSaveButton(form, "Save rent payment", saveButton -> {
                JSONObject payload = new JSONObject();
                putRequestId(payload, operationId);
                TenantChoice choice = (TenantChoice) tenant.getSelectedItem();
                if (choice == null) {
                    saveButton.setEnabled(true);
                    saveButton.setText("Save rent payment");
                    setSaveLoading(saveButton, false);
                    showError("Add a tenant before recording rent.");
                    return;
                }
                try {
                    payload.put("tenantId", choice.id);
                    payload.put("tenantName", choice.name);
                    payload.put("month", month.getText().toString().trim());
                    payload.put("amount", amount.getText().toString().trim());
                    payload.put("date", date.getText().toString().trim());
                    payload.put("note", note.getText().toString().trim());
                } catch (JSONException exception) {
                    saveButton.setEnabled(true);
                    saveButton.setText("Save rent payment");
                    setSaveLoading(saveButton, false);
                    showError("Please check the entered information and try again.");
                    return;
                }
                submit("addPayment", payload, "Rent payment", saveButton, () -> { saveButton.setEnabled(true); saveButton.setText("Save rent payment"); });
            });
        });
    }

    private void showChangeRent() {
        beginPage("Change rent", true);
        loadData(response -> {
            data = response;
            JSONArray tenants = response.optJSONArray("tenants");
            if (tenants == null || tenants.length() == 0) {
                content.addView(card("No tenants", "Add a tenant before changing rent."));
                return;
            }
            TenantChoiceAdapter choices = new TenantChoiceAdapter(tenants);
            Spinner tenant = new Spinner(this);
            tenant.setAdapter(choices);
            TextView currentRent = text("Current rent: --", 14, false, MUTED);
            TextView currentEffectiveMonth = text("Current effective month: --", 14, false, MUTED);
            EditText newRent = field("New monthly rent", true);
            EditText effectiveMonth = monthPicker("Effective month", nextMonth());

            Runnable updateSelectedTenantInfo = () -> {
                TenantChoice choice = (TenantChoice) tenant.getSelectedItem();
                if (choice == null) {
                    return;
                }
                for (int i = 0; i < tenants.length(); i++) {
                    JSONObject candidate = tenants.optJSONObject(i);
                    if (candidate == null || !choice.id.equals(candidate.optString("id"))) {
                        continue;
                    }
                    JSONArray rentHistory = candidate.optJSONArray("rentHistory");
                    JSONObject lastEntry = null;
                    if (rentHistory != null && rentHistory.length() > 0) {
                        lastEntry = rentHistory.optJSONObject(rentHistory.length() - 1);
                    }
                    String joinMonth = candidate.optString("joinDate", "");
                    String currentMonthLabel = (lastEntry != null && lastEntry.has("effectiveMonth")
                            ? lastEntry.optString("effectiveMonth")
                            : (joinMonth.length() >= 7 ? joinMonth.substring(0, 7) : joinMonth));
                    double currentRentValue = lastEntry != null && lastEntry.has("amount")
                            ? lastEntry.optDouble("amount", candidate.optDouble("rent", 0))
                            : candidate.optDouble("rent", 0);
                    currentRent.setText("Current rent: " + money(currentRentValue));
                    currentEffectiveMonth.setText("Current effective month: " + currentMonthLabel);
                    if (newRent.getText().toString().trim().isEmpty()) {
                        newRent.setText(String.valueOf((long) currentRentValue));
                    }
                    return;
                }
            };
            tenant.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
                @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                    updateSelectedTenantInfo.run();
                }
                @Override public void onNothingSelected(android.widget.AdapterView<?> parent) { }
            });

            addLabeledField("Tenant", tenant);
            content.addView(currentRent);
            content.addView(currentEffectiveMonth);
            addLabeledField("New monthly rent", newRent);
            addLabeledField("Effective month", effectiveMonth);

            final String operationId = operationIdFor("rentChange");
            addSaveButton(content, "Save rent change", saveButton -> {
                JSONObject payload = new JSONObject();
                putRequestId(payload, operationId);
                TenantChoice choice = (TenantChoice) tenant.getSelectedItem();
                if (choice == null) {
                    saveButton.setEnabled(true);
                    saveButton.setText("Save rent change");
                    setSaveLoading(saveButton, false);
                    showError("Add a tenant before changing rent.");
                    return;
                }
                try {
                    payload.put("tenantId", choice.id);
                    payload.put("effectiveMonth", effectiveMonth.getText().toString().trim());
                    payload.put("newAmount", newRent.getText().toString().trim());
                } catch (JSONException exception) {
                    saveButton.setEnabled(true);
                    saveButton.setText("Save rent change");
                    setSaveLoading(saveButton, false);
                    showError("Please check the entered information and try again.");
                    return;
                }
                submit("changeRent", payload, "Rent change", saveButton, () -> {
                    saveButton.setEnabled(true);
                    saveButton.setText("Save rent change");
                });
            });
            updateSelectedTenantInfo.run();
        });
    }

    private void showAddExpense() {
        beginPage("Record expense", true);
        EditText date = field("Date (YYYY-MM-DD)", false);
        date.setText(today());
        EditText amount = field("Amount", true);
        Spinner category = spinner(new String[]{"Food", "Electricity", "Water", "Repairs", "Salary", "Internet", "Misc"});
        EditText note = field("Note (optional)", false);
        addLabeledField("Date", date);
        addLabeledField("Amount", amount);
        addLabeledField("Category", category);
        addLabeledField("Note", note);
        final String operationId = operationIdFor("expense");
        addSaveButton(content, "Save expense", saveButton -> {
            JSONObject payload = new JSONObject();
            putRequestId(payload, operationId);
            try {
                payload.put("date", date.getText().toString().trim());
                payload.put("amount", amount.getText().toString().trim());
                payload.put("category", category.getSelectedItem().toString());
                payload.put("note", note.getText().toString().trim());
            } catch (JSONException exception) {
                saveButton.setEnabled(true);
                saveButton.setText("Save expense");
                setSaveLoading(saveButton, false);
                showError("Please check the entered information and try again.");
                return;
            }
            submit("addExpense", payload, "Expense", saveButton, () -> { saveButton.setEnabled(true); saveButton.setText("Save expense"); });
        });
    }

    private void showUnpaid() {
        beginPage("Unpaid list", true);
        LinearLayout list = content;
        TextView help = text("Outstanding rent is calculated using each tenant's historical rent, applied to the months it was actually in effect.", 14, false, MUTED);
        list.addView(help);
        loadData(response -> {
            data = response;
            JSONArray unpaid = response.optJSONArray("unpaid");
            if (unpaid == null || unpaid.length() == 0) {
                list.addView(card("All paid", "No rent is currently outstanding."));
                return;
            }
            for (int i = 0; i < unpaid.length(); i++) {
                JSONObject item = unpaid.optJSONObject(i);
                if (item != null) {
                    String details = money(item.optDouble("amountDue", 0)) + " owed • "
                            + item.optInt("monthsDue", 0) + " unpaid month(s)";
                    list.addView(card(item.optString("name") + " • Room " + item.optString("room"), details));
                }
            }
        });
    }

    private void showRooms() {
        beginPage("Manage rooms", true);
        LinearLayout screenContent = content;
        EditText floor = field("Floor", false);
        EditText room = field("Room number", false);
        EditText capacity = field("Bed capacity", true);
        addLabeledField(screenContent, "Floor", floor);
        addLabeledField(screenContent, "Room", room);
        addLabeledField(screenContent, "Capacity", capacity);
        addSaveButton(screenContent, "Add room", saveButton -> {
            JSONObject payload = new JSONObject();
            try {
                String floorValue = floor.getText().toString().trim();
                String roomValue = room.getText().toString().trim();
                payload.put("floor", floorValue);
                payload.put("room", roomValue);
                payload.put("capacity", capacity.getText().toString().trim());
                putRequestId(payload, floorValue + "_" + roomValue);
            } catch (JSONException exception) {
                saveButton.setEnabled(true);
                saveButton.setText("Add room");
                setSaveLoading(saveButton, false);
                showError("Please check the entered information and try again.");
                return;
            }
            submit("addRoom", payload, "Room", saveButton, () -> { saveButton.setEnabled(true); saveButton.setText("Add room"); });
        });
        screenContent.addView(text("Rooms", 19, true, INK));
        loadData(response -> {
            data = response;
            JSONArray rooms = response.optJSONArray("rooms");
            if (rooms == null || rooms.length() == 0) {
                screenContent.addView(text("No rooms registered.", 15, false, MUTED));
                return;
            }
            for (int i = 0; i < rooms.length(); i++) {
                JSONObject item = rooms.optJSONObject(i);
                if (item != null) {
                    screenContent.addView(card("Floor " + item.optString("floor") + " • Room " + item.optString("room"),
                            item.optString("capacity") + " bed(s)"));
                }
            }
        });
    }

    private void submit(String action, JSONObject payload, String recordLabel, Button saveButton, Runnable onFailure) {
        saveButton.setEnabled(false);
        saveButton.setText("Saving…");
        setSaveLoading(saveButton, true);
        updateSyncingIndicator();
        api.post(action, payload, new ApiClient.Callback() {
            private boolean localResultShown;

            @Override
            public void onSuccess(JSONObject result) {
                localResultShown = true;
                boolean pending = result.optBoolean("pending", true);
                if (pending) {
                    Toast.makeText(MainActivity.this,
                            "Saved locally (Pending Sync). Will sync when online.", Toast.LENGTH_LONG).show();
                    saveButton.setText("Pending sync…");
                    setSaveLoading(saveButton, false);

                    // Phase 3 final: clear the operationId so the next save in this form gets a fresh UUID.
                    operationIds.remove(formKeyFor(action));

                    // Phase 2.6: conditional Back to Home button inside the form only when pending.
                    if (saveButton.getParent() instanceof LinearLayout) {
                        LinearLayout form = (LinearLayout) saveButton.getParent();
                        boolean hasBackButton = false;
                        for (int i = 0; i < form.getChildCount(); i++) {
                            View child = form.getChildAt(i);
                            if (TAG_PENDING_BACK.equals(child.getTag())) {
                                hasBackButton = true;
                                break;
                            }
                        }
                        if (!hasBackButton) {
                            Button backButton = new Button(MainActivity.this);
                            backButton.setText("Back to Home");
                            backButton.setAllCaps(false);
                            backButton.setTag(TAG_PENDING_BACK);
                            backButton.setOnClickListener(v -> showHome());
                            LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(
                                    ViewGroup.LayoutParams.MATCH_PARENT,
                                    ViewGroup.LayoutParams.WRAP_CONTENT);
                            backParams.topMargin = dp(8);
                            form.addView(backButton, backParams);
                        }
                    }
                } else {
                    Toast.makeText(MainActivity.this, recordLabel + " saved to cloud successfully.", Toast.LENGTH_SHORT).show();
                    operationIds.remove(formKeyFor(action));
                    showHome();
                }
            }

            @Override
            public void onSynced(JSONObject result) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    updateConnectionIndicator();
                    operationIds.remove(formKeyFor(action));
                    Toast.makeText(MainActivity.this, recordLabel + " synced to cloud successfully.",
                            Toast.LENGTH_SHORT).show();
                });
            }

            @Override
            public void onError(String message) {
                runOnUiThread(() -> {
                    onFailure.run();
                    setSaveLoading(saveButton, false);
                    updateConnectionIndicator();
                    showError(message);
                });
            }
        });
    }

    private String formKeyFor(String action) {
        switch (action) {
            case "addTenant": return "tenant";
            case "addPayment": return "payment";
            case "addExpense": return "expense";
            case "addRoom": return "room";
            default: return action;
        }
    }

    private void updateSyncingIndicator() {
        if (connectionIndicator != null) connectionIndicator.setText("Syncing…");
    }

    private void updateConnectionIndicator() {
        if (connectionIndicator == null) return;
        android.net.ConnectivityManager manager =
                (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        boolean connected = false;
        if (manager != null) {
            android.net.Network network = manager.getActiveNetwork();
            android.net.NetworkCapabilities capabilities = network == null ? null
                    : manager.getNetworkCapabilities(network);
            connected = capabilities != null && (capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    || capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)
                    || capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET));
        }
        connectionIndicator.setText(connected ? "Online" : "Offline");
        connectionIndicator.setTextColor(connected ? Color.rgb(22, 101, 52) : Color.rgb(185, 28, 28));
    }

    private void loadData(DataHandler handler) {
        if (!api.isConfigured()) {
            showError("Your hostel profile is unavailable. Sign out and sign in again.");
            return;
        }
        api.post("getData", new JSONObject(), new ApiClient.Callback() {
            @Override
            public void onSuccess(JSONObject result) {
                handler.onData(result);
            }

            @Override
            public void onError(String message) {
                showError(message);
            }
        });
    }

    private interface DataHandler {
        void onData(JSONObject result);
    }

    private void beginPage(String title, boolean showBack) {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(BACKGROUND);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(10), dp(16), dp(10));
        header.setBackgroundColor(WHITE);
        if (showBack) {
            Button back = new Button(this);
            back.setText("Back");
            back.setAllCaps(false);
            back.setTextColor(PRIMARY);
            back.setMinHeight(dp(48));
            back.setBackground(roundRect(BACKGROUND, dp(12), BORDER));
            back.setOnClickListener(view -> showHome());
            header.addView(back, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }
        TextView heading = text(title, 20, true, INK);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        headingParams.leftMargin = dp(showBack ? 8 : 0);
        headingParams.rightMargin = dp(8);
        header.addView(heading, headingParams);
        connectionIndicator = text("Checking…", 12, true, MUTED);
        connectionIndicator.setGravity(Gravity.CENTER);
        connectionIndicator.setPadding(dp(10), dp(7), dp(10), dp(7));
        connectionIndicator.setBackground(roundRect(BACKGROUND, dp(16), BORDER));
        header.addView(connectionIndicator, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        updateConnectionIndicator();
        header.setOnApplyWindowInsetsListener((view, insets) -> {
            header.setPadding(dp(16), dp(10) + insets.getSystemWindowInsetTop(),
                    dp(16), dp(10));
            return insets;
        });
        page.addView(header);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(16), dp(20), dp(16), dp(80));
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            content.setPadding(dp(16), dp(20), dp(16),
                    dp(80) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        scroll.addView(content);
        page.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(page);
    }

    private void addLabeledField(String label, View input) {
        addLabeledField(content, label, input);
    }

    private void addLabeledField(LinearLayout parent, String label, View input) {
        TextView caption = text(label, 14, true, INK);
        LinearLayout.LayoutParams captionParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        captionParams.topMargin = dp(14);
        parent.addView(caption, captionParams);
        if (input instanceof EditText) {
            EditText editText = (EditText) input;
            editText.setPadding(dp(12), dp(8), dp(12), dp(8));
            editText.setMinHeight(dp(52));
            editText.setTextColor(INK);
            editText.setHintTextColor(MUTED);
            editText.setBackground(roundRect(WHITE, dp(12), BORDER));
        } else if (input instanceof Spinner) {
            input.setBackground(roundRect(WHITE, dp(12), BORDER));
            input.setMinimumHeight(dp(52));
            input.setPadding(dp(10), 0, dp(10), 0);
        }
        parent.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    private EditText field(String hint, boolean numeric) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setTextColor(INK);
        input.setHintTextColor(MUTED);
        input.setPadding(dp(12), dp(8), dp(12), dp(8));
        input.setMinHeight(dp(52));
        input.setBackground(roundRect(WHITE, dp(12), BORDER));
        if (numeric) {
            input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER
                    | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL);
        } else if (hint.toLowerCase(Locale.ROOT).contains("phone")) {
            input.setInputType(android.text.InputType.TYPE_CLASS_PHONE);
        }
        return input;
    }

    private EditText monthPicker(String label, String initialMonth) {
        EditText input = field(label, false);
        input.setText(initialMonth);
        input.setFocusable(false);
        input.setFocusableInTouchMode(false);
        input.setContentDescription(label + ". Tap to choose a month.");
        input.setOnClickListener(view -> {
            Calendar calendar = Calendar.getInstance();
            try {
                YearMonth selected = YearMonth.parse(input.getText().toString());
                calendar.set(selected.getYear(), selected.getMonthValue() - 1, 1);
            } catch (RuntimeException ignored) {
                calendar.setTime(new Date());
            }
            DatePickerDialog picker = new DatePickerDialog(this,
                    (datePicker, year, month, day) -> input.setText(String.format(
                            Locale.US, "%04d-%02d", year, month + 1)),
                    calendar.get(Calendar.YEAR),
                    calendar.get(Calendar.MONTH),
                    calendar.get(Calendar.DAY_OF_MONTH));
            picker.show();
        });
        return input;
    }

    private Spinner spinner(String[] options) {
        Spinner spinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(
                this, android.R.layout.simple_spinner_item, options);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        return spinner;
    }

    private void addButton(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setContentDescription(label);
        button.setAllCaps(false);
        button.setTextColor(WHITE);
        button.setMinHeight(dp(50));
        button.setPadding(dp(16), dp(10), dp(16), dp(10));
        button.setBackground(roundRect(PRIMARY, dp(14), PRIMARY));
        button.setOnClickListener(view -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        parent.addView(button, params);
    }

    private interface SaveAction { void run(Button button); }

    private void addSaveButton(LinearLayout parent, String label, SaveAction action) {
        Button button = new Button(this);
        button.setText(label);
        button.setContentDescription(label);
        button.setAllCaps(false);
        button.setTextColor(WHITE);
        button.setMinHeight(dp(52));
        button.setBackground(roundRect(PRIMARY, dp(14), PRIMARY));
        android.widget.ProgressBar spinner = new android.widget.ProgressBar(this);
        spinner.setIndeterminate(true);
        spinner.setVisibility(View.GONE);
        saveSpinners.put(button, spinner);
        button.setOnClickListener(view -> {
            if (!button.isEnabled()) return;
            button.setEnabled(false);
            button.setText("Saving…");
            setSaveLoading(button, true);
            action.run(button);
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        parent.addView(button, params);
        LinearLayout.LayoutParams spinnerParams = new LinearLayout.LayoutParams(
                dp(28), dp(28));
        spinnerParams.gravity = Gravity.CENTER_HORIZONTAL;
        parent.addView(spinner, spinnerParams);
        // Phase 2.6: unconditional "Back to Home" button removed.
    }

    private void setSaveLoading(Button button, boolean loading) {
        android.widget.ProgressBar spinner = saveSpinners.get(button);
        if (spinner != null) spinner.setVisibility(loading ? View.VISIBLE : View.GONE);
    }

    private View card(String title, String subtitle) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        card.setBackground(roundRect(WHITE, dp(16), BORDER));
        card.setElevation(dp(1));
        TextView titleView = text(title, 16, true, INK);
        TextView subtitleView = text(subtitle, 14, false, MUTED);
        subtitleView.setLineSpacing(dp(2), 1f);
        card.addView(titleView);
        card.addView(subtitleView);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(10);
        card.setLayoutParams(params);
        return card;
    }

    private void addSectionTitle(LinearLayout parent, String title) {
        TextView heading = text(title, 18, true, INK);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(22);
        params.bottomMargin = dp(8);
        parent.addView(heading, params);
    }

    private LinearLayout dashboardRow(LinearLayout parent) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        parent.addView(row, params);
        return row;
    }

    private void addDashboardMetric(LinearLayout row, String label, String value, boolean primary) {
        LinearLayout metric = new LinearLayout(this);
        metric.setOrientation(LinearLayout.VERTICAL);
        metric.setGravity(Gravity.CENTER_VERTICAL);
        metric.setPadding(dp(14), dp(14), dp(14), dp(14));
        int background = primary ? PRIMARY : WHITE;
        int titleColor = primary ? Color.rgb(232, 242, 255) : MUTED;
        int valueColor = primary ? WHITE : INK;
        metric.setBackground(roundRect(background, dp(16), primary ? PRIMARY : BORDER));
        metric.setElevation(dp(1));

        TextView labelView = text(label, 13, true, titleColor);
        TextView valueView = text(value, primary ? 19 : 18, true, valueColor);
        valueView.setMaxLines(2);
        valueView.setBreakStrategy(android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY);
        LinearLayout.LayoutParams valueParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        valueParams.topMargin = dp(8);
        metric.addView(labelView);
        metric.addView(valueView, valueParams);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, row.getOrientation() == LinearLayout.HORIZONTAL ? 1 : 0);
        if (row.getChildCount() > 0 && row.getOrientation() == LinearLayout.HORIZONTAL) {
            params.leftMargin = dp(8);
        }
        if (row.getOrientation() == LinearLayout.VERTICAL) {
            params.width = ViewGroup.LayoutParams.MATCH_PARENT;
            params.height = ViewGroup.LayoutParams.WRAP_CONTENT;
            params.topMargin = dp(8);
        }
        row.addView(metric, params);
    }

    private void addActionRow(LinearLayout parent, String firstLabel, Runnable firstAction,
            String secondLabel, Runnable secondAction) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rowParams.topMargin = dp(8);
        parent.addView(row, rowParams);
        addActionButton(row, firstLabel, firstAction, false);
        addActionButton(row, secondLabel, secondAction, true);
    }

    private void addActionButton(LinearLayout row, String label, Runnable action, boolean withGap) {
        Button button = new Button(this);
        button.setText(label);
        button.setContentDescription(label);
        button.setAllCaps(false);
        button.setTextColor(PRIMARY);
        button.setTextSize(14);
        button.setMinHeight(dp(52));
        button.setPadding(dp(8), dp(8), dp(8), dp(8));
        button.setBackground(roundRect(WHITE, dp(14), BORDER));
        button.setOnClickListener(view -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        if (withGap) {
            params.leftMargin = dp(8);
        }
        row.addView(button, params);
    }

    private Button smallDeleteButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setContentDescription(label);
        button.setAllCaps(false);
        button.setTextColor(Color.rgb(185, 28, 28));
        button.setMinHeight(dp(44));
        button.setBackground(roundRect(WHITE, dp(12), BORDER));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        button.setLayoutParams(params);
        return button;
    }

    private View tenantCard(JSONObject tenant) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setPadding(dp(16), dp(14), dp(16), dp(14));
        item.setBackground(roundRect(WHITE, dp(16), BORDER));
        item.setElevation(dp(1));

        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView name = text(tenant.optString("name"), 16, true, INK);
        titleRow.addView(name, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        String status = tenant.optString("status");
        TextView statusView = text(status, 12, true,
                "Active".equalsIgnoreCase(status) ? Color.rgb(22, 101, 52) : MUTED);
        statusView.setPadding(dp(9), dp(5), dp(9), dp(5));
        statusView.setBackground(roundRect(
                "Active".equalsIgnoreCase(status) ? Color.rgb(220, 252, 231) : PALE,
                dp(12), Color.TRANSPARENT));
        titleRow.addView(statusView);

        TextView room = text("Room " + tenant.optString("room") + "  ·  "
                + money(tenant.optDouble("rent", 0)), 14, true, INK);
        TextView phone = text(tenant.optString("phone"), 13, false, MUTED);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        detailParams.topMargin = dp(8);
        item.addView(titleRow);
        item.addView(room, detailParams);
        LinearLayout.LayoutParams phoneParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        phoneParams.topMargin = dp(3);
        item.addView(phone, phoneParams);
        LinearLayout.LayoutParams itemParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        itemParams.topMargin = dp(10);
        item.setLayoutParams(itemParams);
        return item;
    }

    private GradientDrawable roundRect(int fill, int radius, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(radius);
        if (stroke != Color.TRANSPARENT) {
            drawable.setStroke(dp(1), stroke);
        }
        return drawable;
    }

    private String totalValue(JSONObject totals, String key) {
        if (totals == null || !totals.has(key) || totals.isNull(key)) {
            return "Unavailable";
        }
        double value = totals.optDouble(key, Double.NaN);
        return Double.isNaN(value) || Double.isInfinite(value) ? "Unavailable" : money(value);
    }

    private double totalUnpaid(JSONArray unpaid) {
        double total = 0;
        for (int i = 0; i < unpaid.length(); i++) {
            JSONObject item = unpaid.optJSONObject(i);
            if (item != null && item.has("amountDue") && !item.isNull("amountDue")) {
                total += item.optDouble("amountDue", 0);
            }
        }
        return total;
    }

    private String occupancySummary(JSONArray tenants, JSONArray rooms) {
        if (tenants == null || rooms == null) {
            return "Unavailable";
        }
        int capacity = 0;
        for (int i = 0; i < rooms.length(); i++) {
            JSONObject room = rooms.optJSONObject(i);
            if (room != null) {
                capacity += room.optInt("capacity", 0);
            }
        }
        return capacity > 0 ? activeTenantCount(tenants) + " / " + capacity + " beds"
                : "No bed capacity";
    }

    private String greeting() {
        int hour = Integer.parseInt(new SimpleDateFormat("H", Locale.US).format(new Date()));
        if (hour < 12) return "Good morning";
        if (hour < 17) return "Good afternoon";
        return "Good evening";
    }

    private TextView text(String value, int size, boolean bold, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        }
        return view;
    }

    private void putRequestId(JSONObject object, String requestId) {
        try {
            object.put("requestId", requestId);
        } catch (JSONException exception) {
            showError("Could not prepare the record. Please try again.");
        }
    }

    private void put(JSONObject object, String key, EditText input) {
        try {
            object.put(key, input.getText().toString().trim());
        } catch (JSONException exception) {
            showError("Please check the entered information and try again.");
        }
    }

    private void put(JSONObject object, String key, Spinner spinner) {
        try {
            object.put(key, spinner.getSelectedItem().toString());
        } catch (JSONException exception) {
            showError("Please check the entered information and try again.");
        }
    }

    private void showError(String message) {
        Toast.makeText(this, message == null ? "Unexpected error." : message, Toast.LENGTH_LONG).show();
    }

    private int activeTenantCount(JSONArray tenants) {
        int count = 0;
        if (tenants != null) {
            for (int i = 0; i < tenants.length(); i++) {
                JSONObject tenant = tenants.optJSONObject(i);
                if (tenant != null && "Active".equalsIgnoreCase(tenant.optString("status"))) {
                    count++;
                }
            }
        }
        return count;
    }

    private String money(double amount) {
        return String.format(Locale.getDefault(), "Rs. %,.2f", amount);
    }

    private String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private String currentMonth() {
        return new SimpleDateFormat("yyyy-MM", Locale.US).format(new Date());
    }

    private String nextMonth() {
        return java.time.YearMonth.now().plusMonths(1).toString();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private static final class TenantChoice {
        final String id;
        final String name;

        TenantChoice(String id, String name) {
            this.id = id;
            this.name = name;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    private final class TenantChoiceAdapter extends ArrayAdapter<TenantChoice> {
        TenantChoiceAdapter(JSONArray tenants) {
            super(MainActivity.this, android.R.layout.simple_spinner_item);
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
            if (tenants != null) {
                for (int i = 0; i < tenants.length(); i++) {
                    JSONObject tenant = tenants.optJSONObject(i);
                    if (tenant != null && "Active".equalsIgnoreCase(tenant.optString("status"))) {
                        add(new TenantChoice(tenant.optString("id"), tenant.optString("name")));
                    }
                }
            }
        }
    }
}