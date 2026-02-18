/**
 * Firebase Admin SDK for push notifications (FCM)
 * Initialize with service account: FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON
 */

const path = require('path');
const fs = require('fs');

let admin = null;
let isInitialized = false;
let initializationAttempted = false;

function initializeFirebase() {
  // If already initialized and working, return it
  if (isInitialized && admin) {
    try {
      const firebaseAdmin = require('firebase-admin');
      if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) return admin;
    } catch (err) {
      isInitialized = false;
      admin = null;
    }
  }

  const firebaseAdmin = require('firebase-admin');
  if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
    admin = firebaseAdmin;
    isInitialized = true;
    return admin;
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  let serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!initializationAttempted) {
    console.log('Firebase: Initialization attempt...');
    console.log('Firebase: FIREBASE_SERVICE_ACCOUNT_PATH:', serviceAccountPath ? 'SET' : 'NOT SET');
    console.log('Firebase: FIREBASE_SERVICE_ACCOUNT_JSON:', serviceAccountJson ? `SET (length: ${String(serviceAccountJson).length})` : 'NOT SET');
    initializationAttempted = true;
  }

  // Priority: JSON first (production/cloud), then file path (local)
  if (serviceAccountJson) {
    try {
      if (typeof serviceAccountJson === 'string') {
        serviceAccountJson = serviceAccountJson.trim();
        if ((serviceAccountJson.startsWith('"') && serviceAccountJson.endsWith('"')) ||
            (serviceAccountJson.startsWith("'") && serviceAccountJson.endsWith("'"))) {
          serviceAccountJson = serviceAccountJson.slice(1, -1);
        }
        const base64Pattern = /^[A-Za-z0-9+/=]+$/;
        if (base64Pattern.test(serviceAccountJson) && serviceAccountJson.length > 100) {
          try {
            serviceAccountJson = Buffer.from(serviceAccountJson, 'base64').toString('utf8');
          } catch (base64Err) {}
        }
      }
      const serviceAccount = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
      if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
        console.error('Firebase: Service account JSON missing required fields (project_id, private_key, client_email)');
        return null;
      }
      admin = firebaseAdmin;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      isInitialized = true;
      console.log('Firebase Admin initialized (from env JSON), project:', serviceAccount.project_id);
      return admin;
    } catch (err) {
      console.error('Firebase: Failed to initialize from JSON:', err.message);
      if (err.message && err.message.includes('JSON')) {
        console.error('Firebase: Check FIREBASE_SERVICE_ACCOUNT_JSON is valid JSON or base64.');
      }
      return null;
    }
  }

  if (serviceAccountPath) {
    try {
      const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
      if (!fs.existsSync(resolvedPath)) {
        console.warn('Firebase: Service account file not found at:', resolvedPath);
        return null;
      }
      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const serviceAccount = JSON.parse(fileContent);
      if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
        console.error('Firebase: Service account file missing required fields (project_id, private_key, client_email)');
        return null;
      }
      admin = firebaseAdmin;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      isInitialized = true;
      console.log('Firebase Admin initialized (from file), project:', serviceAccount.project_id);
      return admin;
    } catch (err) {
      console.error('Firebase: Failed to initialize from path:', err.message);
      return null;
    }
  }

  console.warn('Firebase: No FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON set. Push notifications disabled.');
  return null;
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
  const firebaseAdmin = initializeFirebase();

  if (!receiverFcmToken || typeof receiverFcmToken !== 'string' || !receiverFcmToken.trim()) {
    return false;
  }

  if (!firebaseAdmin || !isInitialized) {
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

    const messageId = await firebaseAdmin.messaging().send(fcmMessage);
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
  const firebaseAdmin = initializeFirebase();

  if (!calleeFcmToken || typeof calleeFcmToken !== 'string' || !calleeFcmToken.trim()) {
    return false;
  }

  if (!firebaseAdmin || !isInitialized) {
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
      callerPhone: String(payload.callerPhone ?? ''),
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

    await firebaseAdmin.messaging().send(fcmMessage);
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

/**
 * Send push for missed call (after 3-minute ring timeout with no answer).
 * App uses data.type === 'missed_call' to show "Missed call from …".
 *
 * @param {string} calleeFcmToken - FCM token of the callee
 * @param {object} payload - { channelId, callerId, callerName, callType, callerPhone }
 * @returns {Promise<boolean>}
 */
async function sendMissedCallNotification(calleeFcmToken, payload) {
  const firebaseAdmin = initializeFirebase();

  if (!calleeFcmToken || typeof calleeFcmToken !== 'string' || !calleeFcmToken.trim()) {
    return false;
  }

  if (!firebaseAdmin || !isInitialized) {
    return false;
  }

  const androidChannelId = process.env.FCM_ANDROID_CHANNEL_ID_CALLS || 'incoming_calls';

  try {
    const dataPayload = {
      type: 'missed_call',
      channelId: String(payload.channelId ?? ''),
      callerId: String(payload.callerId ?? ''),
      callerName: String(payload.callerName ?? ''),
      callType: String(payload.callType ?? 'audio'),
      callerPhone: String(payload.callerPhone ?? ''),
    };

    const fcmMessage = {
      token: calleeFcmToken.trim(),
      notification: {
        title: 'Missed call',
        body: `${payload.callerName || 'Someone'} called you`,
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

    await firebaseAdmin.messaging().send(fcmMessage);
    console.log('Missed call push sent');
    return true;
  } catch (err) {
    if (err.code === 'messaging/invalid-registration-token' || err.code === 'messaging/registration-token-not-registered') {
      console.warn('FCM missed call: Token invalid/expired:', err.code);
    } else {
      console.error('FCM missed call error:', err.message);
    }
    return false;
  }
}

module.exports = {
  initializeFirebase,
  sendMessageNotification,
  sendCallOfferNotification,
  sendMissedCallNotification,
  isFirebaseInitialized: () => isInitialized,
};
