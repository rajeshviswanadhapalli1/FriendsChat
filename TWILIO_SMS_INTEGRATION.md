# Twilio OTP SMS Integration

The backend now sends OTP via **Twilio Verify API** (SMS).

---

## 1. Twilio credentials (in `.env`)

```env
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_VERIFY_SERVICE_SID=your_twilio_verify_service_sid
```

Get these from [Twilio Console](https://console.twilio.com/) → **Verify** → **Services**.

---

## 2. How it works

### Send OTP (POST `/api/auth/send-otp`)

1. User enters mobile number (10 digits).
2. Backend calls **Twilio Verify API** → Twilio sends OTP via SMS to `+91{mobileNumber}` (change country code in `config/twilio.js` if needed).
3. OTP expires after 10 minutes (managed by Twilio).

**Request:**
```json
{
  "mobileNumber": "1234567890"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully via SMS"
}
```

### Verify OTP (POST `/api/auth/verify-otp`)

1. User enters OTP.
2. Backend calls **Twilio Verify API** to check OTP.
3. If valid, creates/finds user and returns access + refresh tokens.

**Request:**
```json
{
  "mobileNumber": "1234567890",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { ... },
    "accessToken": "...",
    "refreshToken": "..."
  }
}
```

---

## 3. Country code

Default is `+91` (India). Change in `config/twilio.js`:

```javascript
to: `+91${mobileNumber}` // Change +91 to your country code
```

For international: store country code with user or pass in request.

---

## 4. Twilio Verify vs Custom SMS

### Twilio Verify API (current)
- ✅ Automatic OTP generation, sending, and expiration (10 min).
- ✅ Rate limiting and fraud detection built-in.
- ✅ No need to store OTP in database.
- ❌ OTP format is Twilio-managed (6 digits).

### Custom SMS (alternative)
If you prefer to manage OTP yourself (use `OTP` model), switch to `sendCustomOTPSMS`:

```javascript
// In routes/auth.js, replace sendOTPViaSMS with:
const otp = generateOTP();
await sendCustomOTPSMS(mobileNumber, otp);
await OTP.create({ mobileNumber, otp, expiresAt: ... });
```

---

## 5. Files changed

- **`config/twilio.js`** – Twilio Verify API: `sendOTPViaSMS`, `verifyOTPViaSMS`.
- **`routes/auth.js`** – `/send-otp` and `/verify-otp` now use Twilio.
- **`package.json`** – Added `twilio` dependency.
- **`README.md`** – Twilio env vars.

---

## 6. Testing

1. Add Twilio credentials to `.env`:
   ```env
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   TWILIO_VERIFY_SERVICE_SID=your_twilio_verify_service_sid
   ```

2. Install Twilio package:
   ```bash
   npm install twilio
   ```

3. Restart the server:
   ```bash
   npm run dev
   ```

4. Send OTP:
   ```bash
   curl -X POST http://localhost:3000/api/auth/send-otp \
     -H "Content-Type: application/json" \
     -d '{"mobileNumber": "1234567890"}'
   ```

5. Check your phone for SMS with OTP.

6. Verify OTP:
   ```bash
   curl -X POST http://localhost:3000/api/auth/verify-otp \
     -H "Content-Type: application/json" \
     -d '{"mobileNumber": "1234567890", "otp": "123456"}'
   ```

---

## 7. Important notes

- **OTP expiry**: Managed by Twilio (10 minutes by default).
- **Rate limiting**: Twilio has built-in rate limits. For abuse prevention, consider additional backend rate limiting.
- **Country code**: Default is `+91` (India). Change in `config/twilio.js` as needed.
- **Verify Service**: Each Twilio Verify Service has a unique SID. Create one in Twilio Console → Verify.

---

## 8. Cost

Twilio Verify API charges per verification. Check [Twilio Pricing](https://www.twilio.com/verify/pricing) for SMS rates.
