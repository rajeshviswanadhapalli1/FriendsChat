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
      // Verify it's still working by checking apps
      const firebaseAdmin = require('firebase-admin');
      if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
        return admin;
      }
    } catch (err) {
      // If check fails, reset and try again
      isInitialized = false;
      admin = null;
    }
  }

  // Avoid duplicate app (e.g. if module reloaded or already initialized elsewhere)
  const firebaseAdmin = require('firebase-admin');
  if (firebaseAdmin.apps && firebaseAdmin.apps.length > 0) {
    admin = firebaseAdmin;
    isInitialized = true;
    console.log('Firebase Admin: Using existing app instance');
    return admin;
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  let serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  // Log initialization attempt
  if (!initializationAttempted) {
    console.log('Firebase: Initialization attempt...');
    console.log('Firebase: FIREBASE_SERVICE_ACCOUNT_PATH:', serviceAccountPath ? 'SET' : 'NOT SET');
    console.log('Firebase: FIREBASE_SERVICE_ACCOUNT_JSON:', serviceAccountJson ? `SET (length: ${serviceAccountJson.length})` : 'NOT SET');
    initializationAttempted = true;
  }

  if (serviceAccountPath) {
    try {
      const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
      if (!fs.existsSync(resolvedPath)) {
        console.error('Firebase: Service account file not found at:', resolvedPath);
        return null;
      }
      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const serviceAccount = JSON.parse(fileContent);
      
      // Validate required fields
      if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
        console.error('Firebase: Service account JSON missing required fields (project_id, private_key, client_email)');
        return null;
      }

      admin = firebaseAdmin;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      isInitialized = true;
      console.log('Firebase Admin initialized successfully (from file path)');
      console.log('Firebase: Project ID:', serviceAccount.project_id);
      return admin;
    } catch (err) {
      console.error('Firebase: Failed to initialize from path:', err.message);
      console.error('Firebase: Error details:', err.stack);
      return null;
    }
  } else if (serviceAccountJson) {
    try {
      // Try to decode base64 if it looks like base64
      if (typeof serviceAccountJson === 'string') {
        // Check if it's base64 encoded
        const base64Pattern = /^[A-Za-z0-9+/=]+$/;
        if (base64Pattern.test(serviceAccountJson) && serviceAccountJson.length > 100) {
          try {
            const decoded = Buffer.from(serviceAccountJson, 'base64').toString('utf8');
            serviceAccountJson = decoded;
            console.log('Firebase: Decoded base64 encoded service account JSON');
          } catch (base64Err) {
            // Not base64, continue with original string
            console.log('Firebase: Service account JSON is not base64, parsing as JSON string');
          }
        }
      }

      // Parse JSON
      const serviceAccount = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
      
      // Validate required fields
      if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
        console.error('Firebase: Service account JSON missing required fields (project_id, private_key, client_email)');
        console.error('Firebase: Available fields:', Object.keys(serviceAccount));
        return null;
      }

      admin = firebaseAdmin;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      isInitialized = true;
      console.log('Firebase Admin initialized successfully (from env JSON)');
      console.log('Firebase: Project ID:', serviceAccount.project_id);
      return admin;
    } catch (err) {
      console.error('Firebase: Failed to initialize from JSON:', err.message);
      console.error('Firebase: Error details:', err.stack);
      if (err.message.includes('JSON')) {
        console.error('Firebase: JSON parsing failed. Check if FIREBASE_SERVICE_ACCOUNT_JSON is valid JSON or base64 encoded JSON.');
      }
      return null;
    }
  } else {
    if (!initializationAttempted) {
      console.warn('Firebase: No FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON set. Push notifications disabled.');
    }
    return null;
  }
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
  const firebaseAdmin = initializeFirebase();

  if (!receiverFcmToken || typeof receiverFcmToken !== 'string' || !receiverFcmToken.trim()) {
    console.warn('FCM: Invalid receiver FCM token');
    return false;
  }

  if (!firebaseAdmin || !isInitialized) {
    console.error('FCM: Firebase not initialized, skipping push notification');
    console.error('FCM: Check Firebase configuration in environment variables');
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
    console.log('FCM: Sent to token:', receiverFcmToken.substring(0, 20) + '...');
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
    console.warn('FCM call offer: Invalid callee FCM token');
    return false;
  }

  if (!firebaseAdmin || !isInitialized) {
    console.error('FCM call offer: Firebase not initialized, skipping push notification');
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

    const messageId = await firebaseAdmin.messaging().send(fcmMessage);
    console.log('FCM call offer: Push notification sent successfully:', messageId);
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
