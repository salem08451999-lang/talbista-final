# Talbista auth outcomes

- [x] **Phone/password registration and login:** `POST /api/auth/register` accepts `{phone, password}`, stores a unique phone number and a PBKDF2-HMAC-SHA256 password hash using a random 16-byte salt and 100,000 iterations as `salt:hash` in the existing `User` model, and does not add profession, city, or other required fields. `POST /api/auth/login` accepts `{phone, password}`, verifies the password, and returns `{ok:true,user,token}` without returning the password hash.
- [x] **Persistent signed-in state:** The frontend has phone and password inputs only. After successful authentication it saves the user profile and token in `localStorage`; when reopened it validates the stored token and restores the session without asking for phone/password again while the token remains valid.
- [x] **Existing API test endpoint:** `GET /api/test` continues to return `{ok:true}`.
- [ ] **D1 production wiring:** A dedicated Cloudflare D1 database is bound to the existing `talbista-final` Worker, and the Prisma `User` model/migration matches the requested fields.
