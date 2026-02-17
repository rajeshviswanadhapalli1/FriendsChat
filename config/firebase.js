/**
 * Firebase Admin SDK for push notifications (FCM)
 * Initialize with service account: FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON
 */

const path = require('path');
const fs = require('fs');

let admin = null;
let isInitialized = false;

function initializeFirebase() {
  if (isInitialized && admin) return admin;

  // Avoid duplicate app (e.g. if module reloaded or already initialized elsewhere)
  const firebaseAdmin = require('firebase-admin');
  if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
    admin = firebaseAdmin;
    isInitialized = true;
    return admin;
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountPath) {
    try {
      const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const serviceAccount = JSON.parse(fileContent);
      admin = firebaseAdmin;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      isInitialized = true;
      console.log('Firebase Admin initialized (from file path)');
    } catch (err) {
      console.warn('Firebase: Failed to initialize from path:', err.message);
    }
  } else if (serviceAccountJson) {
    try {
      const serviceAccount = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
      admin = firebaseAdmin;
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
  // Ensure Firebase is initialized (in case env was not loaded when module first loaded)
  initializeFirebase();

  if (!receiverFcmToken || typeof receiverFcmToken !== 'string' || !receiverFcmToken.trim()) {
    return false;
  }

  if (!admin || !isInitialized) {
    console.warn('FCM: Firebase not initialized, skipping push notification');
    return false;
  }

  try {
    const androidChannelId = process.env.FCM_ANDROID_CHANNEL_ID || 'chat_messages';

    // FCM data payload values must be strings
    const dataPayload = {
      chatId: String(payload.chatId ?? ''),
      senderId: String(payload.senderId ?? ''),
      senderName: String(payload.senderName ?? ''),
      receiverId: String(payload.receiverId ?? ''),
      message: String(payload.message ?? ''),
    };

    const fcmMessage = {
      token: receiverFcmToken.trim(),
      notification: {
        title: (payload.senderName && String(payload.senderName).slice(0, 50)) || 'New message',
        body: (payload.message && String(payload.message).slice(0, 100)) || 'You have a new message',
      },
      data: dataPayload,
      android: {
        priority: 'high',
        notification: {
          channelId: androidChannelId,
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default',
          },
        },
        fcmOptions: {},
      },
    };

    const messageId = await admin.messaging().send(fcmMessage);
    console.log('FCM: Push notification sent successfully:', messageId);
    return true;
  } catch (err) {
    if (err.code === 'messaging/invalid-registration-token' || err.code === 'messaging/registration-token-not-registered') {
      console.warn('FCM: Token invalid/expired:', err.code);
    } else {
      console.error('FCM: Error sending push:', err.code || err.message, err.message);
    }
    return false;
  }
}

/**
 * Send push notification for incoming call (call offer).
 * App can use data.type === 'call' to show incoming-call UI or open call screen.
 *
 * @param {string} calleeFcmToken - FCM token of the callee (receiver of the call)
 * @param {object} payload - { channelId, callerId, callerName, calleeId, callType }
 * @returns {Promise<boolean>}
 */
async function sendCallOfferNotification(calleeFcmToken, payload) {
  initializeFirebase();

  if (!calleeFcmToken || typeof calleeFcmToken !== 'string' || !calleeFcmToken.trim()) {
    return false;
  }

  if (!admin || !isInitialized) {
    return false;
  }

  const androidChannelId = process.env.FCM_ANDROID_CHANNEL_ID_CALLS || 'incoming_calls';

  try {
    const callType = payload.callType === 'video' ? 'Video' : 'Audio';
    const dataPayload = {
      type: 'call',
      channelId: String(payload.channelId ?? ''),
      callerId: String(payload.callerId ?? ''),
      callerName: String(payload.callerName ?? ''),
      calleeId: String(payload.calleeId ?? ''),
      callType: String(payload.callType ?? 'audio'),
    };

    const fcmMessage = {
      token: calleeFcmToken.trim(),
      notification: {
        title: 'Incoming call',
        body: `${payload.callerName || 'Someone'} is calling you (${callType})`,
      },
      data: dataPayload,
      android: {
        priority: 'high',
        notification: {
          channelId: androidChannelId,
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            contentAvailable: true,
          },
        },
      },
    };

    await admin.messaging().send(fcmMessage);
    return true;
  } catch (err) {
    if (err.code === 'messaging/invalid-registration-token' || err.code === 'messaging/registration-token-not-registered') {
      console.warn('FCM call offer: Token invalid/expired:', err.code);
    } else {
      console.error('FCM call offer error:', err.message);
    }
    return false;
  }
}

module.exports = {
  initializeFirebase,
  sendMessageNotification,
  sendCallOfferNotification,
  isFirebaseInitialized: () => isInitialized,
};
