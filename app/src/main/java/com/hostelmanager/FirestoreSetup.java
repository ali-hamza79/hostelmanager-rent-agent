package com.hostelmanager;

import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.FirebaseFirestoreSettings;

/** Configures Firestore persistence before any reads or writes are started. */
final class FirestoreSetup {
    private static boolean configured;

    private FirestoreSetup() { }

    static synchronized FirebaseFirestore configure() {
        FirebaseFirestore firestore = FirebaseFirestore.getInstance();
        if (!configured) {
            FirebaseFirestoreSettings settings = new FirebaseFirestoreSettings.Builder()
                    .setPersistenceEnabled(true)
                    .setCacheSizeBytes(FirebaseFirestoreSettings.CACHE_SIZE_UNLIMITED)
                    .build();
            firestore.setFirestoreSettings(settings);
            configured = true;
        }
        return firestore;
    }
}
