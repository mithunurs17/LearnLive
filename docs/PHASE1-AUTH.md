# Phase 1 — Authentication, roles, permissions & database validation

## Implemented
- Public self-registration creates student-only accounts; submitted role fields are ignored.
- Email normalized (trim/lowercase), format and length validation; unique MongoDB index handles races.
- Password length 12–128, uppercase + lowercase + numeric character; bcrypt cost 12.
- Login uses generic credential failure; login/register throttled at 12 attempts per 15 minutes.
- JWT expiry 8 hours with issuer/audience and subject; role is not embedded in token.
- Auth middleware reloads user state/role from MongoDB per request. Disabled accounts and invalidated sessions are rejected.
- Logout increments tokenVersion to revoke current user's tokens.
- `/api/auth/me` returns safe signed-in profile.
- Administrator can paginate/filter users and assign roles or disable accounts.
- Role changes/disabling revoke active tokens. Admin cannot disable or demote own account.
- One-time initial admin provisioning endpoint guarded by `BOOTSTRAP_ADMIN_KEY`, refuses after an admin exists.
- User schema validation, normalized unique email index, password hash excluded by default, enum constraints.
- Enrollment uniqueness index prevents duplicate enrollment records.

## Bootstrap first administrator
1. Put a high-entropy secret in `server/.env` as `BOOTSTRAP_ADMIN_KEY=<random secret>`; set `JWT_SECRET` to a strong 32+ character secret.
2. Start API and submit once:
```bash
curl -X POST http://localhost:4000/api/auth/bootstrap-admin \
  -H "Content-Type: application/json" \
  -d '{"bootstrapKey":"REPLACE","name":"Platform Admin","email":"admin@example.com","password":"ChangeThisStrongPassword123"}'
```
3. Save returned token securely.
4. Immediately remove `BOOTSTRAP_ADMIN_KEY` from `.env` and restart API. Bootstrap endpoint then becomes unavailable.
5. Never commit `.env`.

## Admin operations
- `GET /api/auth/admin/users?page=1&limit=25&role=student&status=active`
- `PATCH /api/auth/admin/users/:id` body `{"role":"instructor"}` or `{"status":"disabled"}`
- Valid roles: `student`, `instructor`, `admin`; statuses: `active`, `disabled`.
- Admin only. Mutations revoke sessions for affected user.

## Smoke checks
Run `npm run check` from `server/`; it checks JS syntax, not a substitute for live DB tests.
1. Valid registration => 201, role student.
2. Submitted `role=admin` or `instructor` still results in student.
3. Weak password/invalid email/name => 400.
4. Duplicate case-insensitive email => 409.
5. Incorrect credentials => 401.
6. Student accessing admin user listing => 403.
7. Admin promotes a test account; next requests use updated DB role.
8. Disabled account/revoked token => 401.
9. Logout => prior bearer token returns 401.
10. Bootstrap again after admin created => 409.

## Production hardening follow-ups
Verified email, password reset, privileged-role MFA, audit logging and secure account recovery are still recommended before public production. Use HTTPS, secret storage and strict CORS/proxy configuration. Authorize every protected endpoint.
