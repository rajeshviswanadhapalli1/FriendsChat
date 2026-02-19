# Backend push notifications and calling

This document describes backend behavior for FCM push and WebRTC call signaling so the calling system works correctly.

---

## Call reject

1. When the server receives **call-reject** from the callee, it cancels the 3‑minute ring timer for that `channelId`.
2. It notifies the caller by emitting **call-rejected** with `{ channelId }`.
3. **After handling call-reject, stop all activity for that channelId:** do not send any more call-invite or FCM to the callee for this channelId; mark the channel as ended/rejected so the call does not ring again.

**Example handler (conceptual):**

- Cancel the ring timer for `channelId`.
- **Mark the call as ended for that channelId** (e.g. `pendingCalls.delete(channelId)` or add `channelId` to an `endedOrRejectedChannels` set) so you never send another call-invite or FCM for that channelId.
- Emit **call-rejected** to the caller with `{ channelId }`.
- Emit **call-ended** to the callee (the socket that sent `call-reject`) with `{ channelId }` so **both users end the call at the same time** and both UIs can close.

---

## Call-invite relay

When the server receives **call-invite** from the caller:

- Relay to the callee **once per channelId** and include the **full payload with the offer**.
- The payload must include the **offer (SDP)** so the callee can answer; without it the app shows “No call offer” when they tap Accept.
- The server stores the offer for the call so the callee can request it later (e.g. when opening from FCM before the socket received the invite) via **call-request-offer** → **call-offer**.

---

## Backend checklist

### call-invite

- [ ] Relay to callee **once per channelId** and include the full payload, **including offer** (type + sdp).
- [ ] Send FCM to callee **once per channelId**.
- [ ] If `channelId` is in an “ended/rejected” set, do **not** relay or send FCM; emit **call-ended** to caller and return.

### call-reject

- [ ] Cancel the 3‑minute ring timer for that `channelId`.
- [ ] **Mark the call as ended** for that `channelId` (e.g. remove from a “pending calls” set or add to “ended/rejected” set) so you never send another call-invite or FCM for that `channelId`.
- [ ] Emit **call-rejected** to the caller with `{ channelId }`.

### call-ended / timeout

- [ ] Emit **call-ended** to **both sides** when the call ends or times out (so both users end the call at the same time). When either party sends **call-end**, emit **call-ended** to the other peer and also to the sender.
- [ ] Optionally send missed-call FCM as already documented.
- [ ] Mark the channel as ended so no further invite/FCM is sent for that `channelId`.

---

## Callee “No call offer”

If the callee opens the app from an FCM push and connects to the socket **after** the invite was already sent, they may never receive the **call-invite** event with the offer. The backend supports:

- **call-request-offer**: callee sends `{ channelId }`. If the call exists and the socket user is the callee, the server responds with **call-offer** `{ channelId, offer }`. The client should then `setRemoteDescription(offer)`, create an answer, and send **call-accept**.

---

## Caller UI (frontend)

For **video** calls, the caller should show **local video** (preview) until the callee answers. This is a frontend responsibility; the backend does not control media or UI.
