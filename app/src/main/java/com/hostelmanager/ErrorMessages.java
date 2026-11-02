package com.hostelmanager;

import com.google.firebase.FirebaseNetworkException;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.firestore.FirebaseFirestoreException;

/** Converts infrastructure errors into safe messages for the application UI. */
public final class ErrorMessages {
    private ErrorMessages() {}

    public static String forFirebase(Exception error) {
        if (error instanceof FirebaseNetworkException) {
            return "Network connection unavailable. Check your internet connection and try again.";
        }
        if (error instanceof FirebaseFirestoreException) {
            FirebaseFirestoreException.Code code = ((FirebaseFirestoreException) error).getCode();
            if (code == FirebaseFirestoreException.Code.PERMISSION_DENIED) return "You do not have permission to access this hostel data. Check the signed-in account and Firestore rules.";
            if (code == FirebaseFirestoreException.Code.UNAVAILABLE || code == FirebaseFirestoreException.Code.DEADLINE_EXCEEDED) return "Firebase is temporarily unavailable. Try again shortly.";
            if (code == FirebaseFirestoreException.Code.ALREADY_EXISTS) return "This record has already been saved.";
        }
        if (error instanceof FirebaseAuthException) {
            String errorCode = ((FirebaseAuthException) error).getErrorCode();
            if ("ERROR_OPERATION_NOT_ALLOWED".equals(errorCode)) {
                return "Anonymous sign-in is disabled. In Firebase Console, open Authentication > "
                        + "Sign-in method, add the Anonymous provider, and enable it.";
            }
            return "Authentication failed. Sign in again and retry.";
        }
        return "Something went wrong while contacting Firebase. Please try again.";
    }
}
