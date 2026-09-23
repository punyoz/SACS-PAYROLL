'use client';
import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

const S = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0D1B2A',
    fontFamily: 'DM Sans, system-ui, sans-serif',
    padding: '24px',
  },
  card: {
    background: '#142232',
    border: '1px solid #1E3448',
    borderRadius: '16px',
    padding: '32px',
    width: '100%',
    maxWidth: '400px',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginBottom: '24px',
  },
  brandIcon: {
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    background: '#F5A623',
    color: '#0D1B2A',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: '700',
    fontSize: '16px',
    flexShrink: 0,
  },
  brandName: {
    fontSize: '13px',
    fontWeight: '600',
    color: '#E6EEF8',
    lineHeight: '1.3',
  },
  brandSub: {
    fontSize: '11px',
    color: '#5A7A9A',
  },
  title: {
    fontSize: '20px',
    fontWeight: '700',
    color: '#E6EEF8',
    marginBottom: '6px',
  },
  sub: {
    fontSize: '13px',
    color: '#5A7A9A',
    marginBottom: '24px',
    lineHeight: '1.6',
  },
  fg: { marginBottom: '14px' },
  label: {
    display: 'block',
    fontSize: '11px',
    fontWeight: '600',
    color: '#5A7A9A',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: '6px',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '11px 14px',
    background: '#1A2E44',
    border: '1px solid #1E3448',
    borderRadius: '10px',
    color: '#E6EEF8',
    fontSize: '14px',
    outline: 'none',
  },
  btn: {
    width: '100%',
    padding: '13px',
    background: '#F5A623',
    color: '#0D1B2A',
    border: 'none',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: '700',
    cursor: 'pointer',
    marginTop: '8px',
  },
  btnDisabled: {
    opacity: '0.7',
    cursor: 'not-allowed',
  },
  msgOk: {
    fontSize: '12px',
    marginTop: '12px',
    color: '#3EC97A',
    padding: '10px 12px',
    background: 'rgba(62,201,122,0.1)',
    borderRadius: '8px',
    border: '1px solid rgba(62,201,122,0.3)',
  },
  msgErr: {
    fontSize: '12px',
    marginTop: '12px',
    color: '#E85555',
    padding: '10px 12px',
    background: 'rgba(232,85,85,0.1)',
    borderRadius: '8px',
    border: '1px solid rgba(232,85,85,0.3)',
  },
  rules: {
    listStyle: 'none',
    padding: 0,
    margin: '4px 0 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  ruleItem: {
    fontSize: '12px',
    color: '#5A7A9A',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  ruleItemOk: {
    color: '#3EC97A',
  },
  back: {
    display: 'block',
    textAlign: 'center',
    marginTop: '16px',
    fontSize: '12px',
    color: '#F5A623',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
};

// Same values as src/lib/auth/password-policy.js (server) and the
// PASSWORD_MIN_LENGTH in public/legacy/js/app.js (Settings > Change Password,
// the mandatory first-sign-in screen). Duplicated rather than imported: that
// module pulls in node:crypto, which does not belong in a "use client" bundle.
// Keep these two numbers and the checks below in step with both if either
// changes.
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72;

/**
 * The checks this page can make without server context. "Different from
 * current password" and "not your default password" (both enforced by
 * validateNewPassword() for the logged-in change flow) need a current
 * password or a full_name/date_of_birth this page never has — someone here
 * has only proven access to the account's email inbox, not typed a current
 * password, so those two do not apply.
 */
function evaluateResetPasswordRules(next) {
  return {
    length: next.length >= PASSWORD_MIN_LENGTH && next.length <= PASSWORD_MAX_LENGTH,
    mix: /[A-Za-z]/.test(next) && /\d/.test(next),
    spaces: next.length > 0 && !/\s/.test(next),
    match: next.length > 0,
  };
}

function RuleItem({ ok, children }) {
  return (
    <li style={{ ...S.ruleItem, ...(ok ? S.ruleItemOk : {}) }}>
      <span aria-hidden="true">{ok ? '✓' : '·'}</span>
      {children}
    </li>
  );
}

function Brand() {
  return (
    <div style={S.brand}>
      <div style={S.brandIcon}>S</div>
      <div>
        <div style={S.brandName}>SACS Payroll</div>
        <div style={S.brandSub}>Shepherd Angels Christian School</div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  const [stage, setStage] = useState('loading');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const hash = window.location.hash || '';
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const type = params.get('type');
    const token = params.get('access_token');

    if (type === 'recovery' || token) {
      setStage('form');
    } else {
      setStage('invalid');
    }
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setMessage('');
    setIsError(false);

    const rules = evaluateResetPasswordRules(newPassword);
    if (!rules.length) {
      setMessage(`Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`);
      setIsError(true);
      return;
    }
    if (!rules.spaces) {
      setMessage('Password cannot contain spaces.');
      setIsError(true);
      return;
    }
    if (!rules.mix) {
      setMessage('Password must contain both letters and numbers.');
      setIsError(true);
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage('Passwords do not match.');
      setIsError(true);
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      setStage('success');
      setMessage('Password updated. Redirecting to login...');
      setTimeout(() => { window.location.href = '/login'; }, 2000);
    } catch (err) {
      setMessage(err.message || 'Failed to update password. The link may have expired.');
      setIsError(true);
    } finally {
      setLoading(false);
    }
  }

  if (stage === 'loading') {
    return (
      <div style={S.page}>
        <div style={S.card}>
          <Brand />
          <div style={S.sub}>Verifying reset link...</div>
        </div>
      </div>
    );
  }

  if (stage === 'success') {
    return (
      <div style={S.page}>
        <div style={S.card}>
          <Brand />
          <div style={S.title}>Password Updated</div>
          <div style={S.msgOk}>{message}</div>
          <a href="/login" style={S.back}>Go to Login</a>
        </div>
      </div>
    );
  }

  if (stage === 'invalid') {
    return (
      <div style={S.page}>
        <div style={S.card}>
          <Brand />
          <div style={S.title}>Invalid Reset Link</div>
          <div style={S.sub}>
            This password reset link is invalid or has expired. Please request a new one from the login page.
          </div>
          <a href="/login" style={{ ...S.back, textDecoration: 'none', display: 'block', textAlign: 'center', marginTop: '8px', padding: '13px', background: '#F5A623', color: '#0D1B2A', borderRadius: '10px', fontWeight: '700', fontSize: '14px' }}>
            Back to Login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.card}>
        <Brand />
        <div style={S.title}>Set New Password</div>
        <div style={S.sub}>Enter your new password below.</div>
        <form onSubmit={handleSubmit}>
          <div style={S.fg}>
            <label style={S.label}>New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={`${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters, letters and numbers`}
              style={S.input}
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
            />
          </div>
          <div style={S.fg}>
            <label style={S.label}>Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              style={S.input}
              required
              autoComplete="new-password"
            />
          </div>
          <ul style={S.rules} aria-label="Password requirements">
            <RuleItem ok={evaluateResetPasswordRules(newPassword).length}>
              {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} characters
            </RuleItem>
            <RuleItem ok={evaluateResetPasswordRules(newPassword).mix}>
              Contains both letters and numbers
            </RuleItem>
            <RuleItem ok={evaluateResetPasswordRules(newPassword).spaces}>
              No spaces
            </RuleItem>
            <RuleItem ok={newPassword.length > 0 && newPassword === confirmPassword}>
              New passwords match
            </RuleItem>
          </ul>
          {message && (
            <div style={isError ? S.msgErr : S.msgOk}>{message}</div>
          )}
          <button
            type="submit"
            style={{ ...S.btn, ...(loading ? S.btnDisabled : {}) }}
            disabled={loading}
          >
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
        <a href="/login" style={S.back}>Back to Login</a>
      </div>
    </div>
  );
}
