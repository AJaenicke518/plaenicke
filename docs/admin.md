# Admin notes

## Phase-1 manual checks

**Duplicate-email 409 on real D1.** `accounts.js` maps a sign-up failure to `409 email_taken` by matching `UNIQUE constraint failed: accounts.email` in the error message. The fake D1 (`node:sqlite`) produces that text; real D1's message format is unverified. After the Phase-1 deploy, mint two invites, sign up twice with the same email, and confirm the second call returns 409 (not 500) and that the second invite stays unused:

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$WORKER_URL/auth/signup" \
  -H 'content-type: application/json' \
  -d '{"invite":"<invite>","email":"check@example.com","kdfSalt":"<22 b64url>","kdfIters":600000,"authKey":"<43 b64url>","recAuthKey":"<43 b64url>","wrappedDekPw":"<80 b64>","wrappedDekRec":"<80 b64>","dekCheck":"<64 hex>","deviceName":"check"}'
```
