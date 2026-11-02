package com.hostelmanager;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.QuerySnapshot;
import com.google.firebase.firestore.DocumentReference;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.regex.Pattern;

final class ApiClient {
    interface Callback {
        void onSuccess(JSONObject result);
        void onError(String message);
        default void onSynced(JSONObject result) { }
    }

    private static final Pattern DATE_PATTERN = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern MONTH_PATTERN = Pattern.compile("\\d{4}-(0[1-9]|1[0-2])");
    private static final DateTimeFormatter ISO_MILLIS_UTC =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
                    .withZone(ZoneOffset.UTC);

    private final String hostelId;
    private final FirebaseFirestore firestore;

    ApiClient(String hostelId) {
        this.hostelId = hostelId == null ? "" : hostelId.trim();
        this.firestore = FirebaseFirestore.getInstance();
    }

    boolean isConfigured() {
        return !hostelId.isEmpty()
                && FirebaseAuth.getInstance().getCurrentUser() != null
                && hostelId.equals(FirebaseAuth.getInstance().getCurrentUser().getUid());
    }

    void deleteTenant(String tenantId, Callback callback) {
        if (!isNetworkAvailable()) {
            deleteDocument("Tenants", tenantId, callback);
            return;
        }
        changeTenantOccupancyAndDelete(tenantId, false, callback);
    }

    void deletePayment(String paymentId, Callback callback) {
        deleteDocument("Payments", paymentId, callback);
    }

    void restoreTenant(String tenantId, Callback callback) {
        if (!isNetworkAvailable()) {
            restoreDocument("Tenants", tenantId, callback);
            return;
        }
        changeTenantOccupancyAndDelete(tenantId, true, callback);
    }

    void restorePayment(String paymentId, Callback callback) {
        restoreDocument("Payments", paymentId, callback);
    }

    private void deleteDocument(String collection, String documentId, Callback callback) {
        if (!isConfigured()) {
            callback.onError("Your sign-in or hostel profile is missing. Sign in again to continue.");
            return;
        }
        if (documentId == null || documentId.trim().isEmpty()) {
            callback.onError("The record could not be identified. Refresh the list and try again.");
            return;
        }
        String timestamp = timestampNow();
        firestore.collection("hostels").document(hostelId).collection(collection)
                .document(documentId.trim()).update(
                        "deletedAt", timestamp,
                        "updatedAt", timestamp)
                .addOnSuccessListener(unused -> {
                    JSONObject result = new JSONObject();
                    try {
                        result.put("ok", true);
                        result.put("id", documentId.trim());
                        callback.onSuccess(result);
                    } catch (JSONException exception) {
                        callback.onError("The record was deleted, but the result could not be prepared.");
                    }
                })
                .addOnFailureListener(error -> callback.onError(errorMessage(error)));
    }

    private void restoreDocument(String collection, String documentId, Callback callback) {
        if (!isConfigured() || documentId == null || documentId.trim().isEmpty()) {
            callback.onError("The record could not be restored.");
            return;
        }
        firestore.collection("hostels").document(hostelId).collection(collection)
                .document(documentId.trim()).update(
                        "deletedAt", com.google.firebase.firestore.FieldValue.delete(),
                        "updatedAt", timestampNow())
                .addOnSuccessListener(unused -> {
                    JSONObject result = new JSONObject();
                    try {
                        result.put("ok", true);
                        result.put("id", documentId.trim());
                        callback.onSuccess(result);
                    } catch (JSONException exception) {
                        callback.onError("The record was restored, but the result could not be prepared.");
                    }
                })
                .addOnFailureListener(error -> callback.onError(errorMessage(error)));
    }

    private void changeTenantOccupancyAndDelete(String tenantId, boolean restore, Callback callback) {
        if (tenantId == null || tenantId.trim().isEmpty()) {
            callback.onError("The tenant could not be identified.");
            return;
        }
        String normalizedId = tenantId.trim();
        com.google.firebase.firestore.CollectionReference tenants =
                firestore.collection("hostels").document(hostelId).collection("Tenants");
        DocumentReference tenantRef = tenants.document(normalizedId);
        tenantRef.get().addOnSuccessListener(tenantSnapshot -> {
            if (!tenantSnapshot.exists()) {
                callback.onError("This tenant no longer exists.");
                return;
            }
            String floor = tenantSnapshot.getString("floor");
            String room = tenantSnapshot.getString("room");
            boolean active = "Active".equals(tenantSnapshot.getString("status"));
            if (!active || floor == null || room == null) {
                updateTenantTombstone(tenantRef, normalizedId, restore, null, null, callback);
                return;
            }
            com.google.firebase.firestore.CollectionReference rooms =
                    firestore.collection("hostels").document(hostelId).collection("Rooms");
            rooms.whereEqualTo("floor", floor).whereEqualTo("room", room).get()
                    .addOnSuccessListener(roomMatches -> {
                        DocumentReference roomRef = roomMatches.isEmpty()
                                ? null : roomMatches.getDocuments().get(0).getReference();
                        tenants.whereEqualTo("floor", floor).whereEqualTo("room", room)
                                .whereEqualTo("status", "Active").get()
                                .addOnSuccessListener(roomTenants -> {
                                    List<String> legacyOccupants = new ArrayList<>();
                                    for (DocumentSnapshot document : roomTenants.getDocuments()) {
                                        if (!document.contains("deletedAt")) legacyOccupants.add(document.getId());
                                    }
                                    updateTenantTombstone(tenantRef, normalizedId, restore, roomRef, legacyOccupants, callback);
                                })
                                .addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
                    })
                    .addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
        }).addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
    }

