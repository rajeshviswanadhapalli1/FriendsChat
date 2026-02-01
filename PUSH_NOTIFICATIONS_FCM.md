# Push Notifications (Firebase Cloud Messaging)

Push notifications are sent when a new message arrives. Setup includes Firebase Console, backend configuration, and client integration.

## 1. Firebase Console Setup

1. Go to [Firebase Console](https://console.firebase.google.com/) and create or select a project.
2. **Add Android app** with package `com.friendschat` (or your `applicationId` from `android/app/build.gradle`).
3. Download `google-services.json` and place in `android/app/`.
4. **Add iOS app** with your bundle identifier.
5. Download `GoogleService-Info.plist` and add to Xcode project (e.g. `ios/ChatApp/`).
6. In **Firebase Console → Project Settings → Cloud Messaging**, enable Cloud Messaging.

**iOS extra steps:**
- In Xcode: **Signing & Capabilities** → Add "Push Notifications" and "Background Modes" (check Remote notifications).
- Upload APNs key or certificate (Firebase Console → Project Settings → Cloud Messaging).

## 2. Backend Configuration

### Service Account

1. In Firebase Console → **Project Settings** → **Service accounts**
2. Click **Generate new private key**
3. Save the JSON file and either:
   - **Option A**: Place it in your project (e.g. `config/serviceAccountKey.json`) and add path to `.env`:
     ```
     FIREBASE_SERVICE_ACCOUNT_PATH=./config/serviceAccountKey.json
     ```
   - **Option B**: Use the JSON content directly in `.env` (escaped or base64 for complex JSON):
     ```
     FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...",...}
     ```

**Important**: Never commit the service account JSON to version control. It is already in `.gitignore`.

### Environment Variables

Add to your `.env`:

```env
# Path to Firebase service account JSON file
FIREBASE_SERVICE_ACCOUNT_PATH=./config/serviceAccountKey.json

# OR: Raw JSON (for serverless/cloud deployments)
# FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

If neither is set, push notifications will be disabled and the server will log a warning at startup.

## 3. Backend API

### Save FCM Token

When the user logs in, the app fetches an FCM token and sends it to the backend.

**`POST /api/auth/fcm-token`**

- **Headers:** `Authorization: Bearer <accessToken>`
- **Body:** `{ "fcmToken": "string" }`
- The token is stored per user and replaced on each update.

**Example request:**
```bash
curl -X POST http://localhost:5000/api/auth/fcm-token \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fcmToken":"dQw4w9WgXcQ:APA91bHun4MxP5ego..."}'
```

### Send Push When Message Arrives

When the server receives a `send-message` socket event and delivers the message to the receiver:

1. It looks up the receiver's FCM token.
2. Sends a push via Firebase Admin SDK.

**Notification payload:**
- **notification.title**: Sender name (or "New message")
- **notification.body**: Message text (or "You have a new message")
- **data**: `chatId`, `senderId`, `senderName`, `receiverId`, `message` (for client navigation)

The push is sent when the receiver has an FCM token stored, regardless of whether they are online via socket. The client handles foreground vs background display.

## 4. Client Flow

1. **After login:** `PushNotificationInitializer` runs, requests permission, gets FCM token, calls `POST /api/auth/fcm-token`.
2. **Foreground:** Messages handled in `onMessage` (no system notification by default; add in-app UI if desired).
3. **Background/quit:** FCM shows a system notification; tap opens the app and navigates to `ChatWindow` using `chatId`, `senderId`, `senderName` from the `data` payload.

## 5. Files Added/Updated

| File | Purpose |
|------|---------|
| `models/User.js` | Added `fcmToken` field |
| `config/firebase.js` | Firebase Admin init and `sendMessageNotification()` |
| `routes/auth.js` | `POST /api/auth/fcm-token` endpoint |
| `socket/socketHandler.js` | Send FCM push on `send-message` after delivering to receiver |
| `package.json` | Added `firebase-admin` dependency |

## 6. Quick Reference

```javascript
// Save FCM token (client, after login)
await fetch('/api/auth/fcm-token', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ fcmToken: deviceFcmToken }),
});
```

**Push data payload (for client navigation):**
```javascript
{
  chatId: string,
  senderId: string,
  senderName: string,
  receiverId: string,
  message: string
}
```
