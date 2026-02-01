/**
 * Firebase Admin SDK for push notifications (FCM)
 * Initialize with service account: FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON
 */

let admin = null;
let isInitialized = false;

function initializeFirebase() {
  if (isInitialized) return admin;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountPath) {
    try {
      const path = require('path');
      const serviceAccount = require(path.resolve(process.cwd(), serviceAccountPath));
      admin = require('firebase-admin');
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      isInitialized = true;
      console.log('Firebase Admin initialized (from file path)');
    } catch (err) {
      console.warn('Firebase: Failed to initialize from path:', err.message);
    }
  } else if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin = require('firebase-admin');
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      isInitialized = true;
      console.log('Firebase Admin initialized (from env JSON)');
    } catch (err) {
      console.warn('Firebase: Failed to initialize from JSON:', err.message);
    }
  } else {
    console.warn('Firebase: No FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON set. Push notifications disabled.');
  }

  return admin;
}

// Lazy init on first use
initializeFirebase();

/**
 * Send push notification when a new message arrives.
 * @param {string} receiverFcmToken - FCM token of the receiver
 * @param {object} payload - { chatId, senderId, senderName, receiverId, message }
 * @returns {Promise<boolean>} - true if sent successfully
 */
async function sendMessageNotification(receiverFcmToken, payload) {
  if (!receiverFcmToken || !admin || !isInitialized) {
    return false;
  }

  try {
    const message = {
      token: receiverFcmToken,
      notification: {
        title: payload.senderName || 'New message',
        body: (payload.message || '').slice(0, 100) || 'You have a new message',
      },
      data: {
        chatId: String(payload.chatId || ''),
        senderId: String(payload.senderId || ''),
        senderName: String(payload.senderName || ''),
        receiverId: String(payload.receiverId || ''),
        message: String(payload.message || ''),
      },
      android: {
        priority: 'high',
      },
      apns: {
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default',
          },
        },
      },
    };

    await admin.messaging().send(message);
    return true;
  } catch (err) {
    // Invalid/expired token - remove from user
    if (err.code === 'messaging/invalid-registration-token' || err.code === 'messaging/registration-token-not-registered') {
      console.warn('FCM token invalid/expired, should be removed from user:', err.code);
    } else {
      console.error('Error sending FCM push:', err.message);
    }
    return false;
  }
}

module.exports = {
  initializeFirebase,
  sendMessageNotification,
  isFirebaseInitialized: () => isInitialized,
};