    private void updateTenantTombstone(DocumentReference tenantRef, String tenantId, boolean restore,
            DocumentReference roomRef, List<String> legacyOccupants, Callback callback) {
        firestore.runTransaction(transaction -> {
            DocumentSnapshot tenant = transaction.get(tenantRef);
            if (!tenant.exists()) throw new IllegalArgumentException("This tenant no longer exists.");
            boolean active = "Active".equals(tenant.getString("status"));
            DocumentSnapshot room = roomRef == null ? null : transaction.get(roomRef);
            if (restore && active && roomRef == null) {
                throw new IllegalArgumentException("Register the tenant's room before restoring this tenant.");
            }
            List<String> occupants = new ArrayList<>();
            if (room != null && room.exists()) {
                Object saved = room.get("occupiedTenantIds");
                if (saved instanceof List) {
                    for (Object value : (List<?>) saved) {
                        if (value instanceof String) occupants.add((String) value);
                    }
                } else if (legacyOccupants != null) {
                    occupants.addAll(legacyOccupants);
                }
            }
            if (restore && active && !occupants.contains(tenantId)) {
                long capacity = room == null || room.getLong("capacity") == null ? 0 : room.getLong("capacity");
                if (occupants.size() >= capacity) {
                    throw new com.google.firebase.firestore.FirebaseFirestoreException(
                            "This room has reached its registered bed capacity.",
                            com.google.firebase.firestore.FirebaseFirestoreException.Code.FAILED_PRECONDITION);
                }
                occupants.add(tenantId);
            }
            if (!restore) occupants.remove(tenantId);
            String timestamp = timestampNow();
            if (room != null && room.exists() && (active || restore)) {
                transaction.update(roomRef, "occupiedTenantIds", occupants, "updatedAt", timestamp);
            }
            if (restore) {
                transaction.update(tenantRef, "deletedAt",
                        com.google.firebase.firestore.FieldValue.delete(), "updatedAt", timestamp);
            } else {
                transaction.update(tenantRef, "deletedAt", timestamp, "updatedAt", timestamp);
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("id", tenantId);
            return result;
        }).addOnSuccessListener(callback::onSuccess)
                .addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
    }

    void post(String action, JSONObject fields, Callback callback) {
        if (!isConfigured()) {
            callback.onError("Your sign-in or hostel profile is missing. Sign in again to continue.");
            return;
        }
        if ("getData".equals(action)) {
            loadData(callback);
            return;
        }
        if ("changeRent".equals(action)) {
            changeRent(fields, callback);
            return;
        }

        String collection;
        Map<String, Object> values;
        try {
            collection = collectionFor(action);
            values = valuesFor(action, fields == null ? new JSONObject() : fields);
        } catch (IllegalArgumentException exception) {
            callback.onError(exception.getMessage() == null ? "Please check the entered information." : exception.getMessage());
            return;
        } catch (JSONException exception) {
            callback.onError("Could not read the submitted information. Please reopen the form and try again.");
            return;
        }

        if (!isNetworkAvailable()) {
            saveRecord(collection, values, fields, callback);
            return;
        }
        if ("addTenant".equals(action)) {
            saveTenantWithCapacity(values, fields, callback);
            return;
        }
        if ("addRoom".equals(action)) {
            validateRoomUnique(values, callback, () -> saveRecord(collection, values, fields, callback));
            return;
        }
        saveRecord(collection, values, fields, callback);
    }

    private boolean isNetworkAvailable() {
        android.content.Context context = com.google.firebase.FirebaseApp.getInstance().getApplicationContext();
        android.net.ConnectivityManager manager = (android.net.ConnectivityManager)
                context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        android.net.Network network = manager.getActiveNetwork();
        android.net.NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
        return capabilities != null && (capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                || capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)
                || capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    private void saveRecord(String collection, Map<String, Object> values, JSONObject fields, Callback callback) {
        String requestId = fields == null ? "" : fields.optString("requestId", "").trim();
        boolean validId = "Rooms".equals(collection)
                ? requestId.matches("[A-Za-z0-9_. -]{1,81}") && !".".equals(requestId) && !"..".equals(requestId)
                : requestId.matches("[A-Za-z0-9_-]{16,80}");
        if (!validId || requestId.contains("/")) {
            callback.onError("This record could not be saved safely. Return to the form and try again.");
            return;
        }

        DocumentReference docRef = firestore.collection("hostels").document(hostelId)
                .collection(collection).document(requestId);
        values.put("createdAt", timestampNow());
        values.put("updatedAt", timestampNow());
        com.google.android.gms.tasks.Task<Void> writeTask = docRef.set(values);
        JSONObject localResult = new JSONObject();
        try {
            localResult.put("ok", true);
            localResult.put("id", requestId);
            localResult.put("pending", true);
            callback.onSuccess(localResult);
        } catch (JSONException exception) {
            callback.onError("Could not prepare the saved record.");
            return;
        }

        writeTask.addOnSuccessListener(unused -> {
            JSONObject synced = new JSONObject();
            try {
                synced.put("ok", true);
                synced.put("id", requestId);
                synced.put("pending", false);
                callback.onSynced(synced);
            } catch (JSONException ignored) {
                // Record is saved; avoid false failure.
            }
        }).addOnFailureListener(error -> {
            // Phase 2.6: surface PERMISSION_DENIED clearly instead of masking it.
            if (error instanceof com.google.firebase.firestore.FirebaseFirestoreException
                    && ((com.google.firebase.firestore.FirebaseFirestoreException) error).getCode()
                       == com.google.firebase.firestore.FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                callback.onError("This record already exists and cannot be edited. "
                        + "Return to the form and start a new record, or contact support if this is unexpected.");
                return;
            }
            callback.onError(errorMessage(error));
        });
    }

    private void validateRoomUnique(Map<String, Object> room, Callback callback, Runnable onValid) {
        firestore.collection("hostels").document(hostelId).collection("Rooms")
                .whereEqualTo("floor", String.valueOf(room.get("floor")))
                .whereEqualTo("room", String.valueOf(room.get("room")))
                .get()
                .addOnSuccessListener(snapshot -> {
                    if (!snapshot.isEmpty()) {
                        callback.onError("This room is already registered on that floor.");
                    } else {
                        onValid.run();
                    }
                })
                .addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
    }

    private void saveTenantWithCapacity(Map<String, Object> tenant, JSONObject fields, Callback callback) {
        String floor = String.valueOf(tenant.get("floor"));
        String room = String.valueOf(tenant.get("room"));
        String requestId = fields == null ? "" : fields.optString("requestId", "").trim();
        if (!requestId.matches("[A-Za-z0-9_-]{16,80}")) {
            callback.onError("This record could not be saved safely. Return to the form and try again.");
            return;
        }
        com.google.firebase.firestore.CollectionReference rooms =
                firestore.collection("hostels").document(hostelId).collection("Rooms");
        com.google.firebase.firestore.CollectionReference tenants =
                firestore.collection("hostels").document(hostelId).collection("Tenants");
        rooms.whereEqualTo("floor", floor).whereEqualTo("room", room).get()
                .addOnSuccessListener(roomMatches -> {
                    if (roomMatches.isEmpty()) {
                        callback.onError("Register this room and its bed capacity before assigning a tenant.");
                        return;
                    }
                    if (roomMatches.size() > 1) {
                        callback.onError("More than one cloud room has these labels. Resolve the duplicate room records first.");
                        return;
                    }
                    DocumentReference roomRef = roomMatches.getDocuments().get(0).getReference();
                    tenants.whereEqualTo("floor", floor).whereEqualTo("room", room)
                            .whereEqualTo("status", "Active").get()
                            .addOnSuccessListener(existingTenants -> {
                                List<String> legacyOccupants = new ArrayList<>();
                                for (DocumentSnapshot document : existingTenants.getDocuments()) {
                                    if (!document.contains("deletedAt")) legacyOccupants.add(document.getId());
                                }
                                DocumentReference tenantRef = tenants.document(requestId);
                                tenant.put("createdAt", timestampNow());
                                tenant.put("updatedAt", timestampNow());
                                firestore.runTransaction(transaction -> {
                                    DocumentSnapshot roomSnapshot = transaction.get(roomRef);
                                    DocumentSnapshot tenantSnapshot = transaction.get(tenantRef);
                                    if (!roomSnapshot.exists() || roomSnapshot.contains("deletedAt")) {
                                        throw new com.google.firebase.firestore.FirebaseFirestoreException(
                                                "This room is no longer available.",
                                                com.google.firebase.firestore.FirebaseFirestoreException.Code.FAILED_PRECONDITION);
                                    }
                                    Object rawIds = roomSnapshot.get("occupiedTenantIds");
                                    List<String> occupied = new ArrayList<>();
                                    if (rawIds instanceof List) {
                                        for (Object value : (List<?>) rawIds) {
                                            if (value instanceof String) occupied.add((String) value);
                                        }
                                    } else {
                                        occupied.addAll(legacyOccupants);
                                    }
                                    if (!occupied.contains(requestId)) {
                                        long roomCapacity = roomSnapshot.getLong("capacity") == null
                                                ? 0 : roomSnapshot.getLong("capacity");
                                        if (occupied.size() >= roomCapacity) {
                                            throw new com.google.firebase.firestore.FirebaseFirestoreException(
                                                    "This room has reached its registered bed capacity.",
                                                    com.google.firebase.firestore.FirebaseFirestoreException.Code.FAILED_PRECONDITION);
                                        }
                                        occupied.add(requestId);
                                    }
                                    transaction.update(roomRef, "occupiedTenantIds", occupied,
                                            "updatedAt", timestampNow());
                                    transaction.set(tenantRef, tenant);
                                    JSONObject result = new JSONObject();
                                    result.put("ok", true);
                                    result.put("id", requestId);
                                    result.put("pending", false);
                                    return result;
                                }).addOnSuccessListener(result -> callback.onSuccess(result))
                                        .addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
                            })
                            .addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
                })
                .addOnFailureListener(error -> callback.onError(ErrorMessages.forFirebase(error)));
    }

    private void loadData(Callback callback) {
        com.google.firebase.firestore.CollectionReference root =
                firestore.collection("hostels").document(hostelId).collection("Tenants");
        Task<QuerySnapshot> tenants = root.get();
        Task<QuerySnapshot> payments = firestore.collection("hostels").document(hostelId)
                .collection("Payments").get();
        Task<QuerySnapshot> expenses = firestore.collection("hostels").document(hostelId)
                .collection("Expenses").get();
        Task<QuerySnapshot> rooms = firestore.collection("hostels").document(hostelId)
                .collection("Rooms").get();

        Tasks.whenAllSuccess(tenants, payments, expenses, rooms)
                .addOnSuccessListener(results -> {
                    try {
                        JSONArray invalidRows = new JSONArray();
                        JSONArray tenantRows = rows((QuerySnapshot) results.get(0), "Tenants", invalidRows);
                        JSONArray paymentRows = rows((QuerySnapshot) results.get(1), "Payments", invalidRows);
                        JSONArray expenseRows = rows((QuerySnapshot) results.get(2), "Expenses", invalidRows);
                        JSONArray roomRows = rows((QuerySnapshot) results.get(3), "Rooms", invalidRows);
                        JSONObject result = new JSONObject();
                        result.put("ok", true);
                        result.put("tenants", tenantRows);
                        result.put("payments", paymentRows);
                        result.put("expenses", expenseRows);
                        result.put("rooms", roomRows);
                        result.put("invalidRows", invalidRows);
                        result.put("unpaid", calculateUnpaid(tenantRows, paymentRows));

                        double rentCollected = total(paymentRows, "amount");
                        double totalExpenses = total(expenseRows, "amount");
                        JSONObject totals = new JSONObject();
                        totals.put("rentCollected", rentCollected);
                        totals.put("expenses", totalExpenses);
                        totals.put("balance", rentCollected - totalExpenses);
                        result.put("totals", totals);
                        callback.onSuccess(result);
                    } catch (JSONException | IllegalArgumentException exception) {
                        callback.onError("Could not process the saved hostel data: " + errorMessage(exception));
                    }
                })
                .addOnFailureListener(error -> callback.onError(
                        "Could not load hostel data from Firebase: " + errorMessage(error)));
    }

    private Map<String, Object> valuesFor(String action, JSONObject request) throws JSONException {
        Map<String, Object> values = new HashMap<>();
        switch (action) {
            case "addTenant":
                require(request, "name", "phone", "floor", "room", "joinDate",
                        "occupation", "mess", "rent", "status");
                validateDate(request.getString("joinDate"), "join date");
                String billingStartDate = request.optString("billingStartDate",
                        request.getString("joinDate").substring(0, 7)).trim();
                if (!MONTH_PATTERN.matcher(billingStartDate).matches()) {
                    throw new IllegalArgumentException("Billing start month must use YYYY-MM format.");
                }
                BigDecimal rent = positiveAmount(request.getString("rent"), "monthly rent");
                String status = request.getString("status").trim();
                if (!"Active".equals(status) && !"Inactive".equals(status)) {
                    throw new IllegalArgumentException("Status must be Active or Inactive.");
                }
                copyStringFields(values, request, "name", "phone", "floor", "room",
                        "joinDate", "occupation", "mess", "status");
                values.put("billingStartDate", billingStartDate);
                values.put("rent", rent.doubleValue());
                if (request.has("rentHistory") && !request.isNull("rentHistory")) {
                    JSONArray history = request.optJSONArray("rentHistory");
                    if (history != null) {
                        validateRentHistory(history);
                        values.put("rentHistory", asFirestoreHistory(history));
                    }
                }
                return values;
            case "changeRent":
                require(request, "tenantId", "effectiveMonth", "newAmount");
                String tenantId = request.getString("tenantId").trim();
                String effectiveMonth = request.getString("effectiveMonth").trim();
                if (!MONTH_PATTERN.matcher(effectiveMonth).matches()) {
                    throw new IllegalArgumentException("Effective month must use YYYY-MM format.");
                }
                BigDecimal newAmount = positiveAmount(request.getString("newAmount"), "new monthly rent");
                values.put("tenantId", tenantId);
                values.put("effectiveMonth", effectiveMonth);
                values.put("newAmount", newAmount.doubleValue());
                return values;
            case "addPayment":
                require(request, "tenantId", "tenantName", "month", "amount", "date");
                if (!MONTH_PATTERN.matcher(request.getString("month").trim()).matches()) {
                    throw new IllegalArgumentException("Month must use YYYY-MM format.");
                }
                validateDate(request.getString("date"), "payment date");
                values.put("amount", positiveAmount(request.getString("amount"), "payment amount").doubleValue());
                copyStringFields(values, request, "tenantId", "tenantName", "month", "date");
                values.put("note", request.optString("note", "").trim());
                return values;
            case "addExpense":
                require(request, "date", "amount", "category");
                validateDate(request.getString("date"), "expense date");
                values.put("amount", positiveAmount(request.getString("amount"), "expense amount").doubleValue());
                copyStringFields(values, request, "date", "category");
                values.put("note", request.optString("note", "").trim());
                return values;
            case "addRoom":
                require(request, "floor", "room", "capacity");
                int capacity = positiveInteger(request.getString("capacity"), "bed capacity");
                if (capacity > ValidationLimits.ROOM_CAPACITY) {
                    throw new IllegalArgumentException("Bed capacity cannot exceed "
                            + ValidationLimits.ROOM_CAPACITY + ".");
                }
                copyStringFields(values, request, "floor", "room");
                values.put("capacity", capacity);
                values.put("occupiedTenantIds", new ArrayList<String>());
                return values;
            default:
                throw new IllegalArgumentException("Unknown action.");
        }
    }

    private static String collectionFor(String action) {
        switch (action) {
            case "addTenant":
                return "Tenants";
            case "changeRent":
                return "Tenants";
            case "addPayment":
                return "Payments";
            case "addExpense":
                return "Expenses";
            case "addRoom":
                return "Rooms";
            default:
                throw new IllegalArgumentException("Unknown action.");
        }
    }

    private static void require(JSONObject request, String... fields) throws JSONException {
        for (String field : fields) {
            if (!request.has(field) || request.isNull(field)
                    || request.getString(field).trim().isEmpty()) {
                throw new IllegalArgumentException("Missing required field: " + field);
            }
        }
    }

    private static void copyStringFields(Map<String, Object> values, JSONObject request, String... fields)
            throws JSONException {
        for (String field : fields) {
            String value = request.getString(field).trim();
            int maxLength;
            switch (field) {
                case "note":
                    maxLength = ValidationLimits.NOTE;
                    break;
                case "name":
                    maxLength = ValidationLimits.HOSTEL_NAME;
                    break;
                case "address":
                    maxLength = ValidationLimits.HOSTEL_ADDRESS;
                    break;
                case "phone":
                    maxLength = ValidationLimits.PHONE;
                    break;
                case "category":
                    maxLength = ValidationLimits.CATEGORY;
                    break;
                case "floor":
                case "room":
                    maxLength = "floor".equals(field) ? ValidationLimits.FLOOR : ValidationLimits.ROOM;
                    break;
                case "occupation":
                    maxLength = ValidationLimits.OCCUPATION;
                    break;
                case "mess":
                    maxLength = ValidationLimits.MESS;
                    break;
                case "tenantName":
                    maxLength = ValidationLimits.TENANT_NAME;
                    break;
                default:
                    maxLength = 100;
            }
            if (value.length() > maxLength) {
                throw new IllegalArgumentException(field + " is too long (maximum " + maxLength + " characters).");
            }
            values.put(field, value);
        }
    }

    static boolean isLengthValid(String label, String value, int maxLength) {
        return value == null || value.length() <= maxLength;
    }

    private static void validateDate(String value, String label) {
        String trimmed = value.trim();
        if (!DATE_PATTERN.matcher(trimmed).matches()) {
            throw new IllegalArgumentException(label + " must use YYYY-MM-DD format.");
        }
        try {
            java.time.LocalDate.parse(trimmed);
        } catch (java.time.DateTimeException exception) {
            throw new IllegalArgumentException("Invalid " + label + ".");
        }
    }

    private static double positiveNumber(String value, String label) {
        try {
            double amount = Double.parseDouble(value.trim());
            if (Double.isNaN(amount) || Double.isInfinite(amount) || amount <= 0) {
                throw new NumberFormatException();
            }
            return amount;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(label + " must be a number greater than zero.");
        }
    }

    private static int positiveInteger(String value, String label) {
        try {
            int amount = Integer.parseInt(value.trim());
            if (amount <= 0) {
                throw new NumberFormatException();
            }
            return amount;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(label + " must be a whole number greater than zero.");
        }
    }

    private static JSONArray rows(QuerySnapshot snapshot, String collection, JSONArray invalidRows) throws JSONException {
        JSONArray rows = new JSONArray();
        for (DocumentSnapshot document : snapshot.getDocuments()) {
            Map<String, Object> storedValues = document.getData();
            if (storedValues == null) {
                continue;
            }
            if (storedValues.get("deletedAt") instanceof String) continue;
            String invalidField = invalidMoneyField(collection, storedValues);
            if (invalidField != null) {
                JSONObject warning = new JSONObject();
                warning.put("id", document.getId());
                warning.put("field", invalidField);
                invalidRows.put(warning);
                continue;
            }
            Map<String, Object> values = new HashMap<>(storedValues);
            values.put("id", document.getId());
            rows.put(new JSONObject(values));
        }
        return rows;
    }

    private static String invalidMoneyField(String collection, Map<String, Object> values) {
        if ("Tenants".equals(collection)) {
            try {
                decimalAmount(values.get("rent"), "rent");
            } catch (IllegalArgumentException exception) {
                return "rent";
            }
            Object historyValue = values.get("rentHistory");
            if (historyValue instanceof List) {
                List<?> history = (List<?>) historyValue;
                for (int index = 0; index < history.size(); index++) {
                    Object entry = history.get(index);
                    if (!(entry instanceof Map)
                            || !((Map<?, ?>) entry).containsKey("amount")) {
                        return "rentHistory[" + index + "].amount";
                    }
                    try {
                        decimalAmount(((Map<?, ?>) entry).get("amount"), "rent history");
                    } catch (IllegalArgumentException exception) {
                        return "rentHistory[" + index + "].amount";
                    }
                }
            }
        } else if ("Payments".equals(collection) || "Expenses".equals(collection)) {
            try {
                decimalAmount(values.get("amount"), "amount");
            } catch (IllegalArgumentException exception) {
                return "amount";
            }
        }
        return null;
    }

    private void changeRent(JSONObject fields, Callback callback) {
        JSONObject request = fields == null ? new JSONObject() : fields;
        try {
            Map<String, Object> values = valuesFor("changeRent", request);
            String tenantId = String.valueOf(values.get("tenantId"));
            String effectiveMonth = String.valueOf(values.get("effectiveMonth"));
            BigDecimal newAmount = positiveAmount(String.valueOf(values.get("newAmount")), "new monthly rent");

            DocumentReference tenantRef = firestore.collection("hostels").document(hostelId)
                    .collection("Tenants").document(tenantId);
            firestore.runTransaction(transaction -> {
                try {
                    DocumentSnapshot tenantDoc = transaction.get(tenantRef);
                    if (tenantDoc == null || !tenantDoc.exists()) {
                        throw new IllegalArgumentException("Tenant not found.");
                    }
                    JSONArray history = new JSONArray();
                    Object rawHistory = tenantDoc.get("rentHistory");
                    if (rawHistory instanceof java.util.List) {
                        for (Object item : (java.util.List<?>) rawHistory) {
                            if (item instanceof java.util.Map) {
                                java.util.Map<?, ?> map = (java.util.Map<?, ?>) item;
                                JSONObject entry = new JSONObject();
                                entry.put("effectiveMonth", String.valueOf(map.get("effectiveMonth")));
                                Object amountObj = map.get("amount");
                                entry.put("amount", amountObj instanceof Number
                                        ? ((Number) amountObj).doubleValue()
                                        : Double.parseDouble(String.valueOf(amountObj)));
                                history.put(entry);
                            }
                        }
                    }

                    if (history.length() == 0) {
                        String joinMonth = tenantDoc.getString("joinDate") == null
                                ? null : tenantDoc.getString("joinDate").substring(0, 7);
                        if (joinMonth == null || joinMonth.isEmpty()) {
                            throw new IllegalArgumentException("Tenant join date is missing.");
                        }
                        JSONObject entry = new JSONObject();
                        entry.put("effectiveMonth", joinMonth);
                        entry.put("amount", tenantDoc.getDouble("rent") == null ? 0 : tenantDoc.getDouble("rent"));
                        history.put(entry);
                    }

                    validateRentHistory(history);
                    JSONObject lastEntry = history.getJSONObject(history.length() - 1);
                    String lastMonth = lastEntry.optString("effectiveMonth", "");
                    BigDecimal lastAmount = decimalAmount(lastEntry.opt("amount"), "rent amount");
                    if (effectiveMonth.equals(lastMonth) && newAmount.compareTo(lastAmount) == 0) {
                        JSONObject result = new JSONObject();
                        result.put("ok", true);
                        result.put("tenantId", tenantId);
                        result.put("newRent", newAmount.doubleValue());
                        result.put("effectiveMonth", effectiveMonth);
                        return result;
                    }
                    if (effectiveMonth.compareTo(lastMonth) <= 0) {
                        throw new IllegalArgumentException("Effective month must be later than the current rent effective month.");
                    }
                    JSONObject updatedEntry = new JSONObject();
                    updatedEntry.put("effectiveMonth", effectiveMonth);
                    updatedEntry.put("amount", newAmount.doubleValue());
                    history.put(updatedEntry);
                    transaction.update(tenantRef, "rentHistory", asFirestoreHistory(history));
                    transaction.update(tenantRef, "rent", newAmount.doubleValue());
                    transaction.update(tenantRef, "updatedAt", timestampNow());
                    JSONObject result = new JSONObject();
                    result.put("ok", true);
                    result.put("tenantId", tenantId);
                    result.put("newRent", newAmount.doubleValue());
                    result.put("effectiveMonth", effectiveMonth);
                    return result;
                } catch (org.json.JSONException | IllegalArgumentException exception) {
                    throw new com.google.firebase.firestore.FirebaseFirestoreException(
                            exception.getMessage() == null ? "Invalid rent change." : exception.getMessage(),
                            com.google.firebase.firestore.FirebaseFirestoreException.Code.INVALID_ARGUMENT);
                }
            }).addOnSuccessListener(result -> callback.onSuccess(result)).addOnFailureListener(error -> {
                callback.onError(errorMessage(error));
            });
        } catch (JSONException | IllegalArgumentException exception) {
            callback.onError(exception.getMessage() == null ? "Please check the entered information." : exception.getMessage());
        }
    }

    static JSONArray calculateUnpaid(JSONArray tenants, JSONArray payments) throws JSONException {
        Map<String, BigDecimal> paidByTenantMonth = aggregatePaymentsByMonth(payments);
        YearMonth currentMonth = YearMonth.now();
        JSONArray unpaid = new JSONArray();
        for (int index = 0; index < tenants.length(); index++) {
            JSONObject tenant = tenants.getJSONObject(index);
            if (!"active".equals(tenant.optString("status").toLowerCase(Locale.ROOT))) {
                continue;
            }
            YearMonth joinMonth;
            YearMonth firstMonth;
            try {
                joinMonth = YearMonth.parse(tenant.optString("joinDate", "").substring(0, 7));
                String billingStartDate = tenant.optString("billingStartDate", "").trim();
                firstMonth = billingStartDate.isEmpty()
                        ? joinMonth : YearMonth.parse(billingStartDate);
            } catch (RuntimeException exception) {
                continue;
            }
            if (firstMonth.isBefore(joinMonth)) {
                firstMonth = joinMonth;
            }
            if (firstMonth.isAfter(currentMonth)) {
                continue;
            }
            NavigableMap<YearMonth, BigDecimal> rentByMonth = buildRentByMonth(tenant, joinMonth);
            BigDecimal outstanding = BigDecimal.ZERO;
            int monthsDue = 0;
            for (YearMonth month = firstMonth; !month.isAfter(currentMonth); month = month.plusMonths(1)) {
                BigDecimal paid = paidByTenantMonth.getOrDefault(
                        tenant.optString("id") + "|" + month.toString(), BigDecimal.ZERO);
                BigDecimal rent = rentForMonth(rentByMonth, month);
                BigDecimal due = rent.subtract(paid).max(BigDecimal.ZERO);
                if (due.signum() > 0) {
                    outstanding = outstanding.add(due);
                    monthsDue++;
                }
            }
            if (outstanding.signum() > 0) {
                JSONObject item = new JSONObject();
                item.put("id", tenant.optString("id"));
                item.put("name", tenant.optString("name"));
                item.put("room", tenant.optString("room"));
                item.put("amountDue", outstanding.setScale(2, RoundingMode.HALF_UP).doubleValue());
                item.put("monthsDue", monthsDue);
                unpaid.put(item);
            }
        }
        return unpaid;
    }

    static NavigableMap<YearMonth, BigDecimal> buildRentByMonth(JSONObject tenant, YearMonth joinMonth) throws JSONException {
        JSONArray history = tenant.optJSONArray("rentHistory");
        NavigableMap<YearMonth, BigDecimal> rentByMonth = new TreeMap<>();
        if (history == null || history.length() == 0) {
            rentByMonth.put(joinMonth, decimalAmount(tenant.opt("rent"), "monthly rent"));
            return rentByMonth;
        }
        validateRentHistory(history);
        for (int index = 0; index < history.length(); index++) {
            JSONObject entry = history.getJSONObject(index);
            YearMonth effectiveMonth = YearMonth.parse(entry.optString("effectiveMonth", ""));
            if (index == 0 && !effectiveMonth.equals(joinMonth)) {
                throw new IllegalArgumentException("The first rentHistory entry must match the tenant join month.");
            }
            rentByMonth.put(effectiveMonth, decimalAmount(entry.opt("amount"), "rent amount"));
        }
        return rentByMonth;
    }

    static Map<String, BigDecimal> aggregatePaymentsByMonth(JSONArray payments) throws JSONException {
        Map<String, BigDecimal> paidByTenantMonth = new HashMap<>();
        for (int index = 0; index < payments.length(); index++) {
            JSONObject payment = payments.getJSONObject(index);
            String key = payment.optString("tenantId") + "|" + payment.optString("month");
            paidByTenantMonth.put(key, paidByTenantMonth.getOrDefault(key, BigDecimal.ZERO)
                    .add(decimalAmount(payment.opt("amount"), "payment amount")));
        }
        return paidByTenantMonth;
    }

    static void validateRentHistory(JSONArray history) throws JSONException {
        if (history == null || history.length() == 0) {
            return;
        }
        YearMonth previous = null;
        for (int index = 0; index < history.length(); index++) {
            JSONObject entry = history.getJSONObject(index);
            if (!entry.has("effectiveMonth") || !entry.has("amount")) {
                throw new IllegalArgumentException("Each rentHistory entry must include effectiveMonth and amount.");
            }
            String effectiveMonth = entry.optString("effectiveMonth", "").trim();
            if (!MONTH_PATTERN.matcher(effectiveMonth).matches()) {
                throw new IllegalArgumentException("Effective month must use YYYY-MM format.");
            }
            YearMonth month = YearMonth.parse(effectiveMonth);
            if (previous != null && !month.isAfter(previous)) {
                throw new IllegalArgumentException("Rent history must be in ascending month order.");
            }
            BigDecimal amount = decimalAmount(entry.opt("amount"), "rent amount");
            if (amount.signum() <= 0) {
                throw new IllegalArgumentException("Rent entry amount must be greater than zero.");
            }
            previous = month;
        }
    }

    private static BigDecimal rentForMonth(NavigableMap<YearMonth, BigDecimal> rentByMonth, YearMonth month) {
        Map.Entry<YearMonth, BigDecimal> entry = rentByMonth.floorEntry(month);
        return entry == null ? BigDecimal.ZERO : entry.getValue();
    }

    private static List<Map<String, Object>> asFirestoreHistory(JSONArray history) throws JSONException {
        List<Map<String, Object>> normalized = new ArrayList<>();
        for (int index = 0; index < history.length(); index++) {
            JSONObject entry = history.getJSONObject(index);
            Map<String, Object> normalizedEntry = new HashMap<>();
            normalizedEntry.put("effectiveMonth", entry.optString("effectiveMonth", ""));
            normalizedEntry.put("amount", decimalAmount(entry.opt("amount"), "rent amount").doubleValue());
            normalized.add(normalizedEntry);
        }
        return normalized;
    }

    private static BigDecimal positiveAmount(String value, String label) {
        try {
            BigDecimal amount = new BigDecimal(value.trim());
            if (amount.signum() <= 0 || amount.scale() > 2) {
                throw new NumberFormatException();
            }
            return amount.setScale(2, RoundingMode.HALF_UP);
        } catch (RuntimeException exception) {
            throw new IllegalArgumentException(label + " must be a positive number with at most 2 decimal places.");
        }
    }

    private static double total(JSONArray rows, String field) throws JSONException {
        BigDecimal sum = BigDecimal.ZERO;
        for (int index = 0; index < rows.length(); index++) {
            sum = sum.add(decimalAmount(rows.getJSONObject(index).opt(field), field));
        }
        return sum.setScale(2, RoundingMode.HALF_UP).doubleValue();
    }

    private static BigDecimal decimalAmount(Object value, String label) {
        try {
            BigDecimal amount = new BigDecimal(String.valueOf(value));
            if (amount.signum() < 0 || amount.scale() > 2) throw new NumberFormatException();
            return amount;
        } catch (RuntimeException exception) {
            throw new IllegalArgumentException("Invalid " + label + " in saved hostel data.");
        }

        private static String timestampNow() {
            return ISO_MILLIS_UTC.format(Instant.now());
        }
    }

    private static double nonNegativeAmount(Object value, String label) {
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (!Double.isNaN(number) && !Double.isInfinite(number) && number >= 0) {
                return number;
            }
        } else if (value != null) {
            try {
                double number = Double.parseDouble(String.valueOf(value));
                if (!Double.isNaN(number) && !Double.isInfinite(number) && number >= 0) {
                    return number;
                }
            } catch (NumberFormatException ignored) {
                // Invalid imported data is surfaced by the caller.
            }
        }
        throw new IllegalArgumentException("Invalid " + label + " in Firebase.");
    }

    private static String errorMessage(Exception error) {
        return ErrorMessages.forFirebase(error);
    }
}